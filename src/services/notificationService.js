import { randomId } from "../util/ids.js";
import { renderNotification } from "./notificationTemplates.js";

/**
 * 通知服务：所有通知以 (applicationId, type, dedupeKey) 幂等落库。
 * 重试、重启回放或重复触发都不会产生重复通知。
 * 当前实现写入内存/持久化状态并模拟发送；接入真实渠道时仅替换 #dispatch。
 */
export class NotificationService {
  constructor(store, clock = () => new Date().toISOString(), audit = null) {
    this.store = store;
    this.clock = clock;
    this.audit = audit;
  }

  /**
   * @returns 通知记录（已存在则返回原记录，不重复发送）
   */
  notify({ applicationId, type, context, dedupeKey, recipient, actor }) {
    const state = this.store.state;
    const fullKey = `${applicationId ?? "system"}:${type}:${dedupeKey ?? "once"}`;
    const existing = state.notifications.find((item) => item.dedupeId === fullKey);
    if (existing) return existing;

    const rendered = renderNotification(type, context ?? {});
    const record = {
      id: randomId("ntf"),
      dedupeId: fullKey,
      applicationId: applicationId ?? null,
      type,
      recipientMasked: recipient ?? null,
      title: rendered.title,
      body: rendered.body,
      status: "SENT",
      attempts: 1,
      createdAt: this.clock(),
      sentAt: this.clock(),
      triggeredBy: actor ?? "system",
    };
    state.notifications.push(record);
    // 通知结果同样进入审计（按幂等键，重发不会产生第二条审计）。
    this.audit?.record("NOTIFICATION", "SENT", {
      applicationId: applicationId ?? null,
      notificationId: record.id,
      type,
      dedupeId: fullKey,
      recipientMasked: record.recipientMasked,
      status: record.status,
    }, { applicationId: applicationId ?? undefined, actor: actor ?? { role: "system" } });
    return record;
  }

  listByApplication(applicationId) {
    return this.store.state.notifications.filter((item) => item.applicationId === applicationId);
  }
}
