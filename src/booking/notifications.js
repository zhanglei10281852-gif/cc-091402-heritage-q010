import { randomId, parseIso, toIso } from "./util.js";

/** 用户可见时间统一为带 +08:00 的 ISO 8601 */
function localizeTimeValue(value) {
  if (typeof value !== "string") return value;
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*Z$/.test(value);
  if (!match) return value;
  const parsed = parseIso(value);
  return Number.isNaN(parsed.getTime()) ? value : toIso(parsed);
}

/**
 * 通知中心：模板渲染 + 幂等 outbox + 可注入投递器。
 * 幂等键 = 业务事件标识（如 cancel:<code>、promote:<code>:<attempt>），
 * 重复提交永远只产生一条记录、一次实际投递。
 */
export class NotificationService {
  constructor({ templates, store, deliverer, clock = () => new Date(), logger = console }) {
    this.templates = templates;
    this.store = store;
    this.deliverer = deliverer ?? defaultDeliverer(logger);
    this.clock = clock;
    this.logger = logger;
  }

  render(templateName, vars) {
    const tpl = this.templates[templateName];
    if (!tpl) throw new Error(`未知通知模板: ${templateName}`);
    const body = tpl.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
      if (vars[key] === undefined) return "";
      const v = vars[key];
      return key.endsWith("At") ? String(localizeTimeValue(v)) : String(v);
    });
    return { channel: tpl.channel, title: tpl.title, body };
  }

  /** 幂等发送。返回 { created, record } */
  async send(idempotencyKey, { template, vars, to, refCode, category }) {
    return this.store.mutate((state) => {
      const existing = state.notifications[idempotencyKey];
      if (existing) return { created: false, record: existing };
      const rendered = this.render(template, vars);
      const record = {
        id: randomId("ntf_"),
        idempotencyKey,
        refCode,
        category,
        template,
        to, // 联系方式（手机号）；管理层可见，一线名册不返回
        channel: rendered.channel,
        title: rendered.title,
        body: rendered.body,
        status: "queued",
        attempts: 0,
        createdAt: this.clock().toISOString(),
        deliveredAt: null,
        lastError: null,
      };
      state.notifications[idempotencyKey] = record;
      return { created: true, record };
    }).then(async ({ created, record }) => {
      if (!created) return { created: false, record };
      await this.deliver(record);
      return { created: true, record: this.store.read((s) => s.notifications[idempotencyKey]) };
    });
  }

  async deliver(record) {
    return this.store.mutate(async (state) => {
      const cur = state.notifications[record.idempotencyKey];
      cur.attempts += 1;
      try {
        await this.deliverer({
          id: cur.id,
          channel: cur.channel,
          to: cur.to,
          title: cur.title,
          body: cur.body,
        });
        cur.status = "delivered";
        cur.deliveredAt = this.clock().toISOString();
        cur.lastError = null;
      } catch (err) {
        cur.status = "failed";
        cur.lastError = String(err?.message ?? err);
        this.logger.warn?.(`通知投递失败 ${cur.id}: ${cur.lastError}`);
      }
      return cur;
    });
  }

  /** 启动/重启后重投此前未成功的通知（不改幂等键，不产生重复通知） */
  async retryPending() {
    const pending = this.store.read((s) =>
      Object.values(s.notifications).filter((n) => n.status !== "delivered"),
    );
    for (const n of pending) {
      await this.deliver(n);
    }
  }
}

export function defaultDeliverer(logger = console) {
  // 无真实短信网关时的落地实现：写日志。测试可注入假投递器。
  return async ({ channel, to, title, body }) => {
    logger.info?.(`[通知:${channel}] -> ${to} | ${title} | ${body}`);
  };
}
