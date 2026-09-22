import crypto from "node:crypto";

const ID_TOKENS = "abcdefghijkmnpqrstuvwxyz23456789";

export function randomId(prefix) {
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (const b of bytes) out += ID_TOKENS[b % ID_TOKENS.length];
  return `${prefix}${out}`;
}

export function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

/** 证件号只保存哈希，比对走哈希；任何日志/接口均不返回原值 */
export function hashIdentity(idType, idNumber) {
  return crypto.createHash("sha256").update(`${idType}:${idNumber}`).digest("hex");
}

export function maskIdNumber(idNumber) {
  if (idNumber.length <= 6) return "*".repeat(idNumber.length);
  return idNumber.slice(0, 3) + "*".repeat(idNumber.length - 6) + idNumber.slice(-3);
}

export function maskPhone(phone) {
  if (phone.length < 7) return phone.slice(0, 2) + "****";
  return phone.slice(0, 3) + "****" + phone.slice(-4);
}

/** 东八区固定偏移（上海自 1991 年起无夏令时），输出带时区 ISO 8601 */
const OFFSET_MS = 8 * 60 * 60 * 1000;

export function shanghaiParts(date) {
  const shifted = new Date(date.getTime() + OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

export function ymd(date) {
  const { y, m, d } = shanghaiParts(date);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 把展厅日期（YYYY-MM-DD）与分钟时刻（HH:MM）组合为带 +08:00 的时间 */
export function combineDateTime(dateStr, hhmm) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  const ms = Date.UTC(y, m - 1, d, hour, minute, 0) - OFFSET_MS;
  return new Date(ms);
}

export function toIso(date) {
  const shifted = new Date(date.getTime() + OFFSET_MS);
  return shifted.toISOString().replace("Z", "+08:00");
}

export function parseIso(iso) {
  return new Date(iso);
}

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addHours(date, hours) {
  return new Date(date.getTime() + hours * 3_600_000);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

export function slotKey(hallId, slotDate, slotId) {
  return `${hallId}|${slotDate}|${slotId}`;
}

export function clampDate(date, notAfter) {
  return notAfter && date > notAfter ? notAfter : date;
}
