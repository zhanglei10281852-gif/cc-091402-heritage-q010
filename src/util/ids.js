import { randomBytes, createHash } from "node:crypto";

export function randomId(prefix) {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

export function shortReference() {
  // 便于观众口头核对的预约编号，避免暴露任何身份信息
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = randomBytes(8);
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export function manageToken() {
  return randomBytes(24).toString("hex");
}

export function hashDocument(idDocument) {
  const normalized = String(idDocument).trim().replace(/\s+/g, "").toUpperCase();
  return createHash("sha256").update(normalized).digest("hex");
}

export function maskPhone(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}
