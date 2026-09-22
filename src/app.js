import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const JSON_LIMIT = 64 * 1024;

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > JSON_LIMIT) {
        reject(Object.assign(new Error("请求体过大"), { status: 413, code: "PAYLOAD_TOO_LARGE" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("JSON 格式错误"), { status: 400, code: "BAD_JSON" }));
      }
    });
    request.on("error", reject);
  });
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * @param container 依赖容器（store/notifications/audit/reservations）
 * @param options.env 环境变量（用于令牌覆盖，便于部署轮换）
 */
export function createApp(container, { env = process.env } = {}) {
  const { reservations, store } = container;

  function roleOf(request) {
    const token = request.headers["x-api-token"];
    if (safeEqual(token, env.ADMIN_TOKEN ?? store.state.apiTokens.admin)) return "admin";
    if (safeEqual(token, env.STAFF_TOKEN ?? store.state.apiTokens.staff)) return "staff";
    return null;
  }

  function requireRole(request, response, ...roles) {
    const role = roleOf(request);
    if (!role) {
      sendJson(response, 401, { error: "UNAUTHORIZED", message: "缺少管理凭证" });
      return null;
    }
    if (!roles.includes(role)) {
      sendJson(response, 403, { error: "FORBIDDEN", message: "当前角色无权执行该操作" });
      return null;
    }
    return role;
  }

  function manageTokenOf(request, body) {
    return request.headers["x-manage-token"] || body?.token || "";
  }

  const routes = [];
  function route(method, pattern, handler, options = {}) {
    const names = [];
    const regex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, name) => {
      names.push(name);
      return "([^/]+)";
    })}$`);
    routes.push({ method, regex, names, handler, options });
  }

  function ok(response, payload) {
    sendJson(response, 200, payload);
  }

  // ---------------- 公共接口 ----------------

  route("GET", "/health", async (_request, response) => {
    ok(response, { status: "ok", service: "heritage-reservation" });
  });

  route("GET", "/api/v1/slots", async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    ok(response, { slots: reservations.listPublicSlots(url.searchParams.get("date")) });
  });

  route("GET", "/api/v1/slots/:id", async (request, response, _body, params) => {
    const slot = reservations.listPublicSlots().find((item) => item.id === params.id);
    if (!slot) {
      throw Object.assign(new Error("时段不存在"), { status: 404, code: "SLOT_NOT_FOUND" });
    }
    ok(response, slot);
  });

  route("GET", "/api/v1/slots/:id/tours", async (request, response, _body, params) => {
    reservations.getSlot(params.id);
    ok(response, { tours: reservations.listTours(params.id) });
  });

  route("POST", "/api/v1/applications", async (request, response, body) => {
    const result = reservations.book(body, { role: "public" });
    sendJson(response, 201, result);
  });

  route("GET", "/api/v1/applications/:reference", async (request, response, _body, params) => {
    // 管理令牌只通过请求头传递，避免落入访问日志或浏览器历史。
    ok(response, reservations.selfView(params.reference, request.headers["x-manage-token"]));
  });

  route("POST", "/api/v1/applications/:reference/cancel", async (request, response, body, params) => {
    ok(response, reservations.cancelSelf(params.reference, manageTokenOf(request, body)));
  });

  route("POST", "/api/v1/applications/:reference/update", async (request, response, body, params) => {
    ok(response, reservations.updateSelf(params.reference, manageTokenOf(request, body), body));
  });

  route("POST", "/api/v1/applications/:reference/reschedule", async (request, response, body, params) => {
    ok(response, reservations.rescheduleSelf(params.reference, manageTokenOf(request, body), body));
  });

  // ---------------- 现场工作人员：仅履约视图 ----------------

  route("GET", "/api/v1/staff/slots/:id/roster", async (request, response, _body, params) => {
    if (!requireRole(request, response, "staff", "admin")) return;
    ok(response, reservations.staffRoster(params.id));
  }, { auth: true });

  // ---------------- 管理接口 ----------------

  route("GET", "/api/v1/admin/applications", async (request, response) => {
    if (!requireRole(request, response, "admin")) return;
    const url = new URL(request.url, "http://localhost");
    ok(response, {
      applications: reservations.adminListApplications({
        slotId: url.searchParams.get("slotId"),
        status: url.searchParams.get("status"),
      }),
    });
  }, { auth: true });

  route("POST", "/api/v1/admin/applications/:id/cancel", async (request, response, body, params) => {
    if (!requireRole(request, response, "admin")) return;
    ok(response, reservations.adminCancelApplication(params.id, body.reason, { role: "admin" }));
  }, { auth: true });

  route("PUT", "/api/v1/admin/slots/:id/capacity", async (request, response, body, params) => {
    if (!requireRole(request, response, "admin")) return;
    ok(response, reservations.setSlotCapacity(params.id, body.capacity, { role: "admin" }));
  }, { auth: true });

  route("POST", "/api/v1/admin/slots/:id/close", async (request, response, body, params) => {
    if (!requireRole(request, response, "admin")) return;
    ok(response, reservations.closeSlot(params.id, body.reason, Boolean(body.force), { role: "admin" }));
  }, { auth: true });

  route("GET", "/api/v1/admin/resources", async (request, response) => {
    if (!requireRole(request, response, "admin")) return;
    const url = new URL(request.url, "http://localhost");
    ok(response, { resources: reservations.listResources(url.searchParams.get("type")) });
  }, { auth: true });

  route("POST", "/api/v1/admin/resources/:id/down", async (request, response, body, params) => {
    if (!requireRole(request, response, "admin")) return;
    ok(response, reservations.resourceDown(params.id, { resumeAt: body.resumeAt, note: body.note }, { role: "admin" }));
  }, { auth: true });

  route("POST", "/api/v1/admin/resources/:id/recover", async (request, response, _body, params) => {
    if (!requireRole(request, response, "admin")) return;
    ok(response, reservations.resourceRecover(params.id, { role: "admin" }));
  }, { auth: true });

  route("POST", "/api/v1/admin/resources/:id/retire", async (request, response, body, params) => {
    if (!requireRole(request, response, "admin")) return;
    ok(response, reservations.resourceRetire(params.id, body.note, { role: "admin" }));
  }, { auth: true });

  route("GET", "/api/v1/admin/audit", async (request, response) => {
    if (!requireRole(request, response, "admin")) return;
    const url = new URL(request.url, "http://localhost");
    ok(response, {
      events: reservations.queryAudit({
        category: url.searchParams.get("category"),
        slotId: url.searchParams.get("slotId"),
        applicationId: url.searchParams.get("applicationId"),
        limit: Number(url.searchParams.get("limit") ?? 100),
      }),
    });
  }, { auth: true });

  route("GET", "/api/v1/admin/notifications", async (request, response) => {
    if (!requireRole(request, response, "admin")) return;
    const url = new URL(request.url, "http://localhost");
    ok(response, {
      notifications: reservations.listNotifications({
        applicationId: url.searchParams.get("applicationId"),
        type: url.searchParams.get("type"),
        limit: Number(url.searchParams.get("limit") ?? 100),
      }),
    });
  }, { auth: true });

  route("POST", "/api/v1/admin/tick", async (request, response) => {
    if (!requireRole(request, response, "admin")) return;
    ok(response, reservations.runTimedOperations());
  }, { auth: true });

  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const match = routes.find((candidate) => {
      if (candidate.method !== request.method) return false;
      return candidate.regex.test(pathname);
    });
    if (!match) {
      sendJson(response, 404, { error: "NOT_FOUND", message: "接口不存在" });
      return;
    }
    let body = {};
    try {
      if (request.method !== "GET" && request.method !== "HEAD") body = await readBody(request);
      const captures = pathname.match(match.regex).slice(1);
      const params = Object.fromEntries(match.names.map((name, index) => [name, decodeURIComponent(captures[index])]));
      await match.handler(request, response, body, params);
    } catch (error) {
      if (response.headersSent) return;
      const status = error.status ?? 500;
      const payload = {
        error: error.code ?? "INTERNAL_ERROR",
        message: error.status ? error.message : "服务内部错误",
      };
      if (error.details) payload.details = error.details;
      sendJson(response, status, payload);
    }
  });

  return server;
}
