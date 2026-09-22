import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, apply } from "./helpers.js";

test("通知中的到期时间使用 +08:00 而非 UTC Z", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  await apply(h, { contactPhone: "13800130001" });
  const received = h.sent.find((m) => m.title === "申请已受理");
  assert.ok(received.body.includes("+08:00"), received.body);
  assert.ok(!/[0-9]Z/.test(received.body.match(/于(.*?)前/)?.[1] ?? ""));
  // 暂留 30 分钟
  assert.ok(received.body.includes("2026-09-22T10:30"));
});

test("同一申请的通知以同一幂等键重复提交只投递一次", async () => {
  const h = makeHarness();
  const a = await apply(h, { contactPhone: "13800130002" });
  await h.notifications.send(`apply:${a.application.code}`, {
    template: "application_received",
    vars: h.service.baseVars(h.store.read((s) => s.applications[a.application.code]), {
      holdExpiresAt: "2026-09-22T10:30:00.000+08:00",
    }),
    to: "13800130002",
    refCode: a.application.code,
    category: "application_received",
  });
  const count = h.sent.filter((m) => m.title === "申请已受理").length;
  assert.equal(count, 1);
});
