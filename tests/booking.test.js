import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, bookInput, injectSlot, doc } from "./helpers.js";

function expectError(fn, code) {
  try {
    fn();
    assert.fail("应当抛出错误");
  } catch (error) {
    assert.equal(error.code, code);
  }
}

test("个人预约成功并返回管理令牌，但不落证件明文", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 2 });
  const result = h.svc.book(bookInput(slot.id, { idDocument: doc(42) }));
  assert.equal(result.application.status, "CONFIRMED");
  assert.match(result.manageToken, /^[0-9a-f]{48}$/);
  const stored = h.store.state.applications[0];
  assert.ok(!JSON.stringify(stored).includes("ID000042"));
  assert.notEqual(stored.documentHash, "");
  h.cleanup();
});

test("同一证件在同一时段只能有一个有效预约；换时段或取消后可再约", () => {
  const h = makeHarness();
  const slotA = injectSlot(h, { id: "slot-a", startsInMs: 3 * 3600_000 });
  const slotB = injectSlot(h, { id: "slot-b", startsInMs: 27 * 3600_000 });
  const identity = doc(1);
  const first = h.svc.book(bookInput(slotA.id, { idDocument: identity }));
  expectError(
    () => h.svc.book(bookInput(slotA.id, { idDocument: identity })),
    "DUPLICATE_ACTIVE_APPLICATION",
  );
  // 另一时段可约
  assert.equal(h.svc.book(bookInput(slotB.id, { idDocument: identity })).application.status, "CONFIRMED");
  // 取消后原时段可再约
  h.svc.cancelSelf(first.application.reference, first.manageToken);
  assert.equal(h.svc.book(bookInput(slotA.id, { idDocument: identity })).application.status, "CONFIRMED");
  h.cleanup();
});

test("名额满后进入候补，公开视图不暴露证件与需求细节", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 2 });
  h.svc.book(bookInput(slot.id, { partySize: 1 }));
  h.svc.book(bookInput(slot.id, { partySize: 1 }));
  const third = h.svc.book(bookInput(slot.id, { partySize: 1 }));
  assert.equal(third.application.status, "WAITLISTED");
  assert.ok(third.application.waitlistExpiresAt);

  const publicSlot = h.svc.listPublicSlots().find((item) => item.id === slot.id);
  assert.deepEqual(
    { occupied: publicSlot.occupied, available: publicSlot.available, waitlist: publicSlot.waitlist },
    { occupied: 2, available: 0, waitlist: 1 },
  );
  assert.equal(JSON.stringify(publicSlot).includes("idDocument"), false);
  h.cleanup();
});

test("团体必须整团原子占座，部分名额不足时进入候补且不拆分", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 10 });
  h.svc.book(bookInput(slot.id, { kind: "GROUP", partySize: 5 }));
  // 仅剩 5 个名额，6 人团体不得拆分成 5+1
  const group = h.svc.book(bookInput(slot.id, { kind: "GROUP", partySize: 6 }));
  assert.equal(group.application.status, "WAITLISTED");
  const publicSlot = h.svc.listPublicSlots().find((item) => item.id === slot.id);
  assert.equal(publicSlot.occupied, 5);

  // 候补团体不能挤掉已确认名额：取消释放 5 席后整团晋级
  const holder = h.store.state.applications[0];
  h.svc.adminCancelApplication(holder.id, "test", { role: "admin" });
  const reloaded = h.store.state.applications.find((app) => app.reference === group.application.reference);
  assert.equal(reloaded.status, "CONFIRMED");
  assert.equal(h.svc.listPublicSlots().find((item) => item.id === slot.id).occupied, 6);
  h.cleanup();
});

test("团体人数超出区间被拒；个人人数超界被拒", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 40 });
  expectError(() => h.svc.book(bookInput(slot.id, { kind: "GROUP", partySize: 4 })), "INVALID_PARTY_SIZE");
  expectError(() => h.svc.book(bookInput(slot.id, { kind: "GROUP", partySize: 41 })), "INVALID_PARTY_SIZE");
  expectError(() => h.svc.book(bookInput(slot.id, { partySize: 5 })), "INVALID_PARTY_SIZE");
  h.cleanup();
});

test("闭馆时段（周一/节假日）不接受预约", () => {
  const h = makeHarness();
  const closed = h.store.state.slots.find((slot) => slot.status === "CLOSED");
  assert.ok(closed, "种子数据应包含闭馆时段");
  expectError(() => h.svc.book(bookInput(closed.id)), "SLOT_CLOSED");
  h.cleanup();
});

test("已开始的时段不可预约", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { startsInMs: -1000 });
  expectError(() => h.svc.book(bookInput(slot.id)), "SLOT_STARTED");
  h.cleanup();
});
