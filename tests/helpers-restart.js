import { makeHarness, apply, tempDataFile, SILENT_LOGGER } from "./helpers.js";
import { createApp } from "../src/app.js";

/**
 * 基于真实落盘文件的两阶段夹具：
 * h.apply / h.restart()，用于验证服务重启后状态、到期任务与通知补偿。
 */
export async function makeHarness2(options = {}) {
  const dataFile = options.dataFile ?? tempDataFile();
  let now = options.now ?? "2026-09-22T08:00:00+08:00";

  const first = makeHarness({ ...options, dataFile, now });
  if (options.failFirst) {
    // 替换投递器：第一条通知先失败一次
    first.notifications.deliverer = async (msg) => {
      first.sent.push(msg);
      throw new Error("模拟网关抖动");
    };
  }

  return {
    store: first.store,
    sent: first.sent,
    setNow(iso) {
      now = iso;
      first.setNow(iso);
    },
    service: first.service,
    async apply(overrides) {
      return apply(first, overrides);
    },
    async restart({ deliverFail = false } = {}) {
      const sent = [];
      const app = createApp({
        dataFile,
        clock: () => new Date(now),
        logger: SILENT_LOGGER,
        deliverer: async (msg) => {
          sent.push(msg);
          if (deliverFail) throw new Error("仍然抖动");
        },
        staffKey: "staff-key",
        adminKey: "admin-key",
      });
      await app.start();
      return { app, store: app.store, sent, service: app.service };
    },
  };
}
