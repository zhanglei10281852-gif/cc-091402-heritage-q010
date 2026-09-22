import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, apply, applicationBody } from "./helpers.js";

test("团体可在多个导览班次间拆分，但分片之和不超过容量", async () => {
  const h = makeHarness();
  // 常规班次总容量 60，时段容量 60：30 人团体应被单班容纳
  const result = await apply(h, {
    applicantType: "group",
    orgName: "某中学",
    applicantName: "带队老师",
    partySize: 30,
    contactPhone: "13900000001",
  });
  assert.equal(result.application.status, "held");
  const shifts = result.application.commitments.filter((c) => c.kind === "shift");
  assert.equal(shifts.reduce((s, c) => s + c.seats, 0), 30);
  assert.equal(shifts.length, 1); // std-a 30 人正好放下

  // 再来 31 人团体：班次余量 30（std-b），分片后仍剩 1 人无法容纳 -> 候补
  const bigger = await apply(h, {
    applicantType: "group",
    orgName: "另一中学",
    applicantName: "另一位老师",
    partySize: 31,
    contactPhone: "13900000009",
  });
  assert.equal(bigger.application.status, "waitlisted");
});

test("团体在班次余量碎片化时跨班次拆分，每片均不超容量", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  // std-a 被占 10 人，std-b 被占 20 人（合计占用时段 30 座位）
  await apply(h, { applicantType: "group", orgName: "先到甲", applicantName: "甲", partySize: 10, contactPhone: "81" });
  await apply(h, { applicantType: "group", orgName: "先到乙", applicantName: "乙", partySize: 20, contactPhone: "82" });
  // 新 30 人团体：std-a 余 20、std-b 余 10，应拆为 20+10
  const g = await apply(h, { applicantType: "group", orgName: "后到中学", applicantName: "老师", partySize: 30, contactPhone: "83" });
  assert.equal(g.application.status, "held");
  const shifts = g.application.commitments.filter((c) => c.kind === "shift");
  assert.equal(shifts.reduce((s, c) => s + c.seats, 0), 30);
  assert.deepEqual(shifts.map((c) => [c.label, c.seats]).sort(), [
    ["常规导览A组", 20],
    ["常规导览B组", 10],
  ]);
  // 再来 1 人：班次容量合计只剩 0（30+30 全满，时段也满）-> 候补
  const overflow = await apply(h, { applicantName: "散客", partySize: 1, contactPhone: "84" });
  assert.equal(overflow.application.status, "waitlisted");
});

test("团体拆分不得突破班次容量", async () => {
  const h = makeHarness();
  // 先用手语占满 sign-a 12 人
  const first = await apply(h, {
    applicantType: "group",
    orgName: "手语协会",
    applicantName: "王老师",
    partySize: 12,
    needs: { signLanguage: true },
    contactPhone: "13900000002",
  });
  assert.equal(first.application.status, "held");
  // 第二个手语团体 13 人：sign-a 满、sign-b 12 人，只能放 12 -> 无法全部容纳 -> 候补
  const second = await apply(h, {
    applicantType: "group",
    orgName: "聋人协会",
    applicantName: "李老师",
    partySize: 13,
    needs: { signLanguage: true },
    contactPhone: "13900000003",
  });
  assert.equal(second.application.status, "waitlisted");
});

test("时段总容量受限：超过 60 人拒绝/候补", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" }); // 已过保留位保护窗口
  // 两个 30 人团体占满 60
  await apply(h, { applicantType: "group", orgName: "甲校", applicantName: "甲", partySize: 30, contactPhone: "13700000001" });
  const b = await apply(h, { applicantType: "group", orgName: "乙校", applicantName: "乙", partySize: 30, contactPhone: "13700000002" });
  assert.equal(b.application.status, "held");
  const c = await apply(h, { partySize: 1, applicantName: "散客", contactPhone: "13700000003" });
  assert.equal(c.application.status, "waitlisted");
});

test("保护窗口内无障碍保留位不被普通申请占用", async () => {
  const h = makeHarness({ now: "2026-09-22T08:00:00+08:00" });
  // 普通容量 = 60-6 = 54。放满 54（两个 27 人团体）
  await apply(h, { applicantType: "group", orgName: "A", applicantName: "a", partySize: 27, contactPhone: "13600000001" });
  await apply(h, { applicantType: "group", orgName: "B", applicantName: "b", partySize: 27, contactPhone: "13600000002" });
  // 普通第 55 人应候补
  const blocked = await apply(h, { applicantName: "普通", partySize: 1, contactPhone: "13600000003" });
  assert.equal(blocked.application.status, "waitlisted");
  // 轮椅散客仍可使用保留位
  const wheel = await apply(h, {
    applicantName: "轮椅观众",
    partySize: 1,
    needs: { wheelchairUnits: 1 },
    contactPhone: "13600000004",
  });
  assert.equal(wheel.application.status, "held");
  const resource = wheel.application.commitments.find((c) => c.kind === "resource");
  assert.equal(resource.units, 1);
});

test("保护窗口过后普通申请可使用未占用保留位", async () => {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" }); // 距明早 09:30 不足 24h
  for (let i = 0; i < 6; i += 1) {
    // 60 个普通名额（保留位已释放）
  }
  const big = await apply(h, { applicantType: "group", orgName: "大团", applicantName: "x", partySize: 40, contactPhone: "13500000001" });
  const big2 = await apply(h, { applicantType: "group", orgName: "大团2", applicantName: "y", partySize: 20, contactPhone: "13500000002" });
  assert.equal(big.application.status, "held");
  assert.equal(big2.application.status, "held");
  const overflow = await apply(h, { applicantName: "z", partySize: 1, contactPhone: "13500000003" });
  assert.equal(overflow.application.status, "waitlisted");
});

test("同一证件同一时段只能有一个有效预约（含候补）", async () => {
  const h = makeHarness();
  const id = "310101199102031234";
  const a = await apply(h, { idNumber: id, partySize: 30, applicantType: "group", orgName: "g", applicantName: "n", contactPhone: "13400000001" });
  assert.equal(a.application.status, "held");
  await assert.rejects(
    () => h.service.apply(applicationBody({ idNumber: id, contactPhone: "13400000002" })),
    (err) => err.code === "duplicate_active",
  );
  // 取消后可重新申请
  await h.service.cancel(a.application.code, a.managementToken);
  const again = await apply(h, { idNumber: id, partySize: 1, contactPhone: "13400000003" });
  assert.equal(again.application.status, "held");
});

test("闭馆日与节假日规则生效", async () => {
  const h = makeHarness();
  // 2026-09-28 是周一（常规闭馆），但调休开放
  assert.equal(h.service.catalog.dayInfo("2026-09-28").closed, false);
  // 国庆闭馆
  assert.equal(h.service.catalog.dayInfo("2026-10-01").closed, true);
  await assert.rejects(
    () => apply(h, { slotDate: "2026-10-01" }),
    (err) => err.code === "slot_closed",
  );
});

test("预约截止后不可再申请", async () => {
  const h = makeHarness({ now: "2026-09-23T09:05:00+08:00" }); // 开场前 25 分钟
  await assert.rejects(
    () => apply(h),
    (err) => err.code === "booking_closed",
  );
});
