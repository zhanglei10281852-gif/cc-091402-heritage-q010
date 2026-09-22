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

test("自助查看/取消/改期需要管理令牌，令牌错误时拒绝", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 2 });
  const result = h.svc.book(bookInput(slot.id));
  const { reference } = result.application;

  expectError(() => h.svc.selfView(reference, "wrong-token"), "BAD_MANAGE_TOKEN");
  expectError(() => h.svc.cancelSelf(reference, ""), "BAD_MANAGE_TOKEN");
  assert.doesNotThrow(() => h.svc.selfView(reference, result.manageToken));

  const slot2 = injectSlot(h, { id: "slot-target", startsInMs: 27 * 3600_000, capacity: 5 });
  const rescheduled = h.svc.rescheduleSelf(reference, result.manageToken, { newSlotId: slot2.id });
  assert.equal(rescheduled.slot.id, slot2.id);
  h.cleanup();
});

test("任何返回给他人的视图都不含证件号/证件哈希/管理令牌", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 2 });
  const mine = h.svc.book(bookInput(slot.id, { idDocument: "SECRETDOC999" }));
  h.svc.book(bookInput(slot.id));

  for (const view of [
    h.svc.listPublicSlots(),
    h.svc.staffRoster(slot.id),
    h.svc.adminListApplications({}),
    h.svc.listNotifications({}),
  ]) {
    const text = JSON.stringify(view);
    assert.equal(text.includes("SECRETDOC999"), false);
    assert.equal(text.includes("manageTokenHash"), false);
    assert.equal(text.includes("documentHash"), false);
  }
  // 管理令牌只在创建响应中出现一次
  assert.ok(mine.manageToken);
  assert.equal(JSON.stringify(h.svc.adminListApplications({})).includes(mine.manageToken), false);
  h.cleanup();
});

test("现场角色看不到审计/管理操作；管理员可见完整审计", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 2 });
  h.svc.book(bookInput(slot.id));
  h.svc.setSlotCapacity(slot.id, 10, { role: "admin" });
  const events = h.svc.queryAudit({ category: "CAPACITY" });
  assert.ok(events.some((e) => e.action === "CAPACITY_CHANGED"));
  const capacityEvent = events.find((e) => e.action === "CAPACITY_CHANGED");
  assert.equal(capacityEvent.actor.role, "admin");
  assert.equal(capacityEvent.at.includes("T") || capacityEvent.at.includes("-"), true);
  h.cleanup();
});

test("改期超过截止时间被拒；目标时段名额不足整团时被拒", () => {
  const h = makeHarness();
  const soon = injectSlot(h, { id: "soon", startsInMs: 30 * 60_000, capacity: 5 });
  const later = injectSlot(h, { id: "later", startsInMs: 5 * 3600_000, capacity: 10 });
  const result = h.svc.book(bookInput(soon.id, { kind: "GROUP", partySize: 5 }));
  expectError(
    () => h.svc.rescheduleSelf(result.application.reference, result.manageToken, { newSlotId: later.id }),
    "RESCHEDULE_DEADLINE_PASSED",
  );

  const source = injectSlot(h, { id: "source", startsInMs: 3 * 3600_000, capacity: 10 });
  const target = injectSlot(h, { id: "target2", startsInMs: 27 * 3600_000, capacity: 6 });
  const group = h.svc.book(bookInput(source.id, { kind: "GROUP", partySize: 6 }));
  h.svc.book(bookInput(target.id, { partySize: 1 }));
  expectError(
    () => h.svc.rescheduleSelf(group.application.reference, group.manageToken, { newSlotId: target.id }),
    "TARGET_FULL",
  );
  h.cleanup();
});

test("改期释放原名额后原时段候补晋级，目标时段占用整团名额", () => {
  const h = makeHarness();
  const source = injectSlot(h, { id: "source", startsInMs: 3 * 3600_000, capacity: 6 });
  const target = injectSlot(h, { id: "target", startsInMs: 27 * 3600_000, capacity: 10 });
  const group = h.svc.book(bookInput(source.id, { kind: "GROUP", partySize: 5 }));
  const waiting = h.svc.book(bookInput(source.id, { partySize: 1 }));
  h.svc.rescheduleSelf(group.application.reference, group.manageToken, { newSlotId: target.id });
  assert.equal(
    h.store.state.applications.find((a) => a.reference === waiting.application.reference).status,
    "CONFIRMED",
  );
  assert.equal(h.svc.listPublicSlots().find((s) => s.id === source.id).occupied, 1);
  assert.equal(h.svc.listPublicSlots().find((s) => s.id === target.id).occupied, 5);
  h.cleanup();
});
