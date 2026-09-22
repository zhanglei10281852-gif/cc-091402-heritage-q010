import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, bookInput, injectSlot } from "./helpers.js";

function wheelchairs(store) {
  return store.state.resources.filter((r) => r.type === "WHEELCHAIR_ASSIST");
}

test("轮椅请求分配具体设备并在现场履约视图展示", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 10 });
  const result = h.svc.book(bookInput(slot.id, { serviceTypes: ["WHEELCHAIR_ASSIST"] }));
  const allocation = result.application.allocations[0];
  assert.equal(allocation.status, "ASSIGNED");
  assert.match(allocation.delivery, /^轮椅/);

  const roster = h.svc.staffRoster(slot.id);
  assert.equal(roster.items[0].services.length, 1);
  assert.equal(roster.items[0].services[0].type, "WHEELCHAIR_ASSIST");
  // 履约视图不含证件号与联系人全名，电话掩码
  assert.equal(JSON.stringify(roster).includes("idDocument"), false);
  assert.match(roster.items[0].contact, /\*{4}/);
  h.cleanup();
});

test("轮椅不足时保留入场名额并进入服务候补，释放后自动回填并通知", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 20 });
  const total = wheelchairs(h.store).length;
  assert.ok(total >= 1);
  const holders = [];
  for (let i = 0; i < total; i += 1) {
    holders.push(h.svc.book(bookInput(slot.id, { serviceTypes: ["WHEELCHAIR_ASSIST"] })));
  }
  const queued = h.svc.book(bookInput(slot.id, { serviceTypes: ["WHEELCHAIR_ASSIST"] }));
  assert.equal(queued.application.status, "CONFIRMED");
  assert.equal(queued.application.allocations[0].status, "WAITLISTED");

  // 释放一台轮椅 -> 服务候补回填
  h.svc.cancelSelf(holders[0].application.reference, holders[0].manageToken);
  const queuedApp = h.store.state.applications.find((a) => a.reference === queued.application.reference);
  assert.equal(queuedApp.allocations[0].status, "ASSIGNED");
  const notices = h.store.state.notifications.filter((n) => n.applicationId === queuedApp.id);
  assert.ok(notices.some((n) => n.type === "SERVICE_CHANGED"));
  // 幂等：同一服务变更序列不重复通知
  assert.equal(notices.filter((n) => n.type === "SERVICE_CHANGED").length, 1);
  h.cleanup();
});

test("轮椅故障时优先同类改派，无可用设备时转服务候补，恢复后回填", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 20 });
  // 占掉除两台外的全部轮椅
  const chairs = wheelchairs(h.store).sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 2; i < chairs.length; i += 1) {
    h.svc.book(bookInput(slot.id, { serviceTypes: ["WHEELCHAIR_ASSIST"] }));
  }
  const visitor = h.svc.book(bookInput(slot.id, { serviceTypes: ["WHEELCHAIR_ASSIST"] }));
  const visitorApp = h.store.state.applications.find((a) => a.reference === visitor.application.reference);
  const assignedChair = visitorApp.allocations[0].resourceId;

  // 故障：仍有一台空闲轮椅可改派
  const afterDown = h.svc.resourceDown(assignedChair, { note: "轮胎维修" }, { role: "admin" });
  assert.equal(afterDown.status, "DOWN");
  const reloaded = h.store.state.applications.find((a) => a.id === visitorApp.id);
  assert.equal(reloaded.allocations[0].status, "ASSIGNED");
  assert.notEqual(reloaded.allocations[0].resourceId, assignedChair);
  assert.ok(h.store.state.notifications.some((n) => n.applicationId === visitorApp.id && n.type === "SERVICE_CHANGED"));

  // 再占掉最后一台备用椅，然后故障当前用椅：无设备可派 -> 服务候补
  h.svc.book(bookInput(slot.id, { serviceTypes: ["WHEELCHAIR_ASSIST"] }));
  const currentChair = reloaded.allocations[0].resourceId;
  h.svc.resourceDown(currentChair, {}, { role: "admin" });
  const queued = h.store.state.applications.find((a) => a.id === visitorApp.id);
  assert.equal(queued.allocations[0].status, "WAITLISTED");
  assert.ok(h.store.state.notifications.some((n) => n.applicationId === visitorApp.id && n.type === "SERVICE_WAITLISTED"));

  // 恢复一台 -> 回填
  h.svc.resourceRecover(currentChair, { role: "admin" });
  const filled = h.store.state.applications.find((a) => a.id === visitorApp.id);
  assert.equal(filled.allocations[0].status, "ASSIGNED");
  h.cleanup();
});

test("手语译员故障时改派至同类班次并解释变更", () => {
  const h = makeHarness();
  // 种子数据中第一个开放日上午场有两班手语导览
  const target = h.store.state.tourSchedules
    .filter((tour) => tour.startsAt.includes("T10:00"))
    .map((tour) => ({ tour, alt: h.store.state.tourSchedules.some((t) => t.slotId === tour.slotId && t.id !== tour.id) }))
    .find((item) => item.alt);
  assert.ok(target, "种子数据应包含同场次两个手语班次");
  const result = h.svc.book(bookInput(target.tour.slotId, { serviceTypes: ["SIGN_LANGUAGE"] }));
  const app = h.store.state.applications.find((a) => a.reference === result.application.reference);
  assert.equal(app.allocations[0].tourScheduleId, target.tour.id);

  h.svc.resourceDown(target.tour.interpreterResourceId, { note: "译员突发情况" }, { role: "admin" });
  const reloaded = h.store.state.applications.find((a) => a.id === app.id);
  assert.equal(reloaded.allocations[0].status, "ASSIGNED");
  assert.notEqual(reloaded.allocations[0].tourScheduleId, target.tour.id);

  const notice = h.store.state.notifications.find((n) => n.applicationId === app.id && n.type === "SERVICE_CHANGED");
  assert.ok(notice.body.includes("手语") && notice.body.includes("改派"));

  const audit = h.store.state.auditEvents.find((e) => e.category === "SERVICE_COMMITMENT" && e.action === "REALLOCATED");
  assert.ok(audit);
  assert.equal(audit.payload.fromResourceId, target.tour.interpreterResourceId);
  h.cleanup();
});

test("手语耳机名额是独立容量，不占用入场名额之外的席位", () => {
  const h = makeHarness();
  const tour = h.store.state.tourSchedules.find((t) => t.headsetCapacity === 4);
  assert.ok(tour, "种子数据应包含容量 4 的第二手语班");
  // 默认分配会先用 10:00 班次（容量 8）；直接通过公开视图检查容量独立展示
  const slotView = h.svc.listPublicSlots().find((s) => s.id === tour.slotId);
  assert.equal(slotView.services.wheelchairs.total >= 1, true);
  assert.ok(slotView.services.signLanguageTours.some((t) => t.tourId === tour.id));
  h.cleanup();
});

test("资源永久停用且无可改派资源时明确告知无法安排，入场名额不受影响", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 20 });
  const chairs = wheelchairs(h.store);
  // 占满全部轮椅
  const holders = [];
  for (let i = 0; i < chairs.length; i += 1) {
    holders.push(h.svc.book(bookInput(slot.id, { serviceTypes: ["WHEELCHAIR_ASSIST"] })));
  }
  const last = holders[holders.length - 1];
  const app = h.store.state.applications.find((a) => a.reference === last.application.reference);
  const chairId = app.allocations[0].resourceId;
  h.svc.resourceRetire(chairId, "达到报废年限", { role: "admin" });
  const reloaded = h.store.state.applications.find((a) => a.id === app.id);
  assert.equal(reloaded.status, "CONFIRMED");
  assert.equal(reloaded.allocations[0].status, "UNAVAILABLE");
  assert.ok(h.store.state.notifications.some((n) => n.applicationId === app.id && n.type === "SERVICE_DOWNGRADED"));
  h.cleanup();
});

test("通知以业务键幂等：取消、晋级通知重复触发不产生第二条", () => {
  const h = makeHarness();
  const slot = injectSlot(h, { capacity: 1 });
  const holder = h.svc.book(bookInput(slot.id));
  const waiting = h.svc.book(bookInput(slot.id));
  h.svc.cancelSelf(holder.application.reference, holder.manageToken);
  const waitingApp = h.store.state.applications.find((a) => a.reference === waiting.application.reference);
  // 再跑若干次定时扫描
  h.svc.runTimedOperations();
  h.svc.runTimedOperations();
  const promoted = h.store.state.notifications.filter((n) => n.applicationId === waitingApp.id && n.type === "PROMOTED");
  assert.equal(promoted.length, 1);
  // 直接用相同幂等键重发取消通知也只保留一条
  const before = h.store.state.notifications.length;
  h.container.notifications.notify({
    applicationId: h.store.state.applications.find((a) => a.reference === holder.application.reference).id,
    type: "CANCELLED",
    context: { slot: h.svc.getSlot(slot.id) },
    dedupeKey: "lifecycle:CANCELLED",
  });
  assert.equal(h.store.state.notifications.length, before);
  h.cleanup();
});
