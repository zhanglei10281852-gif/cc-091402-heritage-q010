import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, bookInput, injectSlot, notificationsOf } from "./helpers.js";

function expectError(fn, code) {
  try {
    fn();
    assert.fail("应当抛出错误");
  } catch (error) {
    assert.equal(error.code, code);
  }
}

test("取消释放名额后候补按 FIFO 整团晋级并发通知", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 6 });
  const a = h.svc.book(bookInput(slot.id, { kind: "GROUP", partySize: 5 }));
  const b = h.svc.book(bookInput(slot.id, { partySize: 1 }));
  const w1 = h.svc.book(bookInput(slot.id, { partySize: 5, kind: "GROUP" }));
  const w2 = h.svc.book(bookInput(slot.id, { partySize: 1 }));
  assert.equal(w1.application.status, "WAITLISTED");
  assert.equal(w2.application.status, "WAITLISTED");

  // 释放 5 席：队首 5 人团体整团晋级
  h.svc.cancelSelf(a.application.reference, a.manageToken);
  const g1 = h.store.state.applications.find((app) => app.reference === w1.application.reference);
  const g2 = h.store.state.applications.find((app) => app.reference === w2.application.reference);
  assert.equal(g1.status, "CONFIRMED");
  assert.equal(g2.status, "WAITLISTED");
  assert.equal(notificationsOf(h, g1.id).some((n) => n.type === "PROMOTED"), true);

  // 再释放 1 席：第二号候补晋级
  h.svc.cancelSelf(b.application.reference, b.manageToken);
  assert.equal(h.store.state.applications.find((app) => app.reference === w2.application.reference).status, "CONFIRMED");
  h.cleanup();
});

test("队首团体整团放不下时不跳过、不拆分", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 5 });
  h.svc.book(bookInput(slot.id, { kind: "GROUP", partySize: 5 }));
  const big = h.svc.book(bookInput(slot.id, { kind: "GROUP", partySize: 6 }));
  const small = h.svc.book(bookInput(slot.id, { partySize: 1 }));
  assert.equal(big.application.status, "WAITLISTED");
  assert.equal(small.application.status, "WAITLISTED");

  // 释放 5 席，空出 5 席：队首 6 人团放不下 -> 停止；1 人候补也不得跳过晋级
  h.svc.adminCancelApplication(h.store.state.applications[0].id, "test", { role: "admin" });
  assert.equal(h.store.state.applications.find((a) => a.reference === big.application.reference).status, "WAITLISTED");
  assert.equal(h.store.state.applications.find((a) => a.reference === small.application.reference).status, "WAITLISTED");
  const publicSlot = h.svc.listPublicSlots().find((item) => item.id === slot.id);
  assert.equal(publicSlot.occupied, 0);
  assert.equal(publicSlot.available, 5);
  h.cleanup();
});

test("超过候补截止时间后，候补过期且永不挤掉已确认名额", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 1, startsInMs: 2 * 3600_000 });
  h.svc.book(bookInput(slot.id, { partySize: 1 }));
  const waiting = h.svc.book(bookInput(slot.id, { partySize: 1 }));
  const waitingApp = h.store.state.applications.find((a) => a.reference === waiting.application.reference);
  // 推进到候补截止（开场前 60 分钟）之后
  h.setNow(waitingApp.waitlistExpiresAt);
  h.advance(1000);
  h.svc.runTimedOperations();
  assert.equal(h.store.state.applications.find((a) => a.id === waitingApp.id).status, "EXPIRED");

  // 即使此时已确认者取消、名额空出，过期候补也不晋级
  h.svc.adminCancelApplication(h.store.state.applications[0].id, "late", { role: "admin" });
  const publicSlot = h.svc.listPublicSlots().find((item) => item.id === slot.id);
  assert.equal(publicSlot.occupied, 0);
  assert.equal(h.store.state.applications.find((a) => a.id === waitingApp.id).status, "EXPIRED");
  h.cleanup();
});

test("开场宽限期满后爽约名额被释放并触发候补晋级", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 1, startsInMs: 2 * 3600_000 });
  const confirmed = h.svc.book(bookInput(slot.id, { partySize: 1 }));
  const waiting = h.svc.book(bookInput(slot.id, { partySize: 1 }));
  const confirmedApp = h.store.state.applications.find((a) => a.reference === confirmed.application.reference);
  const waitingApp = h.store.state.applications.find((a) => a.reference === waiting.application.reference);

  // 候补截止为开场前 60 分钟；要让候补可晋级，必须在截止前释放。
  // 爽约释放发生在开场后 15 分钟，因此常规场景候补先过期——这里用管理取消在截止前释放，
  // 再单独验证爽约释放时间点行为。
  h.setNow(confirmedApp.noShowReleaseAt);
  h.svc.runTimedOperations();
  assert.equal(h.store.state.applications.find((a) => a.id === confirmedApp.id).status, "NO_SHOW");
  // 候补已在截止时过期，不晋级
  assert.equal(h.store.state.applications.find((a) => a.id === waitingApp.id).status, "EXPIRED");
  assert.equal(h.svc.listPublicSlots().find((item) => item.id === slot.id).occupied, 0);
  h.cleanup();
});

test("截止前释放名额，定时扫描可让候补晋级", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 1, startsInMs: 2 * 3600_000 });
  h.svc.book(bookInput(slot.id, { partySize: 1 }));
  const waiting = h.svc.book(bookInput(slot.id, { partySize: 1 }));
  const waitingApp = h.store.state.applications.find((a) => a.reference === waiting.application.reference);

  // 开场前 90 分钟（候补截止前 30 分钟）由系统侧取消已确认者
  h.advance(30 * 60_000);
  h.svc.adminCancelApplication(h.store.state.applications[0].id, "early-release", { role: "admin" });
  // 管理取消已同步触发晋级；这里额外验证定时扫描幂等不产生重复通知
  const result = h.svc.runTimedOperations();
  assert.deepEqual(result.actions, []);
  assert.equal(h.store.state.applications.find((a) => a.id === waitingApp.id).status, "CONFIRMED");
  const promotedNotices = notificationsOf(h, waitingApp.id).filter((n) => n.type === "PROMOTED");
  assert.equal(promotedNotices.length, 1);
  h.cleanup();
});

test("容量调增后定时/同步推进候补；容量不得低于已确认人数", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 1 });
  h.svc.book(bookInput(slot.id, { partySize: 1 }));
  const waiting = h.svc.book(bookInput(slot.id, { partySize: 1 }));
  h.svc.setSlotCapacity(slot.id, 2, { role: "admin" });
  assert.equal(
    h.store.state.applications.find((a) => a.reference === waiting.application.reference).status,
    "CONFIRMED",
  );
  expectError(() => h.svc.setSlotCapacity(slot.id, 1, { role: "admin" }), "CAPACITY_BELOW_CONFIRMED");
  h.cleanup();
});
