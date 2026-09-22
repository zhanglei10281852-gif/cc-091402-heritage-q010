import { maskPhone } from "./util.js";

/**
 * 视图映射：同一份申请按角色投影为不同字段集。
 * - 申请人本人：可见自己的联系方式掩码与服务承诺。
 * - 现场工作人员：仅履约所需（编号、姓名、人数、班次/服务项），无证件、无电话、无备注。
 * - 管理员：附加审计与通知结果所需的结构化信息，证件与电话仍以掩码呈现。
 */

export function commitmentItems(app, config) {
  const items = [];
  for (const a of app.shiftAssignments ?? []) {
    const shift = config.shiftById.get(a.shiftId);
    items.push({ kind: "shift", label: shift?.label ?? a.shiftId, modality: shift?.modality, seats: a.seats });
  }
  for (const a of app.resourceAssignments ?? []) {
    const res = config.resourceById.get(a.resourceId);
    items.push({ kind: "resource", label: res?.label ?? a.resourceId, units: a.units });
  }
  return items;
}

export function applicantView(app, config) {
  if (!app) return null;
  return {
    code: app.code,
    status: app.status,
    applicantType: app.applicantType,
    applicantName: app.applicantName,
    orgName: app.orgName ?? null,
    idType: app.idType,
    idMask: app.idMask,
    contactPhoneMask: maskPhone(app.contactPhone),
    hallId: app.hallId,
    slotDate: app.slotDate,
    slotId: app.slotId,
    slotLabel: app.slotLabel,
    slotStart: app.slotStart,
    slotEnd: app.slotEnd,
    partySize: app.partySize,
    needs: { signLanguage: Boolean(app.needs?.signLanguage), wheelchairUnits: app.needs?.wheelchairUnits ?? 0 },
    commitments: commitmentItems(app, config),
    serviceAlerts: (app.serviceAlerts ?? []).map((a) => ({
      label: a.label,
      reason: a.reason,
      changeType: a.changeType,
      status: a.status,
      restoredAt: a.restoredAt ?? null,
    })),
    holdExpiresAt: app.holdExpiresAt ?? null,
    waitlistRank: app.waitlistRank ?? null,
    statusHistory: app.statusHistory,
    rescheduledFrom: app.rescheduledFrom ?? null,
    createdAt: app.createdAt,
  };
}

export function staffRosterView(app, config) {
  if (!app) return null;
  return {
    code: app.code,
    applicantName: app.applicantName,
    orgName: app.orgName ?? null,
    slotLabel: app.slotLabel,
    slotStart: app.slotStart,
    partySize: app.partySize,
    applicantType: app.applicantType,
    // 履约所需的服务项（如“手语导览A组 12 人”“轮椅借用·备用 ×1”），
    // 不含证件号、联系方式、残障原因等任何细节。
    serviceItems: commitmentItems(app, config),
    // 仅展示现场履约仍需处理的未解决缺口（已改派/已恢复的不打扰现场）
    serviceAlerts: (app.serviceAlerts ?? [])
      .filter((a) => a.changeType === "unavailable" && a.status !== "restored")
      .map((a) => ({ label: a.label, reason: a.reason, status: a.status })),
  };
}

export function adminApplicationView(app, config) {
  return {
    ...applicantView(app, config),
    idHash: app.idHash,
  };
}
