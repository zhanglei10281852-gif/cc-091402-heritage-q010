/**
 * 纯业务规则：不访问存储、不产生副作用，便于单测与审计复核。
 * 所有时间比较均基于带时区的 ISO 8601 字符串的毫秒时间戳。
 */

export const SERVICE_TYPES = Object.freeze({
  WHEELCHAIR_ASSIST: "WHEELCHAIR_ASSIST",
  SIGN_LANGUAGE: "SIGN_LANGUAGE",
});

export const SERVICE_LABELS = Object.freeze({
  WHEELCHAIR_ASSIST: "轮椅协助",
  SIGN_LANGUAGE: "手语导览",
});

export const APPLICATION_STATUS = Object.freeze({
  CONFIRMED: "CONFIRMED",
  WAITLISTED: "WAITLISTED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
  NO_SHOW: "NO_SHOW",
});

/** 有效（仍占用或排队占用名额）的状态 */
export function isActiveStatus(status) {
  return status === "CONFIRMED" || status === "WAITLISTED";
}

export function ts(value) {
  return Date.parse(value);
}

export function shanghaiDateParts(dateMs) {
  // Asia/Shanghai 固定 UTC+8（中国不实行夏令时）
  return new Date(dateMs + 8 * 3600_000).toISOString().slice(0, 10);
}

export function isoInShanghai(date, hoursMinutes) {
  return `${date}T${hoursMinutes}:00+08:00`;
}

export function weekdayOf(date) {
  return new Date(`${date}T12:00:00+08:00`).getUTCDay();
}

export function isClosedDate(date, rules) {
  const holiday = (rules.holidays ?? []).find((item) => item.date === date);
  if (holiday) {
    // 调休上班（如周一逢国庆调休）优先于每周闭馆规则：开放。
    if (holiday.mode === "SPECIAL_OPEN") return null;
    if (holiday.mode === "CLOSED") return holiday.name;
  }
  if ((rules.closedWeekdays ?? []).includes(weekdayOf(date))) return "每周闭馆日";
  return null;
}

/** 候补截止：时段开始前 N 分钟，过期后不再参与晋级 */
export function waitlistExpiry(slot, policy) {
  return new Date(ts(slot.startsAt) - policy.waitlistCutoffMinutes * 60_000).toISOString();
}

/** 已确认预约的爽约释放时间：开场后宽限期满 */
export function noShowReleaseAt(slot, policy) {
  return new Date(ts(slot.startsAt) + policy.noShowGraceMinutes * 60_000).toISOString();
}

export function canSelfCancel(application, slot, at) {
  return isActiveStatus(application.status) && ts(at) < ts(slot.startsAt);
}

export function canSelfReschedule(application, slot, at, policy) {
  if (!isActiveStatus(application.status)) return false;
  return ts(at) <= ts(slot.startsAt) - policy.rescheduleDeadlineMinutes * 60_000;
}

export function partyBounds(kind) {
  if (kind === "GROUP") return { min: 5, max: 40 };
  return { min: 1, max: 4 };
}
