import { addDays, combineDateTime, slotKey, weekdayOf, ymd } from "./util.js";

/**
 * 时段目录：依据周闭馆日、节假日覆盖、开放模板，把日期解析为具体时段。
 * 节假日覆盖优先于星期规则（调休开放 / 法定闭馆）。
 */
export class Catalog {
  constructor(config) {
    this.config = config;
  }

  dayInfo(dateStr) {
    const hall = this.config.catalog.halls[0];
    const override = this.config.catalog.holidayOverrides?.[dateStr];
    const weekday = weekdayOf(dateStr);
    const weeklyClosed = hall.weeklyClosed.includes(weekday);
    const closed = override ? Boolean(override.closed) : weeklyClosed;
    return {
      date: dateStr,
      closed,
      reason: override
        ? override.closed
          ? `holiday:${override.name}`
          : `holiday_open:${override.name}`
        : weeklyClosed
          ? "weekly_closed"
          : "open",
      name: override?.name ?? null,
    };
  }

  /** 返回某展厅某天的时段列表（闭馆日返回空） */
  slotsForDay(hallId, dateStr) {
    const hall = this.config.hallById.get(hallId);
    if (!hall) return [];
    if (this.dayInfo(dateStr).closed) return [];
    return hall.slotTemplates.map((template) => {
      const start = combineDateTime(dateStr, template.start);
      const end = combineDateTime(dateStr, template.end);
      return {
        hallId,
        date: dateStr,
        slotId: template.id,
        key: slotKey(hallId, dateStr, template.id),
        label: `${dateStr} ${template.label}`,
        start,
        end,
        template,
      };
    });
  }

  resolveSlot(hallId, dateStr, slotId) {
    return this.slotsForDay(hallId, dateStr).find((s) => s.slotId === slotId) ?? null;
  }

  upcomingDays(fromDate, horizonDays = this.config.catalog.horizonDays) {
    const days = [];
    for (let i = 0; i < horizonDays; i += 1) {
      const d = addDays(fromDate, i);
      days.push(this.dayInfo(ymd(d)));
    }
    return days;
  }
}
