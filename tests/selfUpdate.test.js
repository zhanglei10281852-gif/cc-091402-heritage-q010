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

test("已确认预约可增加人数但受剩余名额限制；减少人数后候补可晋级", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 3 });
  const mine = h.svc.book(bookInput(slot.id, { partySize: 3 }));
  const waiting = h.svc.book(bookInput(slot.id, { partySize: 1 }));
  assert.equal(waiting.application.status, "WAITLISTED");

  // 已满：增到 4 人受容量约束被拒，增到 5 人超个人人数上限
  expectError(
    () => h.svc.updateSelf(mine.application.reference, mine.manageToken, { partySize: 4 }),
    "INSUFFICIENT_CAPACITY",
  );
  expectError(
    () => h.svc.updateSelf(mine.application.reference, mine.manageToken, { partySize: 5 }),
    "INVALID_PARTY_SIZE",
  );

  // 减到 2 人 -> 空出 1 席 -> 候补晋级
  const updated = h.svc.updateSelf(mine.application.reference, mine.manageToken, { partySize: 2 });
  assert.equal(updated.partySize, 2);
  assert.equal(
    h.store.state.applications.find((a) => a.reference === waiting.application.reference).status,
    "CONFIRMED",
  );
  assert.equal(h.svc.listPublicSlots().find((s) => s.id === slot.id).occupied, 3);
  h.cleanup();
});

test("候补团体缩小人数后若整团放得下可被直接晋级", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 6 });
  h.svc.book(bookInput(slot.id, { partySize: 1 }));
  const group = h.svc.book(bookInput(slot.id, { kind: "GROUP", partySize: 6 }));
  assert.equal(group.application.status, "WAITLISTED");
  // 剩余 5 席：6 人放不下；缩小到 5 人后整团放得下，直接晋级
  const updated = h.svc.updateSelf(group.application.reference, group.manageToken, { partySize: 5 });
  assert.equal(updated.status, "CONFIRMED");
  assert.equal(h.svc.listPublicSlots().find((s) => s.id === slot.id).occupied, 6);
  h.cleanup();
});

test("可新增/移除无障碍服务：移除即释放设备并回填他人候补，新增受资源余量约束", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 20 });
  const total = h.store.state.resources.filter((r) => r.type === "WHEELCHAIR_ASSIST").length;
  const holders = [];
  for (let i = 0; i < total; i += 1) {
    holders.push(h.svc.book(bookInput(slot.id, { serviceTypes: ["WHEELCHAIR_ASSIST"] })));
  }
  const later = h.svc.book(bookInput(slot.id, { serviceTypes: ["WHEELCHAIR_ASSIST"] }));
  assert.equal(later.application.allocations[0].status, "WAITLISTED");

  // 第一位观众移除轮椅需求 -> 设备释放 -> later 自动回填
  h.svc.updateSelf(holders[0].application.reference, holders[0].manageToken, { serviceTypes: [] });
  const laterApp = h.store.state.applications.find((a) => a.reference === later.application.reference);
  assert.equal(laterApp.allocations[0].status, "ASSIGNED");

  // 第一位再想加回：轮椅已全部分配 -> 进入服务候补但入场名额不受影响
  const readded = h.svc.updateSelf(holders[0].application.reference, holders[0].manageToken, {
    serviceTypes: ["WHEELCHAIR_ASSIST"],
  });
  assert.equal(readded.status, "CONFIRMED");
  assert.equal(readded.allocations[0].status, "WAITLISTED");
  h.cleanup();
});

test("修改接口同样需要管理令牌", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 5 });
  const mine = h.svc.book(bookInput(slot.id, { partySize: 1 }));
  expectError(
    () => h.svc.updateSelf(mine.application.reference, "bad", { partySize: 2 }),
    "BAD_MANAGE_TOKEN",
  );
  h.cleanup();
});
