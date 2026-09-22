import { BookingError } from "./config.js";
import { computePlan, holdDeadline, usageAt } from "./capacity.js";
import {
  hashIdentity,
  maskIdNumber,
  randomId,
  randomToken,
  toIso,
} from "./util.js";
import { applicantView } from "./views.js";

const ACTIVE = new Set(["held", "confirmed"]);
// 占证件唯一性的状态：候补也是有效申请，避免“先候补再直约”绕过唯一约束
const LIVE = new Set(["held", "confirmed", "waitlisted"]);
const LIMITS = {
  individualMax: 7,
  groupMin: 8,
  groupMax: 40,
};

/**
 * 预约与服务协调核心。
 * 所有写操作：先在一次串行 mutate 内完成状态变更并收集待发通知，
 * 提交后再幂等发送通知 / 触发候补晋级，避免通知逻辑嵌套事务。
 */
export class BookingService {
  constructor({ config, store, notifications, catalog, clock = () => new Date(), logger = console }) {
    this.config = config;
    this.store = store;
    this.notifications = notifications;
    this.catalog = catalog;
    this.clock = clock;
    this.logger = logger;
  }

  now() {
    return this.clock();
  }

  // ---------- 基础工具 ----------

  audit(state, action, actor, detail) {
    state.auditLog.push({
      seq: state.counters.auditSeq++,
      at: this.now().toISOString(),
      action,
      actor: actor ?? null,
      ...detail,
    });
  }

  history(app, event, actor, extra = {}) {
    app.statusHistory.push({ at: this.now().toISOString(), event, actor: actor ?? null, ...extra });
  }

  enqueue(state, dueAt, type, refCode) {
    state.dueQueue.push({
      seq: state.counters.dueSeq++,
      dueAt: toIso(dueAt),
      type,
      refCode,
    });
  }

  removeDue(state, type, refCode) {
    state.dueQueue = state.dueQueue.filter((d) => !(d.type === type && d.refCode === refCode));
  }

  demandOf(app) {
    return {
      partySize: app.partySize,
      sign: Boolean(app.needs?.signLanguage),
      wheelchairUnits: app.needs?.wheelchairUnits ?? 0,
      accessible: (app.needs?.wheelchairUnits ?? 0) > 0,
    };
  }

  getApp(code) {
    const app = this.store.read((s) => s.applications[code]);
    if (!app) throw new BookingError("not_found", "预约不存在", 404);
    return app;
  }

  requireToken(app, token) {
    if (!token || token !== app.managementToken) {
      throw new BookingError("unauthorized", "管理凭证无效", 403);
    }
  }

  resolveSlot(hallId, dateStr, slotId) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? "")) {
      throw new BookingError("invalid_date", "日期格式应为 YYYY-MM-DD");
    }
    if (!hallId || !slotId) {
      throw new BookingError("missing_slot", "缺少展厅或时段");
    }
    const slot = this.catalog.resolveSlot(hallId, dateStr, slotId);
    if (!slot) {
      const info = this.catalog.dayInfo(dateStr);
      if (info.closed) throw new BookingError("slot_closed", `${dateStr} 不开放（${info.reason}）`, 409);
      throw new BookingError("slot_not_found", "时段不存在", 404);
    }
    if (Number.isNaN(slot.start.getTime())) {
      throw new BookingError("invalid_date", "日期无效");
    }
    if (this.now() >= new Date(slot.start.getTime() - this.config.bookingCloseMs)) {
      throw new BookingError("booking_closed", "该时段预约已截止", 409);
    }
    return slot;
  }

  validateParty(input) {
    const size = Number(input.partySize);
    if (!Number.isInteger(size) || size <= 0) {
      throw new BookingError("invalid_party_size", "人数必须为正整数");
    }
    if (input.applicantType === "group") {
      if (!input.orgName?.trim()) throw new BookingError("org_required", "团体预约须填写单位名称");
      if (size < LIMITS.groupMin || size > LIMITS.groupMax) {
        throw new BookingError(
          "invalid_party_size",
          `团体人数须在 ${LIMITS.groupMin}-${LIMITS.groupMax} 人之间`,
        );
      }
    } else if (size > LIMITS.individualMax) {
      throw new BookingError("invalid_party_size", `个人预约最多 ${LIMITS.individualMax} 人`);
    }
    const chairs = Number(input.needs?.wheelchairUnits ?? 0);
    if (!Number.isInteger(chairs) || chairs < 0 || chairs > size) {
      throw new BookingError("invalid_wheelchair", "轮椅数量须为不超过人数的非负整数");
    }
    return { partySize: size, wheelchairUnits: chairs, sign: Boolean(input.needs?.signLanguage) };
  }

  // ---------- 申请 ----------

  async apply(input, actor = { role: "applicant" }) {
    const demands = this.validateParty(input);
    if (!input.idNumber || !input.idType || !input.contactPhone || !input.applicantName) {
      throw new BookingError("missing_fields", "缺少姓名、证件或联系方式");
    }
    const slot = this.resolveSlot(input.hallId, input.slotDate, input.slotId);
    const now = this.now();
    const idHash = hashIdentity(input.idType, input.idNumber);

    const ctx = await this.store.mutate((state) => {
      // 同一证件同一时段仅一个有效预约
      const dup = (state.identityIndex[idHash] ?? [])
        .map((code) => state.applications[code])
        .find((a) => a.slotKey === slot.key && LIVE.has(a.status));
      if (dup) {
        throw new BookingError("duplicate_active", "该证件在该时段已有有效预约", 409, {
          existingCode: dup.code,
        });
      }

      const before = this.snapshotIn(state, slot.key);
      const demand = {
        partySize: demands.partySize,
        sign: demands.sign,
        wheelchairUnits: demands.wheelchairUnits,
        accessible: demands.wheelchairUnits > 0,
      };
      const plan = computePlan(state, this.config, slot, demand, now);

      const code = randomId("bk_");
      const app = {
        code,
        applicantType: input.applicantType === "group" ? "group" : "individual",
        applicantName: String(input.applicantName).slice(0, 50),
        orgName: input.orgName ? String(input.orgName).slice(0, 80) : null,
        idType: input.idType,
        idHash,
        idMask: maskIdNumber(String(input.idNumber)),
        contactPhone: String(input.contactPhone),
        hallId: slot.hallId,
        slotDate: slot.date,
        slotId: slot.slotId,
        slotKey: slot.key,
        slotLabel: slot.template.label,
        hallName: this.config.hallById.get(slot.hallId).name,
        slotStart: slot.start.toISOString(),
        slotEnd: slot.end.toISOString(),
        partySize: demand.partySize,
        needs: { signLanguage: demand.sign, wheelchairUnits: demand.wheelchairUnits },
        shiftAssignments: [],
        resourceAssignments: [],
        serviceAlerts: [],
        status: plan.feasible ? "held" : "waitlisted",
        waitlistRank: null,
        holdExpiresAt: null,
        waitlistExpiresAt: null,
        rescheduledFrom: null,
        managementToken: randomToken(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        statusHistory: [],
      };
      this.history(app, "created", actor, { feasibility: plan.feasible, reason: plan.reason ?? null });

      const notifications = [];
      if (plan.feasible) {
        app.shiftAssignments = plan.shiftAssignments;
        app.resourceAssignments = plan.resourceAssignments;
        const expires = holdDeadline(this.config, slot.start, now);
        app.holdExpiresAt = expires.toISOString();
        this.enqueue(state, expires, "hold_expire", code);
        notifications.push({
          key: `apply:${code}`,
          template: "application_received",
          vars: this.baseVars(app, { holdExpiresAt: app.holdExpiresAt }),
        });
      } else {
        const ttlDeadline = new Date(now.getTime() + this.config.waitlistTtlMs);
        const closeDeadline = new Date(slot.start.getTime() - this.config.bookingCloseMs - 1000);
        const expires = ttlDeadline < closeDeadline ? ttlDeadline : closeDeadline;
        app.waitlistExpiresAt = expires.toISOString();
        this.enqueue(state, expires, "waitlist_expire", code);
        notifications.push({
          key: `wladd:${code}`,
          template: "waitlist_added",
          vars: this.baseVars(app, { expiresAt: app.waitlistExpiresAt }),
        });
      }

      state.applications[code] = app;
      (state.identityIndex[idHash] ??= []).push(code);
      this.audit(state, plan.feasible ? "application_held" : "waitlist_added", actor, {
        refCode: code,
        slotKey: slot.key,
        partySize: app.partySize,
        demand: { sign: demand.sign, wheelchairUnits: demand.wheelchairUnits },
        usageBefore: before,
        usageAfter: this.snapshotIn(state, slot.key),
        plan: plan.feasible
          ? { shifts: plan.shiftAssignments, resources: plan.resourceAssignments }
          : { infeasibleReason: plan.reason },
      });
      return { app, notifications };
    });

    for (const n of ctx.notifications) {
      await this.send(n.key, n.template, n.vars, ctx.app);
    }
    return { application: applicantView(ctx.app, this.config), managementToken: ctx.app.managementToken };
  }

  // ---------- 确认 ----------

  async confirm(code, token, actor = { role: "applicant" }) {
    const app = this.getApp(code);
    this.requireToken(app, token);
    if (!ACTIVE.has(app.status) && app.status !== "waitlisted") {
      throw new BookingError("invalid_status", `当前状态 ${app.status} 不可确认`, 409);
    }
    if (app.status === "waitlisted") {
      throw new BookingError("still_waitlisted", "仍在候补中，晋级后方可确认", 409);
    }
    if (app.status === "confirmed") {
      return { application: applicantView(app, this.config), idempotent: true };
    }
    const ctx = await this.store.mutate((state) => {
      const cur = state.applications[code];
      const before = this.snapshotIn(state, cur.slotKey);
      cur.status = "confirmed";
      cur.updatedAt = this.now().toISOString();
      cur.holdExpiresAt = null;
      this.removeDue(state, "hold_expire", code);
      this.history(cur, "confirmed", actor);
      this.audit(state, "reservation_confirmed", actor, {
        refCode: code,
        slotKey: cur.slotKey,
        usageBefore: before,
        usageAfter: this.snapshotIn(state, cur.slotKey),
      });
      return {
        app: cur,
        notifications: [
          { key: `confirm:${code}`, template: "reservation_confirmed", vars: this.baseVars(cur) },
        ],
      };
    });
    for (const n of ctx.notifications) await this.send(n.key, n.template, n.vars, ctx.app);
    return { application: applicantView(ctx.app, this.config) };
  }

  // ---------- 取消（自助 / 管理代客，同一套幂等逻辑） ----------

  async cancel(code, token, actor = { role: "applicant" }) {
    const app = this.getApp(code);
    if (actor.role === "applicant") this.requireToken(app, token);
    if (app.status === "cancelled" || app.status === "expired") {
      return { application: applicantView(app, this.config), idempotent: true };
    }
    const oldSlotKey = app.slotKey;
    const wasActive = ACTIVE.has(app.status);
    const ctx = await this.store.mutate((state) => {
      const cur = state.applications[code];
      const before = this.snapshotIn(state, oldSlotKey);
      cur.status = "cancelled";
      cur.updatedAt = this.now().toISOString();
      cur.holdExpiresAt = null;
      cur.waitlistExpiresAt = null;
      this.removeDue(state, "hold_expire", code);
      this.removeDue(state, "waitlist_expire", code);
      this.history(cur, "cancelled", actor, { reason: actor.reason ?? "user_requested" });
      this.audit(state, "reservation_cancelled", actor, {
        refCode: code,
        slotKey: oldSlotKey,
        freedSeats: wasActive ? cur.partySize : 0,
        usageBefore: before,
        usageAfter: this.snapshotIn(state, oldSlotKey),
      });
      return {
        app: cur,
        notifications: [
          { key: `cancel:${code}`, template: "reservation_cancelled", vars: this.baseVars(cur) },
        ],
      };
    });
    for (const n of ctx.notifications) await this.send(n.key, n.template, n.vars, ctx.app);
    if (wasActive) await this.runPromotions(oldSlotKey);
    return { application: applicantView(ctx.app, this.config) };
  }

  // ---------- 改期（目标时段满则拒绝且保留原预约） ----------

  async reschedule(code, token, body, actor = { role: "applicant" }) {
    const app = this.getApp(code);
    if (actor.role === "applicant") this.requireToken(app, token);
    if (!ACTIVE.has(app.status) && app.status !== "waitlisted") {
      throw new BookingError("invalid_status", `当前状态 ${app.status} 不可改期`, 409);
    }
    const target = this.resolveSlot(body.hallId ?? app.hallId, body.slotDate, body.slotId);
    if (target.key === app.slotKey) {
      throw new BookingError("same_slot", "目标时段与当前时段相同", 409);
    }
    const now = this.now();
    const oldSlotKey = app.slotKey;
    const wasActive = ACTIVE.has(app.status);

    const ctx = await this.store.mutate((state) => {
      const cur = state.applications[code];
      const dup = (state.identityIndex[cur.idHash] ?? [])
        .map((c) => state.applications[c])
        .find((a) => a.slotKey === target.key && LIVE.has(a.status) && a.code !== code);
      if (dup) {
        throw new BookingError("duplicate_active", "该证件在目标时段已有有效预约", 409);
      }
      const plan = computePlan(state, this.config, target, this.demandOf(cur), now);
      if (!plan.feasible) {
        // 不触动原预约，由申请人决定是否取消或候补
        throw new BookingError("target_full", `目标时段无法容纳（${plan.reason}），原预约保留`, 409, {
          reason: plan.reason,
        });
      }

      const beforeOld = this.snapshotIn(state, oldSlotKey);
      const beforeNew = this.snapshotIn(state, target.key);
      const snapshot = {
        slotKey: cur.slotKey,
        slotLabel: `${cur.slotDate} ${cur.slotLabel}`,
        shiftAssignments: cur.shiftAssignments,
        resourceAssignments: cur.resourceAssignments,
        status: cur.status,
      };
      this.removeDue(state, "hold_expire", code);
      this.removeDue(state, "waitlist_expire", code);

      cur.hallId = target.hallId;
      cur.slotDate = target.date;
      cur.slotId = target.slotId;
      cur.slotKey = target.key;
      cur.slotLabel = target.template.label;
      cur.hallName = this.config.hallById.get(target.hallId).name;
      cur.slotStart = target.start.toISOString();
      cur.slotEnd = target.end.toISOString();
      cur.shiftAssignments = plan.shiftAssignments;
      cur.resourceAssignments = plan.resourceAssignments;
      cur.serviceAlerts = [];
      cur.rescheduledFrom = snapshot;
      cur.updatedAt = now.toISOString();

      // 已确认者直接落入新时段；暂留/候补者在新时段重新暂留待确认
      if (cur.status === "confirmed") {
        cur.holdExpiresAt = null;
      } else {
        const expires = holdDeadline(this.config, target.start, now);
        cur.status = "held";
        cur.holdExpiresAt = expires.toISOString();
        cur.waitlistExpiresAt = null;
        cur.waitlistRank = null;
        this.enqueue(state, expires, "hold_expire", code);
      }
      this.history(cur, "rescheduled", actor, { from: snapshot.slotKey, to: target.key });
      this.audit(state, "reservation_rescheduled", actor, {
        refCode: code,
        fromSlotKey: oldSlotKey,
        toSlotKey: target.key,
        usageBeforeOld: beforeOld,
        usageAfterOld: this.snapshotIn(state, oldSlotKey),
        usageBeforeNew: beforeNew,
        usageAfterNew: this.snapshotIn(state, target.key),
        plan: { shifts: plan.shiftAssignments, resources: plan.resourceAssignments },
      });
      return {
        app: cur,
        notifications: [
          {
            key: `resched:${code}:${target.key}`,
            template: "reservation_rescheduled",
            vars: this.baseVars(cur, {
              oldSlotLabel: snapshot.slotLabel,
              newSlotLabel: `${cur.slotDate} ${cur.slotLabel}`,
              statusText: cur.status === "confirmed" ? "已确认" : "待确认",
            }),
          },
        ],
      };
    });
    for (const n of ctx.notifications) await this.send(n.key, n.template, n.vars, ctx.app);
    if (wasActive) await this.runPromotions(oldSlotKey);
    return { application: applicantView(ctx.app, this.config) };
  }

  // ---------- 到期处理（幂等，重启后按原截止时间补偿） ----------

  async expireHold(code) {
    const exists = this.store.read((s) => s.applications[code]);
    if (!exists) return;
    if (exists.status !== "held") {
      await this.store.mutate((state) => this.removeDue(state, "hold_expire", code));
      return;
    }
    const slotKey = exists.slotKey;
    const ctx = await this.store.mutate((state) => {
      const cur = state.applications[code];
      if (cur.status !== "held") {
        this.removeDue(state, "hold_expire", code);
        return null;
      }
      const before = this.snapshotIn(state, slotKey);
      cur.status = "expired";
      cur.holdExpiresAt = null;
      cur.updatedAt = this.now().toISOString();
      this.removeDue(state, "hold_expire", code);
      this.history(cur, "hold_expired", { role: "system" });
      this.audit(state, "hold_expired", { role: "system" }, {
        refCode: code,
        slotKey,
        freedSeats: cur.partySize,
        usageBefore: before,
        usageAfter: this.snapshotIn(state, slotKey),
      });
      return {
        app: cur,
        notifications: [
          {
            key: `holdexp:${code}`,
            template: "hold_expired",
            vars: this.baseVars(cur, { holdExpiresAt: cur.updatedAt }),
          },
        ],
      };
    });
    if (!ctx) return;
    for (const n of ctx.notifications) await this.send(n.key, n.template, n.vars, ctx.app);
    await this.runPromotions(slotKey);
  }

  async expireWaitlist(code) {
    const exists = this.store.read((s) => s.applications[code]);
    if (!exists) return;
    if (exists.status !== "waitlisted") {
      await this.store.mutate((state) => this.removeDue(state, "waitlist_expire", code));
      return;
    }
    const ctx = await this.store.mutate((state) => {
      const cur = state.applications[code];
      if (cur.status !== "waitlisted") {
        this.removeDue(state, "waitlist_expire", code);
        return null;
      }
      cur.status = "expired";
      cur.waitlistExpiresAt = null;
      cur.waitlistRank = null;
      cur.updatedAt = this.now().toISOString();
      this.removeDue(state, "waitlist_expire", code);
      this.history(cur, "waitlist_expired", { role: "system" });
      this.audit(state, "waitlist_expired", { role: "system" }, { refCode: code, slotKey: cur.slotKey });
      // 过期不释放任何名额，也不触发晋级
      return {
        app: cur,
        notifications: [
          {
            key: `wlexp:${code}`,
            template: "waitlist_expired",
            vars: this.baseVars(cur, { expiresAt: cur.updatedAt }),
          },
        ],
      };
    });
    if (!ctx) return;
    for (const n of ctx.notifications) await this.send(n.key, n.template, n.vars, ctx.app);
  }

  // ---------- 候补晋级 ----------

  /**
   * 反复扫描候补队列：无障碍需求优先，其后按申请时间 FIFO。
   * 只依据“当前真实空闲容量”分配；已暂留/已确认名额从不被触动。
   * 前一名因单项资源（如轮椅池）不足放不下时，跳过但保留其名次。
   */
  async runPromotions(key) {
    // 容量先用于兑现已确认者曾被故障剥除的服务承诺，再考虑候补晋级
    await this.retrySkippedForSlot(key);
    for (;;) {
      const promoted = await this.tryPromoteOne(key);
      if (!promoted) break;
    }
  }

  /** 重试恢复时容量不足、被标记为 unsatisfied 的服务承诺；容量再次释放时调用 */
  async retrySkippedForSlot(key) {
    for (;;) {
      const now = this.now();
      const ctx = await this.store.mutate((state) => {
        const targets = Object.values(state.applications).filter(
          (a) =>
            ACTIVE.has(a.status) &&
            a.slotKey === key &&
            a.serviceAlerts.some((x) => x.status === "unsatisfied"),
        );
        for (const target of targets) {
          const slot = this.catalog.resolveSlot(target.hallId, target.slotDate, target.slotId);
          const plan = computePlan(state, this.config, slot, this.demandOf(target), now);
          const alerts = target.serviceAlerts.filter((x) => x.status === "unsatisfied");
          if (!plan.feasible) {
            alerts.forEach((x) => {
              x.skippedReason = plan.reason;
              x.restoreAttemptedAt = now.toISOString();
            });
            continue; // 小需求的其他当事人可能仍可恢复，继续扫描
          }
          const from = this.describeAssignments(target);
          target.shiftAssignments = plan.shiftAssignments;
          target.resourceAssignments = plan.resourceAssignments;
          alerts.forEach((x) => {
            x.status = "restored";
            x.restoredAt = now.toISOString();
          });
          target.updatedAt = now.toISOString();
          this.history(target, "service_restored", { role: "system" });
          this.audit(state, "service_restored", { role: "system" }, {
            refCode: target.code,
            slotKey: key,
            from,
            to: this.describeAssignments(target),
          });
          return { app: target, to: this.describeAssignments(target), outageId: alerts[0]?.outageId };
        }
        return null;
      });
      if (!ctx) break;
      await this.send(
        `svcrest:${ctx.app.code}:${ctx.outageId ?? "retry"}`,
        "service_restored",
        this.baseVars(ctx.app, { newService: this.flatDesc(ctx.to) }),
        ctx.app,
      );
    }
  }

  async tryPromoteOne(key) {
    const now = this.now();
    const ctx = await this.store.mutate((state) => {
      const waiting = Object.values(state.applications)
        .filter((a) => a.status === "waitlisted" && a.slotKey === key)
        .filter((a) => new Date(a.waitlistExpiresAt) > now)
        .filter((a) => {
          // 预约关闭后不再晋级（避免"晋级即到期"的空转）
          const slot0 = this.catalog.resolveSlot(a.hallId, a.slotDate, a.slotId);
          return slot0 && now < new Date(slot0.start.getTime() - this.config.bookingCloseMs);
        })
        .sort((a, b) => {
          const pa = a.needs.signLanguage || a.needs.wheelchairUnits > 0 ? 1 : 0;
          const pb = b.needs.signLanguage || b.needs.wheelchairUnits > 0 ? 1 : 0;
          if (pa !== pb) return pb - pa;
          return new Date(a.createdAt) - new Date(b.createdAt);
        });

      let rank = 0;
      for (const candidate of waiting) {
        rank += 1;
        candidate.waitlistRank = rank;
      }

      for (const candidate of waiting) {
        const targetSlot = this.slotFromApp(state, candidate);
        const plan = computePlan(state, this.config, targetSlot, this.demandOf(candidate), now);
        if (!plan.feasible) continue;
        const before = this.snapshotIn(state, key);
        const expires = holdDeadline(this.config, targetSlot.start, now);
        candidate.status = "held";
        candidate.shiftAssignments = plan.shiftAssignments;
        candidate.resourceAssignments = plan.resourceAssignments;
        candidate.holdExpiresAt = expires.toISOString();
        candidate.waitlistExpiresAt = null;
        candidate.waitlistRank = null;
        candidate.updatedAt = now.toISOString();
        this.removeDue(state, "waitlist_expire", candidate.code);
        this.enqueue(state, expires, "hold_expire", candidate.code);
        this.history(candidate, "waitlist_promoted", { role: "system" });
        this.audit(state, "waitlist_promoted", { role: "system" }, {
          refCode: candidate.code,
          slotKey: key,
          partySize: candidate.partySize,
          usageBefore: before,
          usageAfter: this.snapshotIn(state, key),
          plan: { shifts: plan.shiftAssignments, resources: plan.resourceAssignments },
        });
        return {
          app: candidate,
          notifications: [
            {
              key: `promote:${candidate.code}`,
              template: "waitlist_promoted",
              vars: this.baseVars(candidate, { holdExpiresAt: candidate.holdExpiresAt }),
            },
          ],
        };
      }
      return null;
    });
    if (!ctx) return false;
    for (const n of ctx.notifications) await this.send(n.key, n.template, n.vars, ctx.app);
    return true;
  }

  slotFromApp(state, app) {
    if (!app) return null;
    return this.catalog.resolveSlot(app.hallId, app.slotDate, app.slotId);
  }

  /** 候补名次按当前队列实时计算：无障碍需求优先，其后按申请时间 */
  computeWaitlistRank(app) {
    if (app.status !== "waitlisted") return null;
    const now = this.now();
    const waiting = this.store
      .read((s) =>
        Object.values(s.applications)
          .filter((a) => a.status === "waitlisted" && a.slotKey === app.slotKey)
          .filter((a) => new Date(a.waitlistExpiresAt) > now)
          .sort((a, b) => {
            const pa = a.needs.signLanguage || a.needs.wheelchairUnits > 0 ? 1 : 0;
            const pb = b.needs.signLanguage || b.needs.wheelchairUnits > 0 ? 1 : 0;
            if (pa !== pb) return pb - pa;
            return new Date(a.createdAt) - new Date(b.createdAt);
          }),
      );
    const index = waiting.findIndex((a) => a.code === app.code);
    return index === -1 ? null : index + 1;
  }

  // ---------- 资源故障与重分配 ----------

  async reportOutage(body, actor = { role: "admin" }) {
    const kind = body.kind === "shift" || body.kind === "pool" ? body.kind : null;
    if (!kind) throw new BookingError("invalid_outage", "kind 必须为 shift 或 pool");
    const label = kind === "shift"
      ? this.config.shiftById.get(body.refId)?.label
      : this.config.resourceById.get(body.refId)?.label;
    if (!label) throw new BookingError("not_found", "故障对象不存在", 404);
    let activeUntil = null;
    if (body.activeUntil != null) {
      activeUntil = new Date(body.activeUntil);
      if (Number.isNaN(activeUntil.getTime())) {
        throw new BookingError("invalid_time", "activeUntil 不是有效时间");
      }
      if (activeUntil <= this.now()) {
        throw new BookingError("invalid_time", "预计恢复时间必须晚于当前时间");
      }
      activeUntil = activeUntil.toISOString();
    }

    const now = this.now();
    const ctx = await this.store.mutate((state) => {
      const outage = {
        id: randomId("out_"),
        kind,
        refId: body.refId,
        label,
        reason: String(body.reason ?? "临时故障").slice(0, 120),
        status: "active",
        startedAt: now.toISOString(),
        activeUntil,
        resolvedAt: null,
      };
      state.outages.push(outage);
      this.audit(state, "outage_reported", actor, {
        outageId: outage.id,
        kind,
        refId: body.refId,
        activeUntil: outage.activeUntil,
        reason: outage.reason,
      });
      if (outage.activeUntil) {
        this.enqueue(state, new Date(outage.activeUntil), "outage_restore", outage.id);
      }
      return { outage };
    });

    await this.reassignForOutage(ctx.outage, actor);
    return { outage: ctx.outage };
  }

  /** 故障发生后：按 failover 规则重新分配；无法替代时保留名额、仅标记服务不可用 */
  async reassignForOutage(outage, actor) {
    const now = this.now();
    const results = [];

    for (;;) {
      const ctx = await this.store.mutate((state) => {
        const target = Object.values(state.applications).find((a) => {
          if (!ACTIVE.has(a.status)) return false;
          if (new Date(a.slotStart) <= now) return false;
          if (a.serviceAlerts.some((x) => x.outageId === outage.id)) return false;
          const list = outage.kind === "shift" ? a.shiftAssignments : a.resourceAssignments;
          return list.some((x) => (outage.kind === "shift" ? x.shiftId : x.resourceId) === outage.refId);
        });
        if (!target) return null;

        const slot = this.catalog.resolveSlot(target.hallId, target.slotDate, target.slotId);
        const plan = computePlan(state, this.config, slot, this.demandOf(target), now, {
          kind: outage.kind,
          refId: outage.refId,
        });
        const oldDesc = this.describeAssignments(target);
        const changes = [];

        if (plan.feasible) {
          target.shiftAssignments = plan.shiftAssignments;
          target.resourceAssignments = plan.resourceAssignments;
          target.serviceAlerts.push({
            outageId: outage.id,
            kind: outage.kind,
            changeType: "reassigned",
            status: "active",
            label: outage.label,
            reason: outage.reason,
            createdAt: now.toISOString(),
          });
          changes.push({ type: "reassigned", from: oldDesc, to: this.describeAssignments(target) });
        } else {
          // 无完整替代方案：时段名额保留；能落到其他班次/资源池的分片照常采纳，
          // 无法满足的剩余部分摘除承诺并登记告警
          target.shiftAssignments = plan.shiftAssignments;
          target.resourceAssignments = plan.resourceAssignments;
          target.serviceAlerts.push({
            outageId: outage.id,
            kind: outage.kind,
            changeType: "unavailable",
            status: "active",
            label: outage.label,
            reason: outage.reason,
            infeasibleReason: plan.reason,
            createdAt: now.toISOString(),
          });
          changes.push({ type: "service_unavailable", from: oldDesc, to: this.describeAssignments(target) });
        }
        target.updatedAt = now.toISOString();
        this.history(target, "service_reassigned", actor, { outageId: outage.id, changes });
        this.audit(state, changes[0].type === "reassigned" ? "service_reassigned" : "service_unavailable",
          actor, {
            refCode: target.code,
            outageId: outage.id,
            slotKey: target.slotKey,
            changes,
            failoverRule: plan.appliedAlternatives,
            infeasibleReason: plan.feasible ? null : plan.reason,
          });
        return { app: target, changes, outage };
      });

      if (!ctx) break;
      const changed = ctx.changes[0];
      const template = changed.type === "reassigned" ? "service_changed" : "service_unavailable";
      const key = `${changed.type === "reassigned" ? "svcchg" : "svcunavail"}:${ctx.app.code}:${outage.id}`;
      await this.send(
        key,
        template,
        this.baseVars(ctx.app, {
          reason: outage.reason,
          oldService: this.flatDesc(changed.from),
          newService: changed.type === "reassigned" ? this.flatDesc(changed.to) : "（暂无可替代安排）",
        }),
        ctx.app,
      );
      results.push({ code: ctx.app.code, type: changed.type });
    }
    return results;
  }

  /** 故障恢复：补登记此前不可用的服务（按新容量），其余安排保持稳定，再跑候补晋级 */
  async restoreOutage(outageId, actor = { role: "system" }) {
    const now = this.now();
    const slotKeys = new Set();
    const outage = this.store.read((s) => s.outages.find((o) => o.id === outageId));
    if (!outage) throw new BookingError("not_found", "故障记录不存在", 404);

    // 一次性解除故障状态（审计仅一条）
    await this.store.mutate((state) => {
      const out = state.outages.find((o) => o.id === outageId);
      if (out?.status === "active") {
        out.status = "resolved";
        out.resolvedAt = now.toISOString();
        this.removeDue(state, "outage_restore", outageId);
        this.audit(state, "outage_resolved", actor, { outageId });
      }
    });

    // 逐个处理受影响申请：能补登的恢复承诺，仍放不下的转为 unsatisfied 待容量释放后重试
    for (;;) {
      const ctx = await this.store.mutate((state) => {
        const target = Object.values(state.applications).find(
          (a) => ACTIVE.has(a.status) && a.serviceAlerts.some((x) => x.outageId === outageId && x.status === "active"),
        );
        if (!target) return null;
        const slot = this.catalog.resolveSlot(target.hallId, target.slotDate, target.slotId);
        const plan = computePlan(state, this.config, slot, this.demandOf(target), now);
        const alerts = target.serviceAlerts.filter((x) => x.outageId === outageId && x.status === "active");
        if (!plan.feasible) {
          alerts.forEach((x) => {
            x.status = "unsatisfied";
            x.skippedReason = plan.reason;
            x.restoreAttemptedAt = now.toISOString();
          });
          return { app: target, restored: false };
        }
        const before = this.describeAssignments(target);
        target.shiftAssignments = plan.shiftAssignments;
        target.resourceAssignments = plan.resourceAssignments;
        alerts.forEach((x) => {
          x.status = "restored";
          x.restoredAt = now.toISOString();
        });
        target.updatedAt = now.toISOString();
        this.history(target, "service_restored", actor, { outageId });
        this.audit(state, "service_restored", actor, {
          refCode: target.code,
          outageId,
          slotKey: target.slotKey,
          from: before,
          to: this.describeAssignments(target),
        });
        return { app: target, restored: true, to: this.describeAssignments(target) };
      });

      if (!ctx) break;
      slotKeys.add(ctx.app.slotKey);
      if (ctx.restored) {
        await this.send(
          `svcrest:${ctx.app.code}:${outageId}`,
          "service_restored",
          this.baseVars(ctx.app, { newService: this.flatDesc(ctx.to) }),
          ctx.app,
        );
      }
    }
    for (const key of slotKeys) await this.runPromotions(key);
    return { outageId, resolved: true };
  }

  // ---------- 查询辅助 ----------

  snapshotIn(state, key) {
    const { totalUsed, shiftSeats, poolUnits } = usageAt(state, this.config, key, this.now());
    return {
      at: this.now().toISOString(),
      seats: totalUsed,
      byShift: Object.fromEntries(shiftSeats),
      byPool: Object.fromEntries(poolUnits),
    };
  }

  describeAssignments(app) {
    const shifts = (app.shiftAssignments ?? []).map((a) => ({
      kind: "shift",
      label: this.config.shiftById.get(a.shiftId)?.label ?? a.shiftId,
      seats: a.seats,
    }));
    const resources = (app.resourceAssignments ?? []).map((a) => ({
      kind: "resource",
      label: this.config.resourceById.get(a.resourceId)?.label ?? a.resourceId,
      units: a.units,
    }));
    return [...shifts, ...resources];
  }

  flatDesc(desc) {
    if (!desc || desc.length === 0) return "无附加服务";
    return desc
      .map((d) => (d.kind === "shift" ? `${d.label} ${d.seats}人` : `${d.label} ×${d.units}`))
      .join("、");
  }

  baseVars(app, extra = {}) {
    return {
      name: app.applicantName,
      code: app.code,
      hall: app.hallName,
      slotLabel: `${app.slotDate} ${app.slotLabel}`,
      partySize: app.partySize,
      ...extra,
    };
  }

  async send(key, template, vars, app) {
    await this.notifications.send(key, {
      template,
      vars,
      to: app.contactPhone,
      refCode: app.code,
      category: template,
    });
  }

  /** 一线人员通过系统联系观众：不向工作人员暴露手机号，内容不含需求细节 */
  async sendStaffNudge(app, message, actor) {
    if (!ACTIVE.has(app.status) && app.status !== "waitlisted") {
      throw new BookingError("invalid_status", "该申请已结束，无需联系", 409);
    }
    const key = `nudge:${app.code}:${this.now().getTime()}`;
    const result = await this.notifications.send(key, {
      template: "staff_nudge",
      vars: this.baseVars(app),
      to: app.contactPhone,
      refCode: app.code,
      category: "staff_nudge",
    });
    await this.store.mutate((state) => {
      this.audit(state, "staff_nudge", actor, {
        refCode: app.code,
        slotKey: app.slotKey,
        notificationId: result.record.id,
      });
    });
    return result;
  }

  /** 立即补偿执行所有已到期任务（调度器每个 tick 做的事，供管理接口/测试调用） */
  async runDueNow() {
    const due = this.store.read((s) =>
      s.dueQueue
        .filter((item) => new Date(item.dueAt) <= this.now())
        .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt) || a.seq - b.seq)
        .map((item) => ({ ...item })),
    );
    const ran = [];
    for (const item of due) {
      if (item.type === "hold_expire") {
        await this.expireHold(item.refCode);
        ran.push(item);
      } else if (item.type === "waitlist_expire") {
        await this.expireWaitlist(item.refCode);
        ran.push(item);
      } else if (item.type === "outage_restore") {
        try {
          await this.restoreOutage(item.refCode);
          ran.push(item);
        } catch {
          // 故障记录缺失等异常时忽略，避免阻塞其他任务
        }
      }
    }
    return ran;
  }
}
