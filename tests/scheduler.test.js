import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { SILENT_LOGGER } from "./helpers.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function realtimeApp() {
  // 定时器测试需要真实流动的时间（业务测试 elsewhere 使用可控冻结时钟）
  return createApp({ dataFile: ":memory:", clock: () => new Date(), logger: SILENT_LOGGER });
}

test("调度器按原截止时间触发暂留释放，新入队任务无需重启即可被感知", async (context) => {
  const app = realtimeApp();
  const code = "bk_timer_probe";
  const dueAt = new Date(Date.now() + 80).toISOString();
  let called = null;
  app.scheduler.handlers.hold_expire = async (refCode) => {
    called = refCode;
  };
  app.scheduler.start();
  context.after(() => app.scheduler.stop());

  await app.store.mutate((state) => {
    state.dueQueue.push({ seq: state.counters.dueSeq++, dueAt, type: "hold_expire", refCode: code });
  });
  await sleep(220);
  assert.equal(called, code);
});

test("调度器错过的任务立即补偿（模拟重启停机窗口）", async (context) => {
  const app = realtimeApp();
  const called = [];
  app.scheduler.handlers.hold_expire = async (code2) => called.push(code2);
  await app.store.mutate((state) => {
    state.dueQueue.push({
      seq: state.counters.dueSeq++,
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      type: "hold_expire",
      refCode: "bk_past_due",
    });
  });
  app.scheduler.start();
  context.after(() => app.scheduler.stop());
  await sleep(50);
  assert.ok(called.includes("bk_past_due"));
});

