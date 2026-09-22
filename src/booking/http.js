import { BookingError } from "./config.js";
import { adminApplicationView, applicantView, staffRosterView } from "./views.js";
import { ymd } from "./util.js";

const ACTIVE = new Set(["held", "confirmed"]);

/**
 * HTTP 路由。
 * 三类调用方：
 * - 申请人：凭不透明 managementToken 管理自己的申请，接口不返回证件号/需求原因之外的敏感数据
 * - 一线工作人员（x-api-key: STAFF_KEY）：只见履约名册与服务项，不见证件与联系方式
 * - 管理员（x-api-key: ADMIN_KEY）：审计、故障、通知结果
 */
export function registerRoutes({ router, service, catalog, store, config, keys }) {
  // ---------- 公开目录 ----------
  router.get("^/api/catalog/days$", async (req, res) => {
    const url = new URL(req.url, "http://x");
    const from = url.searchParams.get("from") ?? ymd(service.now());
    const days = catalog.upcomingDays(new Date(`${from}T00:00:00+08:00`));
    ok(res, days);
  });

  router.get("^/api/catalog/halls/(?<hallId>[\\w-]+)/slots$", async (req, res, params) => {
    const url = new URL(req.url, "http://x");
    const date = url.searchParams.get("date") ?? ymd(service.now());
    const slots = catalog.slotsForDay(params.hallId, date).map((s) => {
      const usage = store.read((st) => {
        const u = service.snapshotIn(st, s.key);
        return u;
      });
      const activeCount = store
        .read((st) => Object.values(st.applications).filter((a) => a.slotKey === s.key && ACTIVE.has(a.status)).length);
      const waitCount = store
        .read((st) => Object.values(st.applications).filter((a) => a.slotKey === s.key && a.status === "waitlisted").length);
      return {
        hallId: s.hallId,
        date: s.date,
        slotId: s.slotId,
        label: s.template.label,
        start: s.start.toISOString(),
        end: s.end.toISOString(),
        capacity: s.template.capacity,
        accessibleHeld: s.template.accessibleHeld,
        seatsUsed: usage.seats.seats,
        seatsRemaining: s.template.capacity - usage.seats.seats,
        activeApplications: activeCount,
        waitlist: waitCount,
      };
    });
    ok(res, { date, closed: catalog.dayInfo(date).closed, reason: catalog.dayInfo(date).reason, slots });
  });

  // ---------- 申请人自助 ----------
  router.post("^/api/applications$", async (req, res) => {
    const body = await readJson(req);
    const result = await service.apply(body);
    res.writeHead(201, jsonHeaders());
    res.end(JSON.stringify(result));
  });

  router.get("^/api/applications/(?<code>[\\w]+)$", async (req, res, params) => {
    const token = new URL(req.url, "http://x").searchParams.get("token");
    const app = service.getApp(params.code);
    service.requireToken(app, token);
    const view = applicantView(app, config);
    view.waitlistRank = service.computeWaitlistRank(app);
    ok(res, view);
  });

  /** 一线核验：凭预约编号确认到场状态，仅返回履约所需信息 */
  router.get("^/api/staff/applications/(?<code>[\\w]+)/verification$", async (req, res, params) => {
    requireKey(req, keys.staff, "staff");
    const app = service.getApp(params.code);
    ok(res, {
      code: app.code,
      status: app.status,
      slotLabel: `${app.slotDate} ${app.slotLabel}`,
      partySize: app.partySize,
      applicantName: app.applicantName,
      serviceItems: staffRosterView(app, config).serviceItems,
      serviceAlerts: staffRosterView(app, config).serviceAlerts,
    });
  });

  router.post("^/api/applications/(?<code>[\\w]+)/(?<action>confirm|cancel|reschedule)$",
    async (req, res, params) => {
      const body = await readJson(req).catch(() => ({}));
      const token = body.token ?? new URL(req.url, "http://x").searchParams.get("token");
      const actor = { role: "applicant" };
      let result;
      if (params.action === "confirm") result = await service.confirm(params.code, token, actor);
      if (params.action === "cancel") result = await service.cancel(params.code, token, actor);
      if (params.action === "reschedule") {
        result = await service.reschedule(params.code, token, body, actor);
      }
      ok(res, result);
    });

  // ---------- 一线工作人员 ----------
  router.get("^/api/staff/halls/(?<hallId>[\\w-]+)/dates/(?<date>\\d{4}-\\d{2}-\\d{2})/roster$",
    async (req, res, params) => {
      requireKey(req, keys.staff, "staff");
      const roster = store
        .read((st) =>
          Object.values(st.applications)
            .filter((a) => a.hallId === params.hallId && a.slotDate === params.date)
            .filter((a) => a.status === "confirmed")
            .sort((a, b) => new Date(a.slotStart) - new Date(b.slotStart) || a.createdAt.localeCompare(b.createdAt)))
        .map((a) => staffRosterView(a, config));
      ok(res, { date: params.date, count: roster.length, roster });
    });

  /** 工作人员通过系统代为催联，不直接看到联系方式，通知内容不含需求细节 */
  router.post("^/api/staff/applications/(?<code>[\\w]+)/notify$", async (req, res, params) => {
    requireKey(req, keys.staff, "staff");
    const body = await readJson(req).catch(() => ({}));
    const app = service.getApp(params.code);
    const sent = await service.sendStaffNudge(app, body.message ?? null, {
      role: "staff",
      staffId: req.headers["x-staff-id"] ?? "unknown",
    });
    ok(res, { notificationId: sent.record.id, status: sent.record.status });
  });

  // ---------- 管理员 ----------
  router.get("^/api/admin/applications$", async (req, res) => {
    requireKey(req, keys.admin, "admin");
    const url = new URL(req.url, "http://x");
    const status = url.searchParams.get("status");
    const slot = url.searchParams.get("slotKey");
    let list = store.read((st) => Object.values(st.applications));
    if (status) list = list.filter((a) => a.status === status);
    if (slot) list = list.filter((a) => a.slotKey === slot);
    list = list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500);
    ok(res, { applications: list.map((a) => adminApplicationView(a, config)) });
  });

  router.get("^/api/admin/applications/(?<code>[\\w]+)$", async (req, res, params) => {
    requireKey(req, keys.admin, "admin");
    const app = service.getApp(params.code);
    const notifications = store.read((st) =>
      Object.values(st.notifications).filter((n) => n.refCode === params.code));
    ok(res, { application: adminApplicationView(app, config), notifications });
  });

  router.post("^/api/admin/applications/(?<code>[\\w]+)/(?<action>cancel|reschedule)$",
    async (req, res, params) => {
      requireKey(req, keys.admin, "admin");
      const body = await readJson(req);
      const actor = { role: "admin", adminId: req.headers["x-admin-id"] ?? "unknown", reason: body.reason };
      let result;
      if (params.action === "cancel") result = await service.cancel(params.code, null, actor);
      else result = await service.reschedule(params.code, null, body, actor);
      ok(res, result);
    });

  router.get("^/api/admin/audit$", async (req, res) => {
    requireKey(req, keys.admin, "admin");
    const url = new URL(req.url, "http://x");
    const action = url.searchParams.get("action");
    const slot = url.searchParams.get("slotKey");
    const code = url.searchParams.get("refCode");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
    let log = store.read((st) => st.auditLog);
    if (action) log = log.filter((e) => e.action === action);
    if (slot) log = log.filter((e) => e.slotKey === slot || e.fromSlotKey === slot || e.toSlotKey === slot);
    if (code) log = log.filter((e) => e.refCode === code);
    log = log.slice(-limit).reverse();
    ok(res, { events: log });
  });

  router.get("^/api/admin/notifications$", async (req, res) => {
    requireKey(req, keys.admin, "admin");
    const url = new URL(req.url, "http://x");
    const code = url.searchParams.get("refCode");
    const status = url.searchParams.get("status");
    let list = store.read((st) => Object.values(st.notifications));
    if (code) list = list.filter((n) => n.refCode === code);
    if (status) list = list.filter((n) => n.status === status);
    list = list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500);
    // 通知结果可审计；手机号脱敏展示
    ok(res, {
      notifications: list.map((n) => ({
        id: n.id,
        refCode: n.refCode,
        category: n.category,
        channel: n.channel,
        title: n.title,
        toMask: n.to ? n.to.slice(0, 3) + "****" + n.to.slice(-4) : null,
        status: n.status,
        attempts: n.attempts,
        createdAt: n.createdAt,
        deliveredAt: n.deliveredAt,
        lastError: n.lastError,
      })),
    });
  });

  router.post("^/api/admin/outages$", async (req, res) => {
    requireKey(req, keys.admin, "admin");
    const body = await readJson(req);
    const result = await service.reportOutage(body, {
      role: "admin",
      adminId: req.headers["x-admin-id"] ?? "unknown",
    });
    res.writeHead(201, jsonHeaders());
    res.end(JSON.stringify(result));
  });

  router.post("^/api/admin/outages/(?<id>[\\w-]+)/resolve$", async (req, res, params) => {
    requireKey(req, keys.admin, "admin");
    const result = await service.restoreOutage(params.id, {
      role: "admin",
      adminId: req.headers["x-admin-id"] ?? "unknown",
    });
    ok(res, result);
  });

  router.get("^/api/admin/outages$", async (req, res) => {
    requireKey(req, keys.admin, "admin");
    ok(res, { outages: store.read((st) => st.outages) });
  });

  /** 运维：立即处理已到期任务（服务本身启动时也会自动补偿） */
  router.post("^/api/admin/maintenance/run-due$", async (req, res) => {
    requireKey(req, keys.admin, "admin");
    await service.runDueNow();
    ok(res, { ranAt: service.now().toISOString() });
  });
}

// ---------- 小工具 ----------

function jsonHeaders() {
  return { "content-type": "application/json; charset=utf-8" };
}

function ok(res, payload) {
  res.writeHead(200, jsonHeaders());
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBytes = 65_536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new BookingError("payload_too_large", "请求体超过 64KB", 413);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireKey(req, expected, role) {
  if (!expected) {
    throw new BookingError("auth_disabled", `${role} 接口未配置访问密钥`, 503);
  }
  const provided = req.headers["x-api-key"];
  if (provided !== expected) {
    throw new BookingError("forbidden", "密钥无效", 403);
  }
}

export function mapError(err) {
  if (err instanceof BookingError) {
    return { status: err.status, body: { error: err.code, message: err.message, details: err.details } };
  }
  if (err instanceof SyntaxError) {
    return { status: 400, body: { error: "invalid_json", message: "请求体不是合法 JSON" } };
  }
  return { status: 500, body: { error: "internal_error", message: String(err?.message ?? err) } };
}
