import { SERVICE_LABELS } from "../domain/policy.js";

/**
 * 通知模板：通知内容只包含履约所必需的信息，不回显证件号或无障碍需求细节。
 */
export function renderNotification(type, context) {
  const slot = context.slot;
  const slotText = `${slot.date} ${slot.label}（${slot.startsAt.slice(11, 16)} 入场）`;
  switch (type) {
    case "CONFIRMED":
      return {
        title: "预约确认",
        body: `您的${context.kind === "GROUP" ? "团体" : "个人"}预约已确认：${slotText}，共 ${context.partySize} 人。`,
      };
    case "WAITLISTED":
      return {
        title: "已进入候补",
        body: `您申请的 ${slotText} 名额已满，已为您登记候补。若有名额将在开场前通知，逾期未确认将自动顺延。`,
      };
    case "PROMOTED":
      return {
        title: "候补晋级成功",
        body: `好消息，您候补的 ${slotText} 已确认成功，共 ${context.partySize} 人。`,
      };
    case "CANCELLED":
      return {
        title: "预约已取消",
        body: `您 ${slotText} 的预约已取消，名额已释放给其他观众。`,
      };
    case "WAITLIST_CANCELLED":
      return {
        title: "候补已取消",
        body: `您在 ${slotText} 的候补登记已取消。`,
      };
    case "SLOT_CLOSED":
      return {
        title: "时段闭馆通知",
        body: `很抱歉，${slotText} 因${context.reason ?? "临时闭馆"}停止开放，您的预约已取消，欢迎改约其他时段。`,
      };
    case "RESCHEDULED":
      return {
        title: "改期成功",
        body: `您的预约已改期至 ${context.newSlot.date} ${context.newSlot.label}（${context.newSlot.startsAt.slice(11, 16)} 入场），共 ${context.partySize} 人。`,
      };
    case "SERVICE_CHANGED": {
      const label = SERVICE_LABELS[context.serviceType] ?? "无障碍服务";
      let detail;
      if (context.reason === "RESOURCE_DOWN") {
        detail = `因${label}资源临时故障，已为您改派至 ${context.newTourLabel ?? "其他班次"}，服务承诺不变。`;
      } else if (context.reason === "RESOURCE_RECOVERED") {
        detail = `此前临时故障的${label}资源已恢复，已为您安排 ${context.newTourLabel ?? "可用资源"}，服务承诺不变。`;
      } else {
        detail = `已有空余的${label}资源，已为您完成安排（${context.newTourLabel ?? "现场领取"}）。`;
      }
      return {
        title: "无障碍服务安排变更",
        body: `${detail}如不再需要，请通过您的预约管理入口修改。`,
      };
    }
    case "SERVICE_WAITLISTED":
      return {
        title: "服务资源候补",
        body: `${SERVICE_LABELS[context.serviceType] ?? "无障碍服务"}资源暂时不足，已为您加入服务候补；名额预约仍然有效。`,
      };
    case "SERVICE_DOWNGRADED":
      return {
        title: "无障碍服务暂时无法安排",
        body: `很抱歉，${SERVICE_LABELS[context.serviceType] ?? "无障碍服务"}在该时段资源不足且无法改派，已为您保留入场名额，现场将尽力协调。`,
      };
    case "EXPIRY_WARNING":
      return {
        title: "候补即将截止",
        body: `您在 ${slotText} 的候补将于开场前 ${context.cutoffMinutes} 分钟截止，请注意查收后续通知。`,
      };
    default:
      return { title: "预约通知", body: "您的预约状态有更新。" };
  }
}
