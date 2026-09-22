import assert from "node:assert/strict";
import test from "node:test";
import { createContainer } from "../src/container.js";
import { makeHarness, bookInput, injectSlot } from "./helpers.js";

test("状态落盘：新容器可从同一文件恢复全部数据与截止时间", () => {
  const h = makeHarness({ persist: true });
  try {
    const slot = injectSlot(h, { capacity: 1 });
    const first = h.svc.book(bookInput(slot.id, { serviceTypes: ["WHEELCHAIR_ASSIST"] }));
    h.svc.book(bookInput(slot.id));

    let restartedClock = h.clock();
    const restarted = createContainer({
      stateFile: h.file,
      clock: () => restartedClock,
    });
    const apps = restarted.store.state.applications;
    assert.equal(apps.length, 2);
    const confirmed = apps.find((a) => a.reference === first.application.reference);
    assert.equal(confirmed.status, "CONFIRMED");
    assert.equal(confirmed.allocations[0].status, "ASSIGNED");
    const waiting = apps.find((a) => a.status === "WAITLISTED");
    assert.ok(waiting.waitlistExpiresAt);
    // 管理令牌哈希在重启后仍然有效
    assert.doesNotThrow(() =>
      restarted.reservations.selfView(first.application.reference, first.manageToken));
  } finally {
    h.cleanup();
  }
});

test("服务停机错过的截止时间，重启后按原截止时间追补：候补过期、爽约释放、不错误晋级", () => {
  const h = makeHarness({ persist: true });
  try {
    const slot = injectSlot(h, { capacity: 1, startsInMs: 2 * 3600_000 });
    const confirmed = h.svc.book(bookInput(slot.id));
    const waiting = h.svc.book(bookInput(slot.id));
    const confirmedRef = confirmed.application.reference;
    const waitingRef = waiting.application.reference;

    // 模拟停机：时钟越过开场后宽限期（同时也越过了候补截止）
    const afterDeadline = new Date(h.now + 2 * 3600_000 + 16 * 60_000).toISOString();
    const restarted = createContainer({ stateFile: h.file, clock: () => afterDeadline });
    const result = restarted.reservations.runTimedOperations();

    const types = result.actions.map((a) => a.type).sort();
    assert.deepEqual(types, ["NO_SHOW_RELEASED", "WAITLIST_EXPIRED"]);

    const apps = restarted.store.state.applications;
    assert.equal(apps.find((a) => a.reference === confirmedRef).status, "NO_SHOW");
    assert.equal(apps.find((a) => a.reference === waitingRef).status, "EXPIRED");
    // 过期候补绝不因爽约释放而晋级
    assert.equal(
      restarted.reservations.listPublicSlots().find((s) => s.id === slot.id).occupied,
      0,
    );
  } finally {
    h.cleanup();
  }
});

test("重启后通知仍按幂等键去重", () => {
  const h = makeHarness({ persist: true });
  try {
    const slot = injectSlot(h, { capacity: 1 });
    const holder = h.svc.book(bookInput(slot.id));
    const waiting = h.svc.book(bookInput(slot.id));

    const later = new Date(h.now + 10 * 60_000).toISOString();
    const restarted = createContainer({ stateFile: h.file, clock: () => later });
    const holderId = restarted.store.state.applications.find((a) => a.reference === holder.application.reference).id;
    restarted.reservations.adminCancelApplication(holderId, "重启后取消", { role: "admin" });

    // 多次定时扫描不产生重复晋级通知
    restarted.reservations.runTimedOperations();
    restarted.reservations.runTimedOperations();
    const waitingApp = restarted.store.state.applications.find((a) => a.reference === waiting.application.reference);
    const promoted = restarted.store.state.notifications.filter(
      (n) => n.applicationId === waitingApp.id && n.type === "PROMOTED",
    );
    assert.equal(promoted.length, 1);
  } finally {
    h.cleanup();
  }
});
