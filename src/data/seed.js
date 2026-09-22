import { randomBytes } from "node:crypto";
import { isoInShanghai, isClosedDate, shanghaiDateParts } from "../domain/policy.js";

/**
 * 首次启动时的种子数据：时段容量、导览班次、无障碍资源、节假日规则、
 * 通知策略与管理令牌。真实部署可替换为外部配置导入。
 */
export function createInitialState(now = new Date()) {
  const policy = {
    waitlistCutoffMinutes: 60,
    noShowGraceMinutes: 15,
    rescheduleDeadlineMinutes: 60,
    timezone: "Asia/Shanghai",
  };

  const holidayRules = {
    closedWeekdays: [1], // 周一闭馆
    holidays: [
      { date: "2026-09-25", name: "中秋节闭馆", mode: "CLOSED" },
      { date: "2026-09-28", name: "国庆调休日照常开放", mode: "SPECIAL_OPEN" },
      { date: "2026-10-01", name: "国庆节特别开放", mode: "SPECIAL_OPEN" },
    ],
  };

  const slotTemplates = [
    { code: "am", label: "上午场", startsAt: "09:30", endsAt: "12:00", capacity: 30 },
    { code: "pm", label: "下午场", startsAt: "13:30", endsAt: "16:30", capacity: 30 },
  ];

  const slots = [];
  const tourSchedules = [];
  const resources = [];

  for (let offset = 1; offset <= 8; offset += 1) {
    const date = shanghaiDateParts(now.getTime() + offset * 86_400_000);
    const closure = isClosedDate(date, holidayRules);
    for (const template of slotTemplates) {
      const slotId = `slot-${date}-${template.code}`;
      slots.push({
        id: slotId,
        date,
        label: template.label,
        startsAt: isoInShanghai(date, template.startsAt),
        endsAt: isoInShanghai(date, template.endsAt),
        capacity: template.capacity,
        status: closure ? "CLOSED" : "OPEN",
        closureReason: closure ?? null,
      });
      if (closure) continue;
      const tourHour = template.code === "am" ? "10:00" : "14:00";
      const interpreterId = `si-${date}-${template.code}`;
      tourSchedules.push({
        id: `tour-${date}-${template.code}`,
        slotId,
        startsAt: isoInShanghai(date, tourHour),
        endsAt: isoInShanghai(date, template.code === "am" ? "11:30" : "15:30"),
        headsetCapacity: 8,
        interpreterResourceId: interpreterId,
      });
      resources.push({
        id: interpreterId,
        type: "SIGN_LANGUAGE",
        label: `${date} ${template.label}手语译员`,
        tourScheduleId: `tour-${date}-${template.code}`,
        status: "ACTIVE",
        downSince: null,
        resumeAt: null,
        note: null,
      });
    }
  }

  // 第一个开放日的上午场额外安排一场手语导览，用于演示故障时的同类改派
  const firstOpenAm = slots.find((slot) => slot.status === "OPEN" && slot.label === "上午场");
  if (firstOpenAm) {
    tourSchedules.push({
      id: `tour-${firstOpenAm.date}-am-2`,
      slotId: firstOpenAm.id,
      startsAt: isoInShanghai(firstOpenAm.date, "11:00"),
      endsAt: isoInShanghai(firstOpenAm.date, "12:00"),
      headsetCapacity: 4,
      interpreterResourceId: `si-${firstOpenAm.date}-am-2`,
    });
    resources.push({
      id: `si-${firstOpenAm.date}-am-2`,
      type: "SIGN_LANGUAGE",
      label: `${firstOpenAm.date} 上午场手语译员（第二班）`,
      tourScheduleId: `tour-${firstOpenAm.date}-am-2`,
      status: "ACTIVE",
      downSince: null,
      resumeAt: null,
      note: null,
    });
  }

  // 轮椅为按场次计数的共享设备资源
  for (let i = 1; i <= 4; i += 1) {
    resources.push({
      id: `wc-${i}`,
      type: "WHEELCHAIR_ASSIST",
      label: `轮椅 ${i} 号`,
      tourScheduleId: null,
      status: "ACTIVE",
      downSince: null,
      resumeAt: null,
      note: null,
    });
  }

  return {
    meta: {
      version: 1,
      seededAt: now.toISOString(),
      timezone: "Asia/Shanghai",
    },
    policy,
    holidayRules,
    slots,
    tourSchedules,
    resources,
    applications: [],
    auditEvents: [],
    notifications: [],
    apiTokens: {
      admin: randomBytes(16).toString("hex"),
      staff: randomBytes(16).toString("hex"),
    },
  };
}
