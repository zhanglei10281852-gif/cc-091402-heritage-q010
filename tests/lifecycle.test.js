import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, apply } from "./helpers.js";

test("取消释放名额后候补按序晋级，无障碍需求优先", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  // 占满 60：40 团 + 19 团 + 1 名已确认散客
  await apply(h, { applicantType: "group", orgName: "g1", applicantName: "1", partySize: 40, contactPhone: "1" });
  await apply(h, { applicantType: "group", orgName: "g2", applicantName: "2", partySize: 19, contactPhone: "2" });
  const single = await apply(h, { applicantName: "单", partySize: 1, contactPhone: "5" });
  await h.service.confirm(single.application.code, single.managementToken);

  // 普通候补先到（2 人），轮椅候补后到（1 人）
  const wlGeneral = await apply(h, { applicantName: "普通候补", partySize: 2, contactPhone: "3" });
  const wlWheel = await apply(h, {
    applicantName: "轮椅候补",
    partySize: 1,
    needs: { wheelchairUnits: 1 },
    contactPhone: "4",
  });
  assert.equal(wlGeneral.application.status, "waitlisted");
  assert.equal(wlWheel.application.status, "waitlisted");

  // 释放 1 个名额：轮椅候补应越过 2 人普通候补优先晋级，普通候补仍在排队
  await h.service.cancel(single.application.code, single.managementToken);

  const wheelAfter = h.store.read((s) => s.applications[wlWheel.application.code]);
  const generalAfter = h.store.read((s) => s.applications[wlGeneral.application.code]);
  assert.equal(wheelAfter.status, "held");
  assert.equal(generalAfter.status, "waitlisted");
});

test("暂留到期自动释放并晋级后续候补；确认后不再被释放", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  const ga = await apply(h, { applicantType: "group", orgName: "ga", applicantName: "ga", partySize: 40, contactPhone: "1" });
  const gb = await apply(h, { applicantType: "group", orgName: "gb", applicantName: "gb", partySize: 20, contactPhone: "6" });
  const wl = await apply(h, { applicantName: "候", partySize: 1, contactPhone: "2" });
  assert.equal(wl.application.status, "waitlisted");

  // 两个团体都确认：到期任务移除，时间推进也不释放
  await h.service.confirm(ga.application.code, ga.managementToken);
  await h.service.confirm(gb.application.code, gb.managementToken);
  h.setNow("2026-09-22T11:00:00+08:00");
  await h.service.runDueNow();
  assert.equal(h.store.read((s) => s.applications[ga.application.code].status), "confirmed");

  // 取消 40 人团体 -> 候补晋级为 held，暂留 30 分钟
  await h.service.cancel(ga.application.code, ga.managementToken);
  let promoted = h.store.read((s) => s.applications[wl.application.code]);
  assert.equal(promoted.status, "held");
  const holdExpires = promoted.holdExpiresAt;

  // 30 分钟内不释放
  h.setNow("2026-09-22T11:29:00+08:00");
  await h.service.runDueNow();
  promoted = h.store.read((s) => s.applications[wl.application.code]);
  assert.equal(promoted.status, "held");

  // 超过暂留期未确认 -> 过期
  h.setNow("2026-09-22T11:31:00+08:00");
  await h.service.runDueNow();
  promoted = h.store.read((s) => s.applications[wl.application.code]);
  assert.equal(promoted.status, "expired");
  assert.ok(new Date(holdExpires) <= new Date(h.service.now()));
});

test("过期候补不会挤掉已确认名额", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  const ga = await apply(h, { applicantType: "group", orgName: "ga", applicantName: "ga", partySize: 40, contactPhone: "1" });
  const gb = await apply(h, { applicantType: "group", orgName: "gb", applicantName: "gb", partySize: 20, contactPhone: "6" });
  await h.service.confirm(ga.application.code, ga.managementToken);
  await h.service.confirm(gb.application.code, gb.managementToken);
  const wl = await apply(h, { applicantName: "候", partySize: 1, contactPhone: "2" });
  assert.equal(wl.application.status, "waitlisted");

  // 候补过期：即使满员也不做任何重排
  h.setNow("2026-09-25T10:00:00+08:00");
  await h.service.runDueNow();
  assert.equal(h.store.read((s) => s.applications[wl.application.code].status), "expired");
  assert.equal(h.store.read((s) => s.applications[ga.application.code].status), "confirmed");
});

test("取消、确认、晋级通知幂等：重复触发不产生第二条", async () => {
  const h = makeHarness();
  const a = await apply(h, { contactPhone: "13800000001" });
  await h.service.confirm(a.application.code, a.managementToken);
  // 重复确认
  const again = await h.service.confirm(a.application.code, a.managementToken);
  assert.equal(again.idempotent, true);
  await h.service.cancel(a.application.code, a.managementToken);
  // 重复取消
  const cancelAgain = await h.service.cancel(a.application.code, a.managementToken);
  assert.equal(cancelAgain.idempotent, true);

  const counts = {};
  for (const n of h.sent) counts[n.title] = (counts[n.title] ?? 0) + 1;
  assert.equal(counts["预约已确认"], 1);
  assert.equal(counts["预约已取消"], 1);
});

test("通知投递失败后重启重投，不产生重复业务通知", async () => {
  const { makeHarness2 } = await import("./helpers-restart.js");
  const h = await makeHarness2({ failFirst: true });
  const a = await h.apply({ contactPhone: "13800000002" });
  // 首次投递失败
  const failedRecord = h.store.read((s) => Object.values(s.notifications)[0]);
  assert.equal(failedRecord.status, "failed");

  // 重启（同一数据文件，新投递器），启动补偿重投成功
  const h2 = await h.restart();
  const redelivered = h2.store.read((s) => Object.values(s.notifications)[0]);
  assert.equal(redelivered.status, "delivered");
  assert.equal(redelivered.attempts, 2);
  assert.equal(h2.sent.length, 1);
});

test("改期：目标满则保留原预约；成功后原时段释放触发候补", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  // 上午场占满：40 团 + 20 团
  const g1 = await apply(h, { applicantType: "group", orgName: "g", applicantName: "g", partySize: 40, contactPhone: "1" });
  await apply(h, { applicantType: "group", orgName: "g2", applicantName: "g2", partySize: 20, contactPhone: "9" });
  const wlMorning = await apply(h, { applicantName: "上午候补", partySize: 1, contactPhone: "2" });
  // 下午场一个 5 人已确认预约
  const afternoon = await apply(h, { slotId: "afternoon", applicantName: "下午观众", partySize: 5, contactPhone: "3" });
  await h.service.confirm(afternoon.application.code, afternoon.managementToken);

  // 5 人下午观众想改到已满的上午 -> 拒绝，原预约不动
  await assert.rejects(
    () => h.service.reschedule(afternoon.application.code, afternoon.managementToken, { slotDate: "2026-09-23", slotId: "morning" }),
    (err) => err.code === "target_full",
  );
  assert.equal(
    h.store.read((s) => s.applications[afternoon.application.code].slotId),
    "afternoon",
  );

  // 60 人团体改到下午（容量 60 放得下）
  const r = await h.service.reschedule(g1.application.code, g1.managementToken, { slotDate: "2026-09-23", slotId: "afternoon" });
  assert.equal(r.application.status, "held"); // 改期后须重新确认
  // 上午释放，候补晋级
  assert.equal(h.store.read((s) => s.applications[wlMorning.application.code].status), "held");
});

test("服务重启后：到期释放按原截止时间补偿执行，状态跨重启保留", async () => {
  const { makeHarness2 } = await import("./helpers-restart.js");
  const h = await makeHarness2({ now: "2026-09-22T10:00:00+08:00" });
  await h.apply({ applicantType: "group", orgName: "g", applicantName: "g", partySize: 40, contactPhone: "1" });
  await h.apply({ applicantType: "group", orgName: "g2", applicantName: "g2", partySize: 20, contactPhone: "9" });
  const wl = await h.apply({ applicantName: "候补", partySize: 1, contactPhone: "2" });
  assert.equal(wl.application.status, "waitlisted");
  // 注意：首阶段未调用 start()，定时任务完全依赖重启补偿
  h.setNow("2026-09-22T10:45:00+08:00");

  const h2 = await h.restart();
  // 40 人团体暂留至 10:30 已过：被释放，候补晋级
  const wl2 = h2.store.read((s) => Object.values(s.applications).find((a) => a.applicantName === "候补"));
  assert.equal(wl2.status, "held");
  const group = h2.store.read((s) => Object.values(s.applications).find((a) => a.orgName === "g"));
  assert.equal(group.status, "expired");
});

test("自助操作必须携带管理令牌；返回视图不含证件号与手机号", async () => {
  const h = makeHarness();
  const a = await apply(h, { contactPhone: "13800000003" });
  await assert.rejects(
    () => h.service.cancel(a.application.code, "wrong-token"),
    (err) => err.code === "unauthorized",
  );
  const view = a.application;
  assert.ok(!JSON.stringify(view).includes("13800000003"));
  assert.ok(!view.idNumber);
  assert.ok(view.idMask.includes("*"));
});
