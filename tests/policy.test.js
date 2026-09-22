import assert from "node:assert/strict";
import test from "node:test";
import {
  isClosedDate,
  weekdayOf,
  waitlistExpiry,
  noShowReleaseAt,
  canSelfCancel,
  canSelfReschedule,
  partyBounds,
  shanghaiDateParts,
} from "../src/domain/policy.js";

const rules = {
  closedWeekdays: [1],
  holidays: [
    { date: "2026-09-25", name: "中秋节闭馆", mode: "CLOSED" },
    { date: "2026-09-28", name: "国庆调休开放", mode: "SPECIAL_OPEN" }, // 周一
  ],
};
const policy = { waitlistCutoffMinutes: 60, noShowGraceMinutes: 15, rescheduleDeadlineMinutes: 60 };

test("周一默认闭馆，但调休 SPECIAL_OPEN 的周一开放", () => {
  assert.equal(weekdayOf("2026-09-28"), 1);
  assert.equal(isClosedDate("2026-09-28", rules), null);
  assert.equal(isClosedDate("2026-09-21", rules), "每周闭馆日"); // 普通周一
});

test("CLOSED 节假日闭馆并返回名称；普通日期开放", () => {
  assert.equal(isClosedDate("2026-09-25", rules), "中秋节闭馆");
  assert.equal(isClosedDate("2026-09-24", rules), null);
});

test("候补截止与爽约释放时间相对时段开始时间计算", () => {
  const slot = { startsAt: "2026-09-24T09:30:00+08:00", endsAt: "2026-09-24T12:00:00+08:00" };
  assert.equal(waitlistExpiry(slot, policy), "2026-09-24T00:30:00.000Z"); // 08:30 +08:00
  assert.equal(noShowReleaseAt(slot, policy), "2026-09-24T01:45:00.000Z"); // 09:45 +08:00
});

test("自助取消/改期窗口判定", () => {
  const slot = { startsAt: "2026-09-24T09:30:00+08:00" };
  const app = { status: "CONFIRMED" };
  assert.equal(canSelfCancel(app, slot, "2026-09-24T09:29:00+08:00"), true);
  assert.equal(canSelfCancel(app, slot, "2026-09-24T09:31:00+08:00"), false);
  assert.equal(canSelfReschedule(app, slot, "2026-09-24T08:30:00+08:00", policy), true);
  assert.equal(canSelfReschedule(app, slot, "2026-09-24T08:31:00+08:00", policy), false);
  assert.equal(canSelfCancel({ status: "CANCELLED" }, slot, "2026-09-24T08:00:00+08:00"), false);
});

test("团体与个人人数边界", () => {
  assert.deepEqual(partyBounds("GROUP"), { min: 5, max: 40 });
  assert.deepEqual(partyBounds("INDIVIDUAL"), { min: 1, max: 4 });
});

test("上海时区日期分块不受主机时区影响", () => {
  // 2026-09-24T00:30+08:00 即 UTC 2026-09-23T16:30，日期分块仍应为 09-24
  assert.equal(shanghaiDateParts(Date.parse("2026-09-23T16:30:00Z")), "2026-09-24");
});
