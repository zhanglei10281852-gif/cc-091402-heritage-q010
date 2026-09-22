import { randomId } from "../util/ids.js";

/**
 * 审计服务：名额变化、服务承诺变更、通知结果均结构化留痕，
 * 保留经办角色与发生时间，供管理接口审计。
 */
export class AuditService {
  constructor(store, clock = () => new Date().toISOString()) {
    this.store = store;
    this.clock = clock;
  }

  record(category, action, payload = {}, options = {}) {
    const event = {
      id: randomId("aud"),
      at: this.clock(),
      category, // CAPACITY | SERVICE_COMMITMENT | NOTIFICATION | APPLICATION | RESOURCE
      action,
      applicationId: options.applicationId ?? payload.applicationId ?? null,
      slotId: options.slotId ?? payload.slotId ?? null,
      actor: options.actor ?? { role: "system" },
      payload,
    };
    this.store.state.auditEvents.push(event);
    return event;
  }

  query({ category, slotId, applicationId, limit = 100 } = {}) {
    let events = [...this.store.state.auditEvents];
    if (category) events = events.filter((event) => event.category === category);
    if (slotId) events = events.filter((event) => event.slotId === slotId);
    if (applicationId) events = events.filter((event) => event.applicationId === applicationId);
    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return events.slice(0, limit);
  }
}
