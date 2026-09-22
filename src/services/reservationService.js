import { timingSafeEqual } from "node:crypto";
import { randomId, shortReference, manageToken, hashDocument, maskPhone } from "../util/ids.js";
import {
  APPLICATION_STATUS,
  isActiveStatus,
  partyBounds,
  ts,
  waitlistExpiry,
  noShowReleaseAt,
  canSelfCancel,
  canSelfReschedule,
} from "../domain/policy.js";

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const ACTIVE_ALLOCATION = "ASSIGNED";

/**
 * 预约与服务协调核心服务。
 * 不变量：
 *  1. 同一证件在同一时段至多一个有效预约（CONFIRMED/WAITLISTED）。
 *  2. 团体按整团人数原子占座，任何拆分/部分确认都不得突破时段容量。
 *  3. 候补只在已确认名额释放后晋级，过期候补（超过截止时间）永不晋级。
 *  4. 无障碍资源（轮椅/手语译员）独立于入场容量计数，故障时按
 *     “同类改派 → 服务候补 → 明确无法安排”的顺序处理，并解释变更。
 */
export class ReservationService {
  constructor(store, notifications, audit, clock = () => new Date().toISOString()) {
    this.store = store;
    this.notifications = notifications;
    this.audit = audit;
    this.clock = clock;
    if (!store.state.counters) store.state.counters = { waitlistSeq: 0 };
  }

  // ---------------- 查询 ----------------

  listPublicSlots(date) {
    const state = this.store.state;
    return state.slots
      .filter((slot) => !date || slot.date === date)
      .map((slot) => {
        const confirmed = this.#confirmedSeats(slot.id);
        return {
          id: slot.id,
          date: slot.date,
          label: slot.label,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          status: slot.status,
          closureReason: slot.closureReason,
          capacity: slot.capacity,
          occupied: confirmed,
          available: Math.max(0, slot.capacity - confirmed),
          waitlist: this.#waitlisted(slot.id).length,
          services: this.#serviceSummary(slot.id),
        };
      })
      .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
  }

  getSlot(slotId) {
    const slot = this.store.state.slots.find((item) => item.id === slotId);
    if (!slot) throw new ApiError(404, "SLOT_NOT_FOUND", "时段不存在");
    return slot;
  }

  listTours(slotId) {
    const tours = this.store.state.tourSchedules.filter((tour) => !slotId || tour.slotId === slotId);
    return tours.map((tour) => {
      const resource = this.store.state.resources.find((item) => item.id === tour.interpreterResourceId);
      const used = this.#activeApps(tour.slotId)
        .flatMap((app) => app.allocations)
        .filter((allocation) => allocation.status === ACTIVE_ALLOCATION && allocation.tourScheduleId === tour.id).length;
      return {
        id: tour.id,
        slotId: tour.slotId,
        startsAt: tour.startsAt,
        endsAt: tour.endsAt,
        headsetCapacity: tour.headsetCapacity,
        headsetsUsed: used,
        headsetsAvailable: resource?.status === "ACTIVE" ? Math.max(0, tour.headsetCapacity - used) : 0,
        interpreterStatus: resource?.status ?? "MISSING",
      };
    });
  }

  // ---------------- 申请 ----------------

  book(input, actor = { role: "public" }) {
    const at = this.clock();
    const kind = input.kind === "GROUP" ? "GROUP" : "INDIVIDUAL";
    const partySize = Number(input.partySize);
    const bounds = partyBounds(kind);
    if (!Number.isInteger(partySize) || partySize < bounds.min || partySize > bounds.max) {
      throw new ApiError(400, "INVALID_PARTY_SIZE", `${kind === "GROUP" ? "团体" : "个人"}人数须为 ${bounds.min}-${bounds.max} 人`);
    }
    if (!input.idDocument || String(input.idDocument).trim().length < 4) {
      throw new ApiError(400, "INVALID_DOCUMENT", "证件信息无效");
    }
    if (!input.contactPhone || String(input.contactPhone).replace(/\D/g, "").length < 7) {
      throw new ApiError(400, "INVALID_CONTACT", "联系电话无效");
    }
    const slot = this.getSlot(input.slotId);
    if (slot.status !== "OPEN") {
      throw new ApiError(409, "SLOT_CLOSED", "该时段因闭馆安排不开放预约", { reason: slot.closureReason });
    }
    if (ts(slot.startsAt) <= ts(at)) {
      throw new ApiError(409, "SLOT_STARTED", "该时段已开始，无法预约");
    }

    const serviceTypes = this.#validateServiceTypes(input.serviceTypes);
    const documentHash = hashDocument(input.idDocument);
    const duplicate = this.store.state.applications.find(
      (app) => app.slotId === slot.id && app.documentHash === documentHash && isActiveStatus(app.status),
    );
    if (duplicate) {
      // 不回显他人预约编号等信息，仅告知该证件已有有效预约。
      throw new ApiError(409, "DUPLICATE_ACTIVE_APPLICATION", "该证件在该时段已有有效预约");
    }

    const free = slot.capacity - this.#confirmedSeats(slot.id);
    const confirmed = free >= partySize;
    const token = manageToken();
    const application = {
      id: randomId("app"),
      reference: shortReference(),
      kind,
      partySize,
      slotId: slot.id,
      documentHash,
      contactName: input.contactName ? String(input.contactName).slice(0, 50) : null,
      contactMasked: maskPhone(input.contactPhone),
      status: confirmed ? APPLICATION_STATUS.CONFIRMED : APPLICATION_STATUS.WAITLISTED,
      accessiblePriority: serviceTypes.length > 0,
      serviceRequests: serviceTypes,
      allocations: [],
      manageTokenHash: hashDocument(token),
      createdAt: at,
      updatedAt: at,
      waitlistRank: null,
      waitlistExpiresAt: null,
      noShowReleaseAt: noShowReleaseAt(slot, this.store.state.policy),
      rescheduleSeq: 0,
      serviceNoticeSeq: {},
      history: [],
      cancellation: null,
    };

    if (confirmed) {
      for (const type of serviceTypes) this.#assignOrQueueService(application, type, at);
    } else {
      this.store.state.counters.waitlistSeq += 1;
      application.waitlistRank = this.store.state.counters.waitlistSeq;
      application.waitlistExpiresAt = waitlistExpiry(slot, this.store.state.policy);
      for (const type of serviceTypes) {
        application.allocations.push(this.#allocation(type, "PENDING"));
      }
    }

    this.store.state.applications.push(application);
    this.audit.record("APPLICATION", confirmed ? "BOOKING_CONFIRMED" : "BOOKING_WAITLISTED", {
      applicationId: application.id,
      slotId: slot.id,
      kind,
      partySize,
      accessiblePriority: application.accessiblePriority,
    }, { applicationId: application.id, slotId: slot.id, actor });

    if (confirmed) {
      this.notifications.notify({
        applicationId: application.id,
        type: "CONFIRMED",
        context: { slot, kind, partySize },
        dedupeKey: "lifecycle:CONFIRMED",
        recipient: application.contactMasked,
        actor,
      });
      this.#notifyQueuedServices(application, slot, actor);
    } else {
      this.notifications.notify({
        applicationId: application.id,
        type: "WAITLISTED",
        context: { slot, kind, partySize },
        dedupeKey: "lifecycle:WAITLISTED",
        recipient: application.contactMasked,
        actor,
      });
    }

    this.store.save();
    return { application: this.#selfView(application), manageToken: token };
  }

  // ---------------- 观众自助（凭管理令牌，不暴露敏感细节给他人） ----------------

  updateSelf(reference, token, input = {}) {
    const at = this.clock();
    const application = this.#authenticate(reference, token);
    const slot = this.getSlot(application.slotId);
    if (!isActiveStatus(application.status)) {
      throw new ApiError(409, "NOT_MODIFIABLE", `当前状态 ${application.status} 不可修改`);
    }
    if (ts(slot.startsAt) <= ts(at)) {
      throw new ApiError(409, "SLOT_STARTED", "时段已开始，不可修改预约");
    }

    let changed = false;
    if (input.partySize !== undefined) {
      const nextSize = Number(input.partySize);
      const bounds = partyBounds(application.kind);
      if (!Number.isInteger(nextSize) || nextSize < bounds.min || nextSize > bounds.max) {
        throw new ApiError(400, "INVALID_PARTY_SIZE", `人数须为 ${bounds.min}-${bounds.max} 人`);
      }
      if (application.status === APPLICATION_STATUS.CONFIRMED) {
        // 增加人数必须当场放得下（按不含本预约的口径），放不下则拒绝而不是降级为候补。
        const seatsOthers = this.#confirmedSeats(slot.id, { excludeApplicationId: application.id });
        if (seatsOthers + nextSize > slot.capacity) {
          throw new ApiError(409, "INSUFFICIENT_CAPACITY", "调整后人数超出时段剩余名额");
        }
      }
      if (nextSize !== application.partySize) {
        application.partySize = nextSize;
        changed = true;
      }
    }

    if (input.serviceTypes !== undefined) {
      const nextTypes = this.#validateServiceTypes(input.serviceTypes);
      const kept = [];
      // 移除不再需要的服务承诺；保留仍需要的既有分配。
      for (const allocation of application.allocations) {
        if (nextTypes.includes(allocation.type)) {
          kept.push(allocation);
        } else {
          this.audit.record("SERVICE_COMMITMENT", "SERVICE_RELEASED", {
            applicationId: application.id,
            type: allocation.type,
            resourceId: allocation.resourceId,
            tourScheduleId: allocation.tourScheduleId,
            reason: "SELF_UPDATE",
          }, { applicationId: application.id, slotId: slot.id, actor: { role: "public" } });
          changed = true;
        }
      }
      application.allocations = kept;
      // 新增的服务：已确认立即尝试分配，候补期间保持待定。
      for (const type of nextTypes) {
        if (application.allocations.some((allocation) => allocation.type === type)) continue;
        if (application.status === APPLICATION_STATUS.CONFIRMED) {
          this.#assignOrQueueService(application, type, at);
        } else {
          application.allocations.push(this.#allocation(type, "PENDING"));
        }
        changed = true;
      }
      application.serviceRequests = nextTypes;
      application.accessiblePriority = nextTypes.length > 0;
    }

    if (!changed) return this.#selfView(application);

    application.updatedAt = at;
    application.history.push({ at, reason: "SELF_UPDATED" });
    this.audit.record("APPLICATION", "APPLICATION_UPDATED", {
      applicationId: application.id,
      slotId: slot.id,
      partySize: application.partySize,
      serviceTypes: application.serviceRequests,
    }, { applicationId: application.id, slotId: slot.id, actor: { role: "public" } });

    if (application.status === APPLICATION_STATUS.CONFIRMED) {
      this.#notifyQueuedServices(application, slot, { role: "public" });
      this.#fillServiceWaitlists(at, { role: "public" });
    }
    // 候补人数变小可能正好空出整团空间：尝试推进（含其自身）。
    this.#promoteWaitlist(slot, at);
    this.store.save();
    return this.#selfView(application);
  }

  #authenticate(reference, token) {
    const application = this.store.state.applications.find((item) => item.reference === reference);
    if (!application) throw new ApiError(404, "APPLICATION_NOT_FOUND", "预约不存在");
    const expected = application.manageTokenHash;
    const actual = hashDocument(token ?? "");
    if (expected.length !== actual.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
      throw new ApiError(401, "BAD_MANAGE_TOKEN", "管理凭证无效");
    }
    return application;
  }

  selfView(reference, token) {
    return this.#selfView(this.#authenticate(reference, token));
  }

  cancelSelf(reference, token) {
    const at = this.clock();
    const application = this.#authenticate(reference, token);
    const slot = this.getSlot(application.slotId);
    if (!canSelfCancel(application, slot, at)) {
      throw new ApiError(409, "NOT_CANCELLABLE", `当前状态 ${application.status} 不可自助取消`);
    }
    this.#cancelApplication(application, { reason: "SELF_CANCEL", at, actor: { role: "public" } });
    this.#promoteWaitlist(slot, at);
    this.#fillServiceWaitlists(at, { role: "public" });
    this.store.save();
    return this.#selfView(application);
  }

  rescheduleSelf(reference, token, input) {
    const at = this.clock();
    const application = this.#authenticate(reference, token);
    const oldSlot = this.getSlot(application.slotId);
    if (!canSelfReschedule(application, oldSlot, at, this.store.state.policy)) {
      throw new ApiError(409, "RESCHEDULE_DEADLINE_PASSED", "已超过自助改期截止时间");
    }
    const target = this.getSlot(input.newSlotId);
    if (target.id === oldSlot.id) throw new ApiError(400, "SAME_SLOT", "新时段与原时段相同");
    if (target.status !== "OPEN") throw new ApiError(409, "SLOT_CLOSED", "目标时段不开放", { reason: target.closureReason });
    if (ts(target.startsAt) <= ts(at)) throw new ApiError(409, "SLOT_STARTED", "目标时段已开始");

    const duplicate = this.store.state.applications.find(
      (app) => app.id !== application.id && app.slotId === target.id &&
        app.documentHash === application.documentHash && isActiveStatus(app.status),
    );
    if (duplicate) {
      throw new ApiError(409, "DUPLICATE_ACTIVE_APPLICATION", "该证件在目标时段已有有效预约");
    }

    // 整团原子校验：目标时段在“不含本预约”口径下必须容得下整团人数。
    const targetFree = target.capacity -
      this.#confirmedSeats(target.id, { excludeApplicationId: application.id });
    if (targetFree < application.partySize) {
      throw new ApiError(409, "TARGET_FULL", "目标时段名额不足，无法整团改期");
    }
    const serviceTypes = input.serviceTypes === undefined
      ? application.serviceRequests
      : this.#validateServiceTypes(input.serviceTypes);

    // 释放旧时段占用
    this.#releaseAllocations(application, at, "RESCHEDULE_OUT", { role: "public" });
    const previousSlotId = application.slotId;
    application.slotId = target.id;
    application.waitlistRank = null;
    application.waitlistExpiresAt = null;
    application.noShowReleaseAt = noShowReleaseAt(target, this.store.state.policy);
    application.status = APPLICATION_STATUS.CONFIRMED;
    application.serviceRequests = serviceTypes;
    application.rescheduleSeq += 1;
    application.updatedAt = at;
    application.history.push({ at, fromSlotId: previousSlotId, toSlotId: target.id, reason: "SELF_RESCHEDULE" });

    for (const type of serviceTypes) this.#assignOrQueueService(application, type, at);

    this.audit.record("APPLICATION", "RESCHEDULED", {
      applicationId: application.id,
      fromSlotId: previousSlotId,
      toSlotId: target.id,
      partySize: application.partySize,
    }, { applicationId: application.id, slotId: target.id, actor: { role: "public" } });

    this.notifications.notify({
      applicationId: application.id,
      type: "RESCHEDULED",
      context: { slot: oldSlot, newSlot: target, partySize: application.partySize },
      dedupeKey: `reschedule#${application.rescheduleSeq}`,
      recipient: application.contactMasked,
      actor: { role: "public" },
    });
    this.#notifyQueuedServices(application, target, { role: "public" });

    // 旧时段释放后推进候补
    this.#promoteWaitlist(oldSlot, at);
    this.#fillServiceWaitlists(at, { role: "public" });
    this.store.save();
    return this.#selfView(application);
  }

  // ---------------- 现场/管理接口 ----------------

  staffRoster(slotId) {
    const slot = this.getSlot(slotId);
    const items = this.#activeApps(slotId)
      .filter((app) => app.status === APPLICATION_STATUS.CONFIRMED)
      .map((app) => ({
        reference: app.reference,
        kind: app.kind,
        partySize: app.partySize,
        contact: app.contactMasked,
        // 仅列履约所需：需要哪项服务、交付用的资源/班次，不含证件与需求细节。
        services: app.allocations
          .filter((allocation) => allocation.status === ACTIVE_ALLOCATION)
          .map((allocation) => this.#serviceFulfillmentView(allocation)),
      }))
      .sort((a, b) => (a.reference < b.reference ? -1 : 1));
    return {
      slot: { id: slot.id, date: slot.date, label: slot.label, startsAt: slot.startsAt, endsAt: slot.endsAt },
      confirmedCount: items.length,
      totalVisitors: items.reduce((sum, item) => sum + item.partySize, 0),
      items,
    };
  }

  adminListApplications({ slotId, status } = {}) {
    return this.store.state.applications
      .filter((app) => !slotId || app.slotId === slotId)
      .filter((app) => !status || app.status === status)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((app) => ({
        id: app.id,
        reference: app.reference,
        slotId: app.slotId,
        kind: app.kind,
        partySize: app.partySize,
        status: app.status,
        contact: app.contactMasked,
        accessiblePriority: app.accessiblePriority,
        allocations: app.allocations.map((allocation) => ({
          type: allocation.type,
          status: allocation.status,
          resourceId: allocation.resourceId,
          tourScheduleId: allocation.tourScheduleId,
        })),
        createdAt: app.createdAt,
        updatedAt: app.updatedAt,
      }));
  }

  adminCancelApplication(applicationId, reason, actor) {
    const at = this.clock();
    const application = this.store.state.applications.find((item) => item.id === applicationId);
    if (!application) throw new ApiError(404, "APPLICATION_NOT_FOUND", "预约不存在");
    if (!isActiveStatus(application.status)) {
      throw new ApiError(409, "NOT_CANCELLABLE", `当前状态 ${application.status} 不可取消`);
    }
    const slot = this.getSlot(application.slotId);
    this.#cancelApplication(application, { reason: reason ?? "ADMIN_CANCEL", at, actor });
    this.#promoteWaitlist(slot, at);
    this.#fillServiceWaitlists(at, actor);
    this.store.save();
    return { id: application.id, status: application.status };
  }

  setSlotCapacity(slotId, capacity, actor) {
    const slot = this.getSlot(slotId);
    const value = Number(capacity);
    if (!Number.isInteger(value) || value <= 0) throw new ApiError(400, "INVALID_CAPACITY", "容量须为正整数");
    const confirmed = this.#confirmedSeats(slotId);
    if (value < confirmed) {
      throw new ApiError(409, "CAPACITY_BELOW_CONFIRMED", "新容量低于已确认人数，不得压缩已确认名额", {
        confirmed,
      });
    }
    const previous = slot.capacity;
    slot.capacity = value;
    this.audit.record("CAPACITY", "CAPACITY_CHANGED", {
      slotId,
      previous,
      next: value,
    }, { slotId, actor });
    this.#promoteWaitlist(slot, this.clock());
    this.store.save();
    return this.publicSlot(slotId);
  }

  closeSlot(slotId, reason, force, actor) {
    const at = this.clock();
    const slot = this.getSlot(slotId);
    const confirmedApps = this.#activeApps(slotId).filter((app) => app.status === APPLICATION_STATUS.CONFIRMED);
    const waitingApps = this.#activeApps(slotId).filter((app) => app.status === APPLICATION_STATUS.WAITLISTED);
    if (confirmedApps.length > 0 && !force) {
      throw new ApiError(409, "SLOT_HAS_CONFIRMED", "该时段存在已确认预约，需显式 force 才能关闭并批量取消", {
        confirmed: confirmedApps.length,
        waiting: waitingApps.length,
      });
    }
    slot.status = "CLOSED";
    slot.closureReason = reason ?? "临时闭馆";
    for (const app of confirmedApps) {
      this.#cancelApplication(app, {
        reason: "SLOT_CLOSED", at, actor, notify: true, notificationType: "SLOT_CLOSED",
        notificationContext: { reason: slot.closureReason },
      });
    }
    for (const app of waitingApps) {
      app.status = APPLICATION_STATUS.EXPIRED;
      app.updatedAt = at;
      app.waitlistRank = null;
      app.waitlistExpiresAt = null;
      app.allocations = [];
      app.history.push({ at, reason: "SLOT_CLOSED" });
      this.audit.record("APPLICATION", "WAITLIST_EXPIRED", {
        applicationId: app.id,
        slotId,
        reason: "SLOT_CLOSED",
      }, { applicationId: app.id, slotId, actor });
      this.notifications.notify({
        applicationId: app.id,
        type: "SLOT_CLOSED",
        context: { slot, reason: slot.closureReason },
        dedupeKey: "lifecycle:SLOT_CLOSED",
        recipient: app.contactMasked,
        actor,
      });
    }
    this.store.save();
    return this.publicSlot(slotId);
  }

  // ---------------- 资源故障与恢复 ----------------

  resourceDown(resourceId, { resumeAt, note } = {}, actor) {
    const resource = this.#getResource(resourceId);
    const at = this.clock();
    if (resumeAt && ts(resumeAt) <= ts(at)) {
      throw new ApiError(400, "INVALID_RESUME_TIME", "预计恢复时间必须晚于当前时间");
    }
    resource.status = "DOWN";
    resource.downSince = at;
    resource.resumeAt = resumeAt ?? null;
    resource.note = note ?? null;
    this.audit.record("RESOURCE", "RESOURCE_DOWN", {
      resourceId,
      type: resource.type,
      resumeAt: resource.resumeAt,
      note: resource.note,
    }, { actor });

    for (const application of this.#applicationsUsingResource(resourceId)) {
      this.#handleAffectedAllocation(application, resource, at, actor);
    }
    this.store.save();
    return this.#resourceView(resource);
  }

  resourceRecover(resourceId, actor) {
    const resource = this.#getResource(resourceId);
    const at = this.clock();
    resource.status = "ACTIVE";
    resource.downSince = null;
    resource.resumeAt = null;
    resource.note = null;
    this.audit.record("RESOURCE", "RESOURCE_RECOVERED", { resourceId, type: resource.type }, { actor });
    this.#fillServiceWaitlists(at, actor, resource.type);
    this.store.save();
    return this.#resourceView(resource);
  }

  resourceRetire(resourceId, note, actor) {
    const resource = this.#getResource(resourceId);
    const at = this.clock();
    resource.status = "RETIRED";
    resource.downSince = at;
    resource.resumeAt = null;
    resource.note = note ?? "永久停用";
    this.audit.record("RESOURCE", "RESOURCE_RETIRED", {
      resourceId,
      type: resource.type,
      note: resource.note,
    }, { actor });
    for (const application of this.#applicationsUsingResource(resourceId)) {
      this.#handleAffectedAllocation(application, resource, at, actor, { permanent: true });
    }
    this.store.save();
    return this.#resourceView(resource);
  }

  listResources(type) {
    return this.store.state.resources
      .filter((resource) => !type || resource.type === type)
      .map((resource) => this.#resourceView(resource));
  }

  // ---------------- 定时处理（重启后按持久化的原截止时间执行） ----------------

  runTimedOperations(nowIso = this.clock()) {
    const atMs = ts(nowIso);
    const actions = [];
    for (const slot of this.store.state.slots) {
      actions.push(...this.#expireWaitlists(slot, nowIso));
      actions.push(...this.#releaseNoShows(slot, nowIso));
      if (slot.status === "OPEN") {
        actions.push(...this.#promoteWaitlist(slot, nowIso, { persist: false }));
      }
    }
    // 爽约/取消释放出的服务资源同样回填服务候补。
    const before = this.store.state.auditEvents.length;
    this.#fillServiceWaitlists(nowIso, { role: "system" });
    if (this.store.state.auditEvents.length > before) {
      actions.push({ type: "SERVICE_WAITLIST_FILLED" });
    }
    if (actions.length > 0) this.store.save();
    return { at: nowIso, atMs, actions };
  }

  #expireWaitlists(slot, at) {
    const actions = [];
    for (const app of this.#waitlisted(slot.id)) {
      // 截止时间在申请时固化，过期候补不再有晋级资格，也不会挤掉已确认名额。
      if (ts(app.waitlistExpiresAt) <= ts(at)) {
        app.status = APPLICATION_STATUS.EXPIRED;
        app.updatedAt = at;
        app.history.push({ at, reason: "WAITLIST_CUTOFF" });
        app.allocations = app.allocations.filter((allocation) => allocation.status !== "PENDING")
          .map((allocation) => (allocation.status === "WAITLISTED"
            ? { ...allocation, status: "UNAVAILABLE", reason: "WAITLIST_EXPIRED" }
            : allocation));
        this.audit.record("APPLICATION", "WAITLIST_EXPIRED", {
          applicationId: app.id,
          slotId: slot.id,
          deadline: app.waitlistExpiresAt,
        }, { applicationId: app.id, slotId: slot.id, actor: { role: "system" } });
        actions.push({ type: "WAITLIST_EXPIRED", applicationId: app.id, slotId: slot.id });
      }
    }
    return actions;
  }

  #releaseNoShows(slot, at) {
    const actions = [];
    for (const app of this.#activeApps(slot.id)) {
      if (app.status === APPLICATION_STATUS.CONFIRMED && ts(app.noShowReleaseAt) <= ts(at)) {
        this.#releaseAllocations(app, at, "NO_SHOW", { role: "system" });
        app.status = APPLICATION_STATUS.NO_SHOW;
        app.updatedAt = at;
        app.cancellation = { reason: "NO_SHOW", at, actor: "system" };
        app.history.push({ at, reason: "NO_SHOW" });
        this.audit.record("CAPACITY", "SEATS_RELEASED", {
          applicationId: app.id,
          slotId: slot.id,
          partySize: app.partySize,
          previousStatus: "CONFIRMED",
          reason: "NO_SHOW",
        }, { applicationId: app.id, slotId: slot.id, actor: { role: "system" } });
        actions.push({ type: "NO_SHOW_RELEASED", applicationId: app.id, slotId: slot.id });
      }
    }
    return actions;
  }

  // ---------------- 候补晋级 ----------------

  #promoteWaitlist(slot, at, { persist = true } = {}) {
    const actions = [];
    if (slot.status !== "OPEN") return actions;
    // 超过候补截止时间后不再晋级（runTimedOperations 已先做过期处理）。
    const waiting = this.#waitlisted(slot.id)
      .filter((app) => ts(at) < ts(app.waitlistExpiresAt))
      // 严格 FIFO：按全局登记顺序晋级，队首整团放不下则不跳过、不拆分。
      .sort((a, b) => a.waitlistRank - b.waitlistRank);

    let freed = false;
    for (const app of waiting) {
      const free = slot.capacity - this.#confirmedSeats(slot.id);
      if (free < app.partySize) break;
      app.status = APPLICATION_STATUS.CONFIRMED;
      app.waitlistRank = null;
      app.waitlistExpiresAt = null;
      app.updatedAt = at;
      app.history.push({ at, reason: "WAITLIST_PROMOTED" });
      // 候补期间未做过资源分配，晋级时整体尝试一次：成功即履约，失败转服务候补。
      for (const allocation of app.allocations) {
        if (allocation.status !== "PENDING") continue;
        const assigned = allocation.type === "SIGN_LANGUAGE"
          ? this.#tryAssignSignLanguage(app.slotId, app.id)
          : this.#tryAssignWheelchair(app.slotId, app.id);
        if (assigned) {
          allocation.status = ACTIVE_ALLOCATION;
          allocation.resourceId = assigned.resourceId;
          allocation.tourScheduleId = assigned.tourScheduleId;
          allocation.assignedAt = at;
        } else {
          allocation.status = "WAITLISTED";
        }
      }
      this.audit.record("CAPACITY", "WAITLIST_PROMOTED", {
        applicationId: app.id,
        slotId: slot.id,
        partySize: app.partySize,
      }, { applicationId: app.id, slotId: slot.id, actor: { role: "system" } });
      this.notifications.notify({
        applicationId: app.id,
        type: "PROMOTED",
        context: { slot, kind: app.kind, partySize: app.partySize },
        dedupeKey: "lifecycle:PROMOTED",
        recipient: app.contactMasked,
        actor: { role: "system" },
      });
      this.#notifyQueuedServices(app, slot, { role: "system" });
      actions.push({ type: "WAITLIST_PROMOTED", applicationId: app.id, slotId: slot.id });
      freed = true;
    }
    if (freed && persist) this.store.save();
    return actions;
  }

  // ---------------- 服务资源分配 ----------------

  #assignOrQueueService(application, type, at) {
    const assigned = type === "SIGN_LANGUAGE"
      ? this.#tryAssignSignLanguage(application.slotId, application.id)
      : this.#tryAssignWheelchair(application.slotId, application.id);
    if (assigned) {
      application.allocations.push({
        ...this.#allocation(type, ACTIVE_ALLOCATION),
        ...assigned,
        assignedAt: at,
      });
      return true;
    }
    application.allocations.push({ ...this.#allocation(type, "WAITLISTED"), since: at });
    return false;
  }

  #tryAssignWheelchair(slotId, excludeApplicationId) {
    const targetSlot = this.getSlot(slotId);
    const used = new Set();
    for (const app of this.#activeAppsOverlapping(targetSlot)) {
      if (app.id === excludeApplicationId) continue;
      for (const allocation of app.allocations) {
        if (allocation.type === "WHEELCHAIR_ASSIST" && allocation.status === ACTIVE_ALLOCATION) {
          used.add(allocation.resourceId);
        }
      }
    }
    const chair = this.store.state.resources
      .filter((resource) => resource.type === "WHEELCHAIR_ASSIST" && resource.status === "ACTIVE" && !used.has(resource.id))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    return chair ? { resourceId: chair.id, tourScheduleId: null } : null;
  }

  #activeAppsOverlapping(targetSlot) {
    return this.store.state.applications.filter((app) => {
      if (!isActiveStatus(app.status)) return false;
      const other = this.store.state.slots.find((slot) => slot.id === app.slotId);
      if (!other || other.id === targetSlot.id) return true;
      return ts(other.startsAt) < ts(targetSlot.endsAt) && ts(targetSlot.startsAt) < ts(other.endsAt);
    });
  }

  #tryAssignSignLanguage(slotId, excludeApplicationId) {
    const tours = this.store.state.tourSchedules
      .filter((tour) => tour.slotId === slotId)
      .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
    for (const tour of tours) {
      const interpreter = this.store.state.resources.find((item) => item.id === tour.interpreterResourceId);
      if (!interpreter || interpreter.status !== "ACTIVE") continue;
      const used = this.#activeApps(slotId)
        .filter((app) => app.id !== excludeApplicationId)
        .flatMap((app) => app.allocations)
        .filter((allocation) => allocation.type === "SIGN_LANGUAGE" &&
          allocation.status === ACTIVE_ALLOCATION &&
          allocation.tourScheduleId === tour.id).length;
      if (used < tour.headsetCapacity) {
        return { resourceId: interpreter.id, tourScheduleId: tour.id };
      }
    }
    return null;
  }

  #handleAffectedAllocation(application, resource, at, actor, { permanent = false } = {}) {
    const allocation = application.allocations.find(
      (item) => item.status === ACTIVE_ALLOCATION && item.resourceId === resource.id,
    );
    if (!allocation) return;
    const oldResourceId = allocation.resourceId;
    const oldTourId = allocation.tourScheduleId;
    allocation.status = "WAITLISTED";
    allocation.resourceId = null;
    allocation.tourScheduleId = null;
    allocation.since = at;
    allocation.reason = permanent ? "RESOURCE_RETIRED" : "RESOURCE_DOWN";

    const alternative = allocation.type === "SIGN_LANGUAGE"
      ? this.#tryAssignSignLanguage(application.slotId, application.id)
      : this.#tryAssignWheelchair(application.slotId, application.id);

    if (alternative) {
      allocation.status = ACTIVE_ALLOCATION;
      allocation.resourceId = alternative.resourceId;
      allocation.tourScheduleId = alternative.tourScheduleId;
      allocation.assignedAt = at;
      allocation.reason = null;
      this.audit.record("SERVICE_COMMITMENT", "REALLOCATED", {
        applicationId: application.id,
        type: allocation.type,
        fromResourceId: oldResourceId,
        toResourceId: alternative.resourceId,
        fromTourScheduleId: oldTourId,
        toTourScheduleId: alternative.tourScheduleId,
        trigger: permanent ? "RESOURCE_RETIRED" : "RESOURCE_DOWN",
      }, { applicationId: application.id, slotId: application.slotId, actor });
      this.#serviceNotice(application, "SERVICE_CHANGED", {
        serviceType: allocation.type,
        reason: "RESOURCE_DOWN",
        newTourLabel: this.#tourLabel(alternative.tourScheduleId),
        newResourceLabel: this.#resourceLabel(alternative.resourceId),
      }, actor);
      return;
    }

    this.audit.record("SERVICE_COMMITMENT", permanent ? "SERVICE_DOWNGRADED" : "SERVICE_QUEUED", {
      applicationId: application.id,
      type: allocation.type,
      fromResourceId: oldResourceId,
      fromTourScheduleId: oldTourId,
      trigger: permanent ? "RESOURCE_RETIRED" : "RESOURCE_DOWN",
      resumeAt: resource.resumeAt,
    }, { applicationId: application.id, slotId: application.slotId, actor });

    if (permanent) {
      allocation.status = "UNAVAILABLE";
      allocation.reason = "RESOURCE_RETIRED";
      this.#serviceNotice(application, "SERVICE_DOWNGRADED", { serviceType: allocation.type }, actor);
    } else {
      this.#serviceNotice(application, "SERVICE_WAITLISTED", {
        serviceType: allocation.type,
        resumeAt: resource.resumeAt,
      }, actor);
    }
  }

  #fillServiceWaitlists(at, actor, onlyType = null) {
    // 多个已确认申请可能在排队同一资源：按申请创建时间先到先得，逐个尝试。
    const candidates = this.store.state.applications
      .filter((app) => app.status === APPLICATION_STATUS.CONFIRMED)
      .filter((app) => app.allocations.some((allocation) =>
        allocation.status === "WAITLISTED" && (!onlyType || allocation.type === onlyType)))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    for (const application of candidates) {
      const slot = this.getSlot(application.slotId);
      if (ts(slot.startsAt) <= ts(at)) continue;
      for (const allocation of application.allocations) {
        if (allocation.status !== "WAITLISTED") continue;
        if (onlyType && allocation.type !== onlyType) continue;
        const assigned = allocation.type === "SIGN_LANGUAGE"
          ? this.#tryAssignSignLanguage(application.slotId, application.id)
          : this.#tryAssignWheelchair(application.slotId, application.id);
        if (!assigned) continue;
        allocation.status = ACTIVE_ALLOCATION;
        allocation.resourceId = assigned.resourceId;
        allocation.tourScheduleId = assigned.tourScheduleId;
        allocation.assignedAt = at;
        allocation.reason = null;
        this.audit.record("SERVICE_COMMITMENT", "REALLOCATED", {
          applicationId: application.id,
          type: allocation.type,
          toResourceId: assigned.resourceId,
          toTourScheduleId: assigned.tourScheduleId,
          trigger: "SERVICE_WAITLIST_FILL",
        }, { applicationId: application.id, slotId: application.slotId, actor });
        this.#serviceNotice(application, "SERVICE_CHANGED", {
          serviceType: allocation.type,
          reason: "RESOURCE_AVAILABLE",
          newTourLabel: this.#tourLabel(assigned.tourScheduleId),
          newResourceLabel: this.#resourceLabel(assigned.resourceId),
        }, actor);
      }
    }
  }

  // ---------------- 内部工具 ----------------

  #cancelApplication(application, { reason, at, actor, notify = true, notificationType = "CANCELLED", notificationContext = {} }) {
    const slot = this.getSlot(application.slotId);
    const previousStatus = application.status;
    this.#releaseAllocations(application, at, reason, actor);
    application.status = APPLICATION_STATUS.CANCELLED;
    application.updatedAt = at;
    application.cancellation = { reason, at, actor: actor.role };
    application.waitlistRank = null;
    application.waitlistExpiresAt = null;
    application.history.push({ at, reason });
    this.audit.record("CAPACITY", "SEATS_RELEASED", {
      applicationId: application.id,
      slotId: slot.id,
      partySize: application.partySize,
      previousStatus,
      reason,
    }, { applicationId: application.id, slotId: slot.id, actor });
    if (notify) {
      // 候补者取消时没有"已占名额"，使用候补专属措辞与幂等键。
      const type = notificationType === "CANCELLED" && previousStatus === APPLICATION_STATUS.WAITLISTED
        ? "WAITLIST_CANCELLED"
        : notificationType;
      this.notifications.notify({
        applicationId: application.id,
        type,
        context: { slot, reason, ...notificationContext },
        dedupeKey: `lifecycle:${type}`,
        recipient: application.contactMasked,
        actor,
      });
    }
  }

  #releaseAllocations(application, at, reason, actor) {
    const released = application.allocations.filter((allocation) => allocation.status === ACTIVE_ALLOCATION);
    for (const allocation of released) {
      this.audit.record("SERVICE_COMMITMENT", "SERVICE_RELEASED", {
        applicationId: application.id,
        type: allocation.type,
        resourceId: allocation.resourceId,
        tourScheduleId: allocation.tourScheduleId,
        reason,
      }, { applicationId: application.id, slotId: application.slotId, actor });
    }
    application.allocations = [];
    application.updatedAt = at;
  }

  #serviceNotice(application, type, context, actor) {
    const seq = (application.serviceNoticeSeq[context.serviceType] ?? 0) + 1;
    application.serviceNoticeSeq[context.serviceType] = seq;
    const slot = this.getSlot(application.slotId);
    this.notifications.notify({
      applicationId: application.id,
      type,
      context: { ...context, slot },
      dedupeKey: `service:${context.serviceType}:${type}:${seq}`,
      recipient: application.contactMasked,
      actor,
    });
  }

  #notifyQueuedServices(application, slot, actor) {
    for (const allocation of application.allocations) {
      if (allocation.status === "WAITLISTED") {
        this.#serviceNotice(application, "SERVICE_WAITLISTED", {
          serviceType: allocation.type,
          resumeAt: null,
        }, actor);
      }
    }
  }

  #activeApps(slotId) {
    return this.store.state.applications.filter(
      (app) => app.slotId === slotId && isActiveStatus(app.status),
    );
  }

  #waitlisted(slotId) {
    return this.store.state.applications.filter(
      (app) => app.slotId === slotId && app.status === APPLICATION_STATUS.WAITLISTED,
    );
  }

  #confirmedSeats(slotId, { excludeApplicationId } = {}) {
    return this.store.state.applications
      .filter((app) => app.slotId === slotId && app.status === APPLICATION_STATUS.CONFIRMED)
      .filter((app) => app.id !== excludeApplicationId)
      .reduce((sum, app) => sum + app.partySize, 0);
  }

  #applicationsUsingResource(resourceId) {
    return this.store.state.applications.filter(
      (app) => isActiveStatus(app.status) &&
        app.allocations.some((allocation) => allocation.status === ACTIVE_ALLOCATION && allocation.resourceId === resourceId),
    );
  }

  #validateServiceTypes(serviceTypes) {
    if (serviceTypes === undefined || serviceTypes === null) return [];
    if (!Array.isArray(serviceTypes)) throw new ApiError(400, "INVALID_SERVICES", "服务请求须为数组");
    const allowed = new Set(["WHEELCHAIR_ASSIST", "SIGN_LANGUAGE"]);
    const cleaned = [...new Set(serviceTypes)];
    if (cleaned.some((type) => !allowed.has(type))) {
      throw new ApiError(400, "INVALID_SERVICE_TYPE", "存在不支持的无障碍服务类型");
    }
    return cleaned;
  }

  #allocation(type, status) {
    return {
      id: randomId("alc"),
      type,
      status,
      resourceId: null,
      tourScheduleId: null,
      since: this.clock(),
      reason: null,
    };
  }

  #getResource(resourceId) {
    const resource = this.store.state.resources.find((item) => item.id === resourceId);
    if (!resource) throw new ApiError(404, "RESOURCE_NOT_FOUND", "资源不存在");
    return resource;
  }

  #resourceLabel(resourceId) {
    return this.store.state.resources.find((item) => item.id === resourceId)?.label ?? resourceId;
  }

  #tourLabel(tourId) {
    if (!tourId) return null;
    const tour = this.store.state.tourSchedules.find((item) => item.id === tourId);
    if (!tour) return tourId;
    return `${tour.startsAt.slice(11, 16)} 手语导览班次`;
  }

  #serviceSummary(slotId) {
    const tours = this.listTours(slotId);
    const slot = this.getSlot(slotId);
    const activeChairs = this.store.state.resources.filter((r) => r.type === "WHEELCHAIR_ASSIST" && r.status === "ACTIVE").length;
    const chairsUsed = this.#activeAppsOverlapping(slot)
      .flatMap((app) => app.allocations)
      .filter((a) => a.type === "WHEELCHAIR_ASSIST" && a.status === ACTIVE_ALLOCATION).length;
    return {
      wheelchairs: { available: Math.max(0, activeChairs - chairsUsed), total: activeChairs },
      signLanguageTours: tours.map((tour) => ({
        tourId: tour.id,
        startsAt: tour.startsAt,
        headsetsAvailable: tour.headsetsAvailable,
        interpreterStatus: tour.interpreterStatus,
      })),
    };
  }

  #serviceFulfillmentView(allocation) {
    return {
      type: allocation.type,
      delivery: allocation.type === "SIGN_LANGUAGE"
        ? this.#tourLabel(allocation.tourScheduleId)
        : this.#resourceLabel(allocation.resourceId),
    };
  }

  #selfView(application) {
    const slot = this.getSlot(application.slotId);
    return {
      reference: application.reference,
      kind: application.kind,
      partySize: application.partySize,
      status: application.status,
      slot: {
        id: slot.id,
        date: slot.date,
        label: slot.label,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      },
      serviceRequests: application.serviceRequests,
      allocations: application.allocations.map((allocation) => ({
        type: allocation.type,
        status: allocation.status,
        delivery: allocation.tourScheduleId
          ? this.#tourLabel(allocation.tourScheduleId)
          : allocation.resourceId ? this.#resourceLabel(allocation.resourceId) : null,
        reason: allocation.reason,
      })),
      waitlistExpiresAt: application.waitlistExpiresAt,
      history: application.history.map((entry) => ({ at: entry.at, reason: entry.reason })),
      notifications: this.notifications.listByApplication(application.id).map((item) => ({
        type: item.type,
        title: item.title,
        body: item.body,
        at: item.createdAt,
        status: item.status,
      })),
    };
  }

  #resourceView(resource) {
    const committed = this.store.state.applications
      .flatMap((app) => app.allocations)
      .filter((a) => a.status === ACTIVE_ALLOCATION && a.resourceId === resource.id).length;
    return {
      id: resource.id,
      type: resource.type,
      label: resource.label,
      status: resource.status,
      downSince: resource.downSince,
      resumeAt: resource.resumeAt,
      note: resource.note,
      committedAssignments: committed,
    };
  }

  // 供 HTTP 层使用
  publicSlot(slotId) {
    return this.listPublicSlots().find((slot) => slot.id === slotId);
  }

  queryAudit(filter) {
    return this.audit.query(filter);
  }

  listNotifications({ applicationId, type, limit = 100 } = {}) {
    return this.store.state.notifications
      .filter((item) => !applicationId || item.applicationId === applicationId)
      .filter((item) => !type || item.type === type)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        applicationId: item.applicationId,
        type: item.type,
        recipient: item.recipientMasked,
        title: item.title,
        status: item.status,
        at: item.createdAt,
        dedupeId: item.dedupeId,
      }));
  }
}
