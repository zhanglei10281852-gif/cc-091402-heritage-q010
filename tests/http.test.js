import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { makeHarness, bookInput, injectSlot } from "./helpers.js";

async function startServer(harness) {
  const server = createApp(harness.container, { env: { ADMIN_TOKEN: "admin-secret", STAFF_TOKEN: "staff-secret" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("公共到管理的完整 HTTP 流程与角色隔离", async (context) => {
  const h = makeHarness();
  const { base, close } = await startServer(h);
  context.after(close);

  // 公共时段列表
  let res = await fetch(`${base}/api/v1/slots`);
  assert.equal(res.status, 200);
  const slots = (await res.json()).slots;
  assert.ok(slots.length > 0);

  const slot = injectSlot(h, { capacity: 1 });
  // 预约
  res = await fetch(`${base}/api/v1/applications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bookInput(slot.id)),
  });
  assert.equal(res.status, 201);
  const first = await res.json();
  assert.equal(first.application.status, "CONFIRMED");
  assert.ok(first.manageToken);

  // 第二人候补
  res = await fetch(`${base}/api/v1/applications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bookInput(slot.id)),
  });
  const second = await res.json();
  assert.equal(second.application.status, "WAITLISTED");

  // 无令牌不能查自助页
  res = await fetch(`${base}/api/v1/applications/${first.application.reference}`);
  assert.equal(res.status, 401);

  // 带管理令牌可查看
  res = await fetch(`${base}/api/v1/applications/${first.application.reference}`, {
    headers: { "x-manage-token": first.manageToken },
  });
  assert.equal(res.status, 200);

  // 现场角色：无令牌 401，现场令牌 200
  res = await fetch(`${base}/api/v1/staff/slots/${slot.id}/roster`);
  assert.equal(res.status, 401);
  res = await fetch(`${base}/api/v1/staff/slots/${slot.id}/roster`, {
    headers: { "x-api-token": "staff-secret" },
  });
  assert.equal(res.status, 200);
  const roster = await res.json();
  assert.equal(roster.confirmedCount, 1);

  // 现场角色不能访问管理审计
  res = await fetch(`${base}/api/v1/admin/audit`, { headers: { "x-api-token": "staff-secret" } });
  assert.equal(res.status, 403);

  // 管理员取消第一人 -> 候补晋级
  const firstId = h.store.state.applications[0].id;
  res = await fetch(`${base}/api/v1/admin/applications/${firstId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-token": "admin-secret" },
    body: JSON.stringify({ reason: "核实冲突" }),
  });
  assert.equal(res.status, 200);

  // 审计可查：名额释放与候补晋级
  res = await fetch(`${base}/api/v1/admin/audit?category=CAPACITY`, {
    headers: { "x-api-token": "admin-secret" },
  });
  const audit = await res.json();
  assert.ok(audit.events.some((e) => e.action === "SEATS_RELEASED"));
  assert.ok(audit.events.some((e) => e.action === "WAITLIST_PROMOTED"));

  // 通知结果可查，含掩码收件人，且幂等只发一次
  res = await fetch(`${base}/api/v1/admin/notifications?type=PROMOTED`, {
    headers: { "x-api-token": "admin-secret" },
  });
  const notifications = (await res.json()).notifications;
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].recipient, /\*{4}/);
});

test("资源故障经 API 触发改派，审计记录服务承诺变更", async (context) => {
  const h = makeHarness();
  const { base, close } = await startServer(h);
  context.after(close);

  const target = h.store.state.tourSchedules
    .filter((tour) => tour.startsAt.includes("T10:00"))
    .find((tour) => h.store.state.tourSchedules.some((t) => t.slotId === tour.slotId && t.id !== tour.id));

  const res = await fetch(`${base}/api/v1/applications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bookInput(target.slotId, { serviceTypes: ["SIGN_LANGUAGE"] })),
  });
  assert.equal(res.status, 201);

  const down = await fetch(`${base}/api/v1/admin/resources/${target.interpreterResourceId}/down`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-token": "admin-secret" },
    body: JSON.stringify({ note: "设备故障" }),
  });
  assert.equal(down.status, 200);
  const body = await down.json();
  assert.equal(body.status, "DOWN");

  const auditRes = await fetch(`${base}/api/v1/admin/audit?category=SERVICE_COMMITMENT`, {
    headers: { "x-api-token": "admin-secret" },
  });
  const { events } = await auditRes.json();
  assert.ok(events.some((e) => e.action === "REALLOCATED"));
});

test("观众凭管理令牌自助修改人数；无令牌被拒", async (context) => {
  const h = makeHarness();
  const { base, close } = await startServer(h);
  context.after(close);

  const slot = injectSlot(h, { capacity: 3 });
  const created = await fetch(`${base}/api/v1/applications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bookInput(slot.id, { partySize: 1 })),
  });
  const { application, manageToken } = await created.json();

  const noToken = await fetch(`${base}/api/v1/applications/${application.reference}/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ partySize: 2 }),
  });
  assert.equal(noToken.status, 401);

  const ok = await fetch(`${base}/api/v1/applications/${application.reference}/update`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-manage-token": manageToken },
    body: JSON.stringify({ partySize: 2 }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).partySize, 2);
});

test("非法 JSON 与未知路由返回结构化错误", async (context) => {  const h = makeHarness();
  const { base, close } = await startServer(h);
  context.after(close);

  const res = await fetch(`${base}/api/v1/applications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "BAD_JSON");

  const missing = await fetch(`${base}/api/v1/nope`);
  assert.equal(missing.status, 404);
});
