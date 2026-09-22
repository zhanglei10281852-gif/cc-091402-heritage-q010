import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, bookInput, injectSlot } from "./helpers.js";

function expectError(fn, code) {
  try {
    fn();
    assert.fail("应当抛出错误");
  } catch (error) {
    assert.equal(error.code, code);
  }
}

test("强制闭馆：有已确认预约时需 force；关闭后已确认取消、候补过期且均收到准确通知", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 1 });
  const confirmed = h.svc.book(bookInput(slot.id));
  const waiting = h.svc.book(bookInput(slot.id));

  expectError(() => h.svc.closeSlot(slot.id, "设备检修", false, { role: "admin" }), "SLOT_HAS_CONFIRMED");
  h.svc.closeSlot(slot.id, "设备检修", true, { role: "admin" });

  const c = h.store.state.applications.find((a) => a.reference === confirmed.application.reference);
  const w = h.store.state.applications.find((a) => a.reference === waiting.application.reference);
  assert.equal(c.status, "CANCELLED");
  assert.equal(c.cancellation.reason, "SLOT_CLOSED");
  assert.equal(w.status, "EXPIRED");
  assert.equal(w.allocations.length, 0);

  for (const app of [c, w]) {
    const notices = h.store.state.notifications.filter((n) => n.applicationId === app.id);
    assert.ok(notices.some((n) => n.type === "SLOT_CLOSED"));
    assert.ok(notices.find((n) => n.type === "SLOT_CLOSED").body.includes("设备检修"));
  }
  const publicSlot = h.svc.listPublicSlots().find((item) => item.id === slot.id);
  assert.equal(publicSlot.status, "CLOSED");
  assert.equal(publicSlot.occupied, 0);

  // 幂等：闭馆通知只有一条
  h.svc.runTimedOperations();
  assert.equal(
    h.store.state.notifications.filter((n) => n.type === "SLOT_CLOSED").length,
    2,
  );
  h.cleanup();
});

test("审计覆盖名额变化、服务承诺、通知结果三类事件，含经办角色与时间", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 10 });
  const result = h.svc.book(bookInput(slot.id, { serviceTypes: ["WHEELCHAIR_ASSIST"] }));
  h.svc.cancelSelf(result.application.reference, result.manageToken);

  const capacity = h.svc.queryAudit({ category: "CAPACITY" });
  const applications = h.svc.queryAudit({ category: "APPLICATION" });
  const commitments = h.svc.queryAudit({ category: "SERVICE_COMMITMENT" });
  const notifications = h.svc.queryAudit({ category: "NOTIFICATION" });

  assert.ok(applications.some((e) => e.action === "BOOKING_CONFIRMED"));
  assert.ok(capacity.some((e) => e.action === "SEATS_RELEASED"));
  assert.ok(commitments.some((e) => e.action === "SERVICE_RELEASED"));
  assert.ok(notifications.some((e) => e.action === "SENT" && e.payload.type === "CONFIRMED"));
  assert.ok(notifications.some((e) => e.action === "SENT" && e.payload.type === "CANCELLED"));
  for (const event of [...capacity, ...commitments, ...notifications]) {
    assert.ok(event.at, "审计事件必须带发生时间");
    assert.ok(event.actor && event.actor.role, "审计事件必须带经办角色");
  }
  h.cleanup();
});
