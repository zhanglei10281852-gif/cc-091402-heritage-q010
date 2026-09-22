import { createServer } from "node:http";
import { loadConfig } from "./booking/config.js";
import { JsonStore } from "./booking/store.js";
import { Catalog } from "./booking/catalog.js";
import { NotificationService, defaultDeliverer } from "./booking/notifications.js";
import { BookingService } from "./booking/service.js";
import { Scheduler } from "./booking/scheduler.js";
import { Router } from "./booking/router.js";
import { registerRoutes, mapError } from "./booking/http.js";

export function createApp(options = {}) {
  const config = options.config ?? loadConfig(options);
  const logger = options.logger ?? console;
  const clock = options.clock ?? (() => new Date());
  const dataFile =
    options.dataFile ??
    process.env.DATA_FILE ??
    (process.env.NODE_ENV === "test" ? ":memory:" : "data/booking-state.json");

  const store = new JsonStore(dataFile, logger);
  store.load();

  const notifications = new NotificationService({
    templates: config.templates,
    store,
    deliverer: options.deliverer ?? defaultDeliverer(logger),
    clock,
    logger,
  });
  const catalog = new Catalog(config);
  const service = new BookingService({ config, store, notifications, catalog, clock, logger });

  const scheduler = new Scheduler({
    store,
    clock,
    handlers: {
      hold_expire: (code) => service.expireHold(code),
      waitlist_expire: (code) => service.expireWaitlist(code),
      outage_restore: (id) => service.restoreOutage(id),
    },
  });
  // 任意变更落盘后让调度器重算最近到期任务（新入队的暂留/候补任务立即生效）
  store.afterPersist = () => scheduler.sync();

  const router = new Router();
  registerRoutes({
    router,
    service,
    catalog,
    store,
    config,
    keys: {
      staff: options.staffKey ?? process.env.STAFF_API_KEY,
      admin: options.adminKey ?? process.env.ADMIN_API_KEY,
    },
  });

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ status: "ok", service: "heritage-service-starter" }));
        return;
      }
      const handled = await router.handle(request, response);
      if (!handled) {
        response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "not_found" }));
      }
    } catch (err) {
      const mapped = mapError(err);
      if (mapped.status >= 500) logger.error?.(err);
      if (!response.headersSent) {
        response.writeHead(mapped.status, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(mapped.body));
      } else {
        response.destroy();
      }
    }
  });

  // 保持 createApp() 返回 http server 的原始约定，同时暴露组件供测试与入口使用
  Object.assign(server, {
    service,
    notifications,
    scheduler,
    store,
    config,
    async start() {
      // 重启补偿：先重投未完成通知，再按原截止时间补跑到期任务，最后恢复定时器
      // （补跑期间产生的新到期项由随后启动的定时器接管）
      await notifications.retryPending();
      await service.runDueNow();
      scheduler.start();
    },
    stop() {
      scheduler.stop();
    },
  });
  return server;
}
