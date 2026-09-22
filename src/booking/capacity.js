import { addMinutes } from "./util.js";

/**
 * 容量与分配计算（纯函数）。
 *
 * 名额三层约束：
 * 1. 时段总容量；其中 accessibleHeld 个座位在开场前的保护窗口内只留给无障碍申请者。
 * 2. 导览班次：standard / sign 两种模态，团体允许跨班次拆分，但各分片之和不得超容量。
 * 3. 服务资源池（轮椅等）：主用优先，备用仅在主用不足或故障时使用。
 *
 * 候补只占用“已释放且当前空闲”的容量，任何计算都不会改动 held/confirmed 申请，
 * 因此过期候补不可能挤掉已确认名额。
 */

const ACTIVE = new Set(["held", "confirmed"]);

export function activeApplications(state, slotKey) {
  return Object.values(state.applications).filter(
    (app) => ACTIVE.has(app.status) && app.slotKey === slotKey,
  );
}

export function activeOutageAt(outages, kind, refId, at) {
  return (outages ?? []).find(
    (o) =>
      o.kind === kind &&
      o.refId === refId &&
      o.status === "active" &&
      new Date(o.startedAt) <= at &&
      (!o.activeUntil || at < new Date(o.activeUntil)),
  );
}

export function usageAt(state, config, slotKey, at) {
  const totalUsed = { seats: 0, accessibleSeats: 0, generalSeats: 0 };
  const shiftSeats = new Map(); // shiftId -> used
  const poolUnits = new Map(); // resourceId -> used

  for (const app of activeApplications(state, slotKey)) {
    const isAccessibleParty = (app.wheelchairUnits ?? 0) > 0;
    totalUsed.seats += app.partySize;
    if (isAccessibleParty) totalUsed.accessibleSeats += app.partySize;
    else totalUsed.generalSeats += app.partySize;

    for (const a of app.shiftAssignments ?? []) {
      if (activeOutageAt(state.outages, "shift", a.shiftId, at)) continue;
      shiftSeats.set(a.shiftId, (shiftSeats.get(a.shiftId) ?? 0) + a.seats);
    }
    for (const a of app.resourceAssignments ?? []) {
      if (activeOutageAt(state.outages, "pool", a.resourceId, at)) continue;
      poolUnits.set(a.resourceId, (poolUnits.get(a.resourceId) ?? 0) + a.units);
    }
  }
  return { totalUsed, shiftSeats, poolUnits };
}

/**
 * 计算一个需求能否在某时段落地，并给出具体分片方案。
 * @param demand {{partySize:number, sign:boolean, wheelchairUnits:number, accessible:boolean}}
 * @param slot {{date:string, start:Date, template:object}}
 */
export function computePlan(state, config, slot, demand, at, broken = null) {
  const { capacity, accessibleHeld } = slot.template;
  const slotKey = slot.key;
  const { totalUsed, shiftSeats, poolUnits } = usageAt(state, config, slotKey, at);

  // —— 第 1 层：时段座位 ——
  const protectedWindow = at < new Date(slot.start.getTime() - config.accessibleReleaseMs);
  let seatsOk;
  if (demand.accessible) {
    // 无障碍团体可优先使用保留位，也可使用普通位
    seatsOk = totalUsed.seats + demand.partySize <= capacity;
  } else if (protectedWindow) {
    // 保护窗口内，普通团体只能使用未被无障碍占用的非保留位
    seatsOk = totalUsed.generalSeats + demand.partySize <= capacity - accessibleHeld;
  } else {
    seatsOk = totalUsed.seats + demand.partySize <= capacity;
  }
  if (!seatsOk) {
    return { feasible: false, reason: protectedWindow ? "slot_full_protected" : "slot_full", shiftAssignments: [], resourceAssignments: [] };
  }

  // —— 第 2 层：导览班次（可拆分，每个分片必须放得下）——
  // 候选集合由 failover-rules.json 驱动：故障时只取配置允许的替代规格
  const wantedModality = demand.sign ? "sign" : "standard";
  let allowedModalities = new Set([wantedModality]);
  let allowedPoolTypes = null;
  if (broken?.kind === "shift") {
    allowedModalities = new Set(
      config
        .alternativesFor("shift", broken.refId)
        .map((a) => a.modality)
        .filter(Boolean),
    );
  }
  if (broken?.kind === "pool") {
    allowedPoolTypes = new Set(
      config
        .alternativesFor("pool", broken.refId)
        .map((a) => a.type)
        .filter(Boolean),
    );
  }
  const shiftCandidates = config.catalog.shifts
    .filter((s) => allowedModalities.has(s.modality))
    .filter((s) => !(broken?.kind === "shift" && s.id === broken.refId))
    .filter((s) => !activeOutageAt(state.outages, "shift", s.id, at))
    .map((s) => ({
      shiftId: s.id,
      remaining: s.capacity - (shiftSeats.get(s.id) ?? 0),
    }))
    .sort((a, b) => b.remaining - a.remaining);

  let need = demand.partySize;
  const shiftAssignments = [];
  for (const cand of shiftCandidates) {
    if (need === 0) break;
    const seats = Math.min(cand.remaining, need);
    if (seats > 0) {
      shiftAssignments.push({ shiftId: cand.shiftId, seats });
      need -= seats;
    }
  }
  if (need > 0) {
    return {
      feasible: false,
      reason: `shift_full_${wantedModality}`,
      shiftAssignments: [],
      resourceAssignments: [],
      appliedAlternatives: broken ? config.alternativesFor(broken.kind, broken.refId) : null,
    };
  }

  // —— 第 3 层：轮椅资源池（主用优先，备用兜底；故障时按 failover 规则选池）——
  const resourceAssignments = [];
  let chairsNeeded = demand.wheelchairUnits ?? 0;
  if (chairsNeeded > 0) {
    const defaultOrder = ["wheelchair_pool", "wheelchair_reserve"];
    let pools = config.catalog.resources.filter((r) => defaultOrder.includes(r.type));
    if (allowedPoolTypes) pools = pools.filter((r) => allowedPoolTypes.has(r.type));
    pools = pools
      .filter((r) => !(broken?.kind === "pool" && r.id === broken.refId))
      .filter((r) => !activeOutageAt(state.outages, "pool", r.id, at))
      .sort(
        (a, b) =>
          defaultOrder.indexOf(a.type) - defaultOrder.indexOf(b.type) ||
          (poolUnits.get(a.id) ?? 0) - (poolUnits.get(b.id) ?? 0),
      );
    for (const pool of pools) {
      if (chairsNeeded === 0) break;
      const remaining = pool.capacity - (poolUnits.get(pool.id) ?? 0);
      const units = Math.min(remaining, chairsNeeded);
      if (units > 0) {
        resourceAssignments.push({ resourceId: pool.id, units });
        chairsNeeded -= units;
      }
    }
    if (chairsNeeded > 0) {
      // 返回可满足的部分分片，由调用方决定是否采纳并登记缺口
      return {
        feasible: false,
        reason: "wheelchair_unavailable",
        shiftAssignments,
        resourceAssignments,
        appliedAlternatives: broken ? config.alternativesFor(broken.kind, broken.refId) : null,
      };
    }
  }

  return {
    feasible: true,
    protectedWindow,
    shiftAssignments,
    resourceAssignments,
    appliedAlternatives: broken
      ? config.alternativesFor(broken.kind, broken.refId)
      : null,
  };
}

/** 暂留截止：不晚于预约关闭时刻 */
export function holdDeadline(config, slotStart, at) {
  const ttlDeadline = addMinutes(at, config.holdTtlMs / 60_000);
  const closeDeadline = new Date(slotStart.getTime() - config.bookingCloseMs - 1000);
  return ttlDeadline < closeDeadline ? ttlDeadline : closeDeadline;
}
