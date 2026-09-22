import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, apply } from "./helpers.js";

test("手语班次故障：有名额时改派其他手语班次并解释变更", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  const a = await apply(h, {
    applicantName: "手语观众",
    partySize: 7,
    needs: { signLanguage: true },
    contactPhone: "1",
  });
  assert.equal(a.application.commitments.find((c) => c.kind === "shift").label, "手语导览A组");

  await h.service.reportOutage({ kind: "shift", refId: "sign-a", reason: "译员临时请假" });

  const after = h.store.read((s) => s.applications[a.application.code]);
  assert.equal(after.shiftAssignments[0].shiftId, "sign-b");
  assert.equal(after.shiftAssignments[0].seats, 7);
  assert.equal(after.status, "held"); // 名额状态不变

  const msg = h.sent.find((m) => m.title === "服务安排变更");
  assert.ok(msg.body.includes("译员临时请假"));
  assert.ok(msg.body.includes("手语"));
});

test("无替代容量时：保留时段名额，仅标记服务不可用并提供改期/取消", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  // sign-a 12 人 + sign-b 12 人全部占满
  const a = await apply(h, {
    applicantType: "group", orgName: "A协", applicantName: "a",
    partySize: 12, needs: { signLanguage: true }, contactPhone: "1",
  });
  const b = await apply(h, {
    applicantType: "group", orgName: "B协", applicantName: "b",
    partySize: 12, needs: { signLanguage: true }, contactPhone: "2",
  });
  assert.equal(a.application.status, "held");
  assert.equal(b.application.status, "held");

  // sign-a 故障：sign-b 满，无法改派
  await h.service.reportOutage({ kind: "shift", refId: "sign-a", reason: "设备故障" });

  const after = h.store.read((s) => s.applications[a.application.code]);
  assert.equal(after.status, "held"); // 绝不踢出
  assert.equal(after.shiftAssignments.length, 0); // 手语承诺摘除
  assert.equal(after.serviceAlerts.length, 1);
  assert.equal(after.serviceAlerts[0].reason, "设备故障");

  const msg = h.sent.find((m) => m.title === "部分服务暂时不可用");
  assert.ok(msg.body.includes("名额保留"));
});

test("轮椅主用资源故障：改用备用池；备用不足时名额保留", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  // 主用池 3 个占满
  const apps = [];
  for (let i = 0; i < 3; i += 1) {
    apps.push(await apply(h, {
      applicantName: `轮椅${i}`, partySize: 1,
      needs: { wheelchairUnits: 1 }, contactPhone: String(10 + i),
    }));
  }
  // 备用 1 个
  apps.push(await apply(h, {
    applicantName: "轮椅3", partySize: 1,
    needs: { wheelchairUnits: 1 }, contactPhone: "13",
  }));
  assert.ok(apps.every((x) => x.application.status === "held"));

  // 主用池故障：前 3 人中 1 人可改派备用，但备用已被第 4 人占用 -> 都无法满足
  // 先验证：只占 2 个主用时，故障可改派备用
  const h2 = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  const x = await apply(h2, {
    applicantName: "轮椅x", partySize: 2,
    needs: { wheelchairUnits: 2 }, contactPhone: "20",
  });
  assert.equal(x.application.commitments.find((c) => c.kind === "resource").label, "轮椅借用·主用");
  await h2.service.reportOutage({ kind: "pool", refId: "wheelchair-main", reason: "维修" });
  const xa = h2.store.read((s) => s.applications[x.application.code]);
  assert.equal(xa.resourceAssignments[0].resourceId, "wheelchair-reserve");
  assert.equal(xa.resourceAssignments[0].units, 1);
  // 备用只有 1，另 1 个轮椅无法满足 -> 标记不可用，但座位保留
  assert.equal(xa.status, "held");
  assert.equal(xa.serviceAlerts.length, 1);
});

test("故障恢复后补登服务承诺并通知；期间确认名额不受影响", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  const a = await apply(h, {
    applicantType: "group", orgName: "A协", applicantName: "a",
    partySize: 12, needs: { signLanguage: true }, contactPhone: "1",
  });
  const b = await apply(h, {
    applicantType: "group", orgName: "B协", applicantName: "b",
    partySize: 12, needs: { signLanguage: true }, contactPhone: "2",
  });
  await h.service.confirm(a.application.code, a.managementToken);

  await h.service.reportOutage({ kind: "shift", refId: "sign-a", reason: "故障" });
  // a 无法改派（sign-b 被 b 占满）
  let aa = h.store.read((s) => s.applications[a.application.code]);
  assert.equal(aa.status, "confirmed");
  assert.equal(aa.shiftAssignments.length, 0);

  // b 改期离开（释放 sign-b），容量回收时不会自动恢复 a（需故障恢复事件）
  await h.service.reschedule(b.application.code, b.managementToken, {
    slotDate: "2026-09-23", slotId: "afternoon",
  });

  // 故障恢复：a 的手语承诺应补登
  const outageId = h.store.read((s) => s.outages)[0].id;
  await h.service.restoreOutage(outageId);
  aa = h.store.read((s) => s.applications[a.application.code]);
  assert.equal(aa.status, "confirmed");
  assert.equal(aa.shiftAssignments.length, 1);
  assert.equal(aa.shiftAssignments[0].seats, 12);
  assert.ok(["sign-a", "sign-b"].includes(aa.shiftAssignments[0].shiftId));
  const restored = h.sent.find((m) => m.title === "服务已恢复");
  assert.ok(restored);
});

test("故障与重分配全过程有审计记录，通知可按编号追溯", async () => {
  const h = makeHarness();
  const a = await apply(h, {
    applicantName: "手语观众", partySize: 4,
    needs: { signLanguage: true }, contactPhone: "1",
  });
  await h.service.reportOutage({ kind: "shift", refId: "sign-a", reason: "测试故障" });
  const outageId = h.store.read((s) => s.outages)[0].id;
  await h.service.restoreOutage(outageId);

  const actions = h.store.read((s) => s.auditLog.map((e) => e.action));
  assert.ok(actions.includes("outage_reported"));
  assert.ok(actions.includes("service_reassigned"));
  assert.ok(actions.includes("outage_resolved"));
  assert.ok(actions.includes("service_restored"));

  const code = a.application.code;
  const refs = h.store
    .read((s) => Object.values(s.notifications).filter((n) => n.refCode === code))
    .map((n) => [n.category, n.status]);
  assert.deepEqual(
    refs.map(([c]) => c).sort(),
    ["application_received", "service_changed", "service_restored"].sort(),
  );
  assert.ok(refs.every(([, status]) => status === "delivered"));
});

test("同一次故障的重分配通知幂等：重复上报处理不重复通知", async () => {
  const h = makeHarness();
  const a = await apply(h, {
    applicantName: "手语观众", partySize: 4,
    needs: { signLanguage: true }, contactPhone: "1",
  });
  await h.service.reportOutage({ kind: "shift", refId: "sign-a", reason: "故障" });
  const firstCount = h.sent.filter((m) => m.title === "服务安排变更").length;
  // 再次手动触发重分配：该申请已标记此 outage，不会重复处理
  const outage = h.store.read((s) => s.outages)[0];
  await h.service.reassignForOutage(outage);
  const secondCount = h.sent.filter((m) => m.title === "服务安排变更").length;
  assert.equal(firstCount, 1);
  assert.equal(secondCount, 1);
});
