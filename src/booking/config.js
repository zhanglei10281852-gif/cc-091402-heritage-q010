import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_DIR = path.resolve(HERE, "../../reference/booking");

export class BookingError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function loadConfig({ catalogDir = DEFAULT_CATALOG_DIR } = {}) {
  const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(catalogDir, name), "utf8"));
  const catalog = read("catalog.json");
  const failover = read("failover-rules.json");
  const templates = read("notification-templates.json");

  const derived = {
    holdTtlMs: catalog.holdTtlMinutes * 60_000,
    bookingCloseMs: catalog.bookingClosesBeforeMinutes * 60_000,
    accessibleReleaseMs: (catalog.accessibleReleaseBeforeHours ?? 24) * 3_600_000,
    waitlistTtlMs: catalog.waitlistTtlHours * 3_600_000,
  };

  return {
    catalog,
    failover,
    templates,
    ...derived,
    hallById: new Map(catalog.halls.map((h) => [h.id, h])),
    shiftById: new Map(catalog.shifts.map((s) => [s.id, s])),
    resourceById: new Map(catalog.resources.map((r) => [r.id, r])),
    /**
     * 按 failover-rules.json 解析某故障对象的替代目标规格（有序）。
     * 规则未覆盖时回退为同类替代：同模态班次 / 同类型资源池。
     */
    alternativesFor(kind, refId) {
      const ref =
        kind === "shift" ? catalog.shifts.find((s) => s.id === refId) : catalog.resources.find((r) => r.id === refId);
      const rule = failover.rules.find((r) => {
        if (r.match.kind !== kind) return false;
        if (kind === "shift") return r.match.modality === ref?.modality;
        return r.match.type === ref?.type;
      });
      if (rule) return rule.alternatives;
      if (kind === "shift") return [{ kind: "shift", modality: ref?.modality }];
      return [{ kind: "pool", type: ref?.type }];
    },
  };
}
