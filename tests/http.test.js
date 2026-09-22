import assert from "node:assert/strict";
import test from "node:test";
import { makeHarness, listen, jsonHttp, apply } from "./helpers.js";

async function setup() {
  const h = makeHarness({ now: "2026-09-22T10:00:00+08:00" });
  const base = await listen(h.app);
  return { ...h, base };
}

test("申请人全流程：申请(返回令牌) -> 查看 -> 确认 -> 取消", async () => {
  const h = await setup();
  const created = await jsonHttp(h.base, "/api/applications", {
    method: "POST",
    body: {
      hallId: "digital-gallery", slotDate: "2026-09-23", slotId: "morning",
      applicantType: "individual", applicantName: "钱五", idType: "id_card",
      idNumber: "320101199203044321", contactPhone: "13912340001", partySize: 1,
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.application.status, "held");
  assert.ok(created.body.managementToken, "应返回一次性管理令牌");
  assert.ok(!JSON.stringify(created.body).includes("320101199203044321"), "不返回证件号");
  const { code } = created.body.application;
  const token = created.body.managementToken;

  // 无令牌查看被拒
  const noToken = await jsonHttp(h.base, `/api/applications/${code}`);
  assert.equal(noToken.status, 403);

  const got = await jsonHttp(h.base, `/api/applications/${code}?token=${token}`);
  assert.equal(got.status, 200);
  assert.ok(got.body.idMask.includes("*"));

  const confirmed = await jsonHttp(h.base, `/api/applications/${code}/confirm`, {
    method: "POST", body: { token },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.application.status, "confirmed");

  const cancelled = await jsonHttp(h.base, `/api/applications/${code}/cancel`, {
    method: "POST", body: { token },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.application.status, "cancelled");
});

test("一线名册：密钥校验 + 仅履约信息（无证件无电话）", async () => {
  const h = await setup();
  const a = await apply(h, {
    applicantName: "轮椅观众", partySize: 1,
    needs: { wheelchairUnits: 1 }, contactPhone: "13912340002",
  });
  await h.service.confirm(a.application.code, a.managementToken);

  // 无密钥
  const forbidden = await jsonHttp(
    h.base,
    "/api/staff/halls/digital-gallery/dates/2026-09-23/roster",
  );
  assert.equal(forbidden.status, 403);

  const roster = await jsonHttp(
    h.base,
    "/api/staff/halls/digital-gallery/dates/2026-09-23/roster",
    { headers: { "x-api-key": "staff-key" } },
  );
  assert.equal(roster.status, 200);
  assert.equal(roster.body.count, 1);
  const row = roster.body.roster[0];
  assert.ok(row.serviceItems.some((s) => s.label.includes("轮椅")));
  const raw = JSON.stringify(row);
  assert.ok(!raw.includes("13912340002"), "名册不含手机号");
  for (const forbidden of ["idType", "idHash", "idMask", "idNumber", "contactPhone", "needs", "managementToken"]) {
    assert.ok(!(forbidden in row), `名册不含 ${forbidden}`);
  }

  // staff 密钥不能访问 admin
  const adminWithStaffKey = await jsonHttp(h.base, "/api/admin/audit", {
    headers: { "x-api-key": "staff-key" },
  });
  assert.equal(adminWithStaffKey.status, 403);
});

test("工作人员代联：不回显手机号，系统发送且留痕", async () => {
  const h = await setup();
  const a = await apply(h, { contactPhone: "13912340003" });
  const resp = await jsonHttp(
    h.base,
    `/api/staff/applications/${a.application.code}/notify`,
    { method: "POST", headers: { "x-api-key": "staff-key" }, body: {} },
  );
  assert.equal(resp.status, 200);
  const msg = h.sent.find((m) => m.title === "现场服务联系");
  assert.equal(msg.to, "13912340003"); // 投递层可见，工作人员接口不可见
  assert.ok(!msg.body.includes("轮椅") && !msg.body.includes("手语"));
});

test("管理接口：审计名额变化、服务承诺与通知结果", async () => {
  const h = await setup();
  const a = await apply(h, { contactPhone: "13912340004" });
  await h.service.confirm(a.application.code, a.managementToken);

  const audit = await jsonHttp(h.base, `/api/admin/audit?refCode=${a.application.code}`, {
    headers: { "x-api-key": "admin-key" },
  });
  assert.equal(audit.status, 200);
  const actions = audit.body.events.map((e) => e.action);
  assert.deepEqual(actions, ["reservation_confirmed", "application_held"]);
  const heldEvent = audit.body.events.find((e) => e.action === "application_held");
  assert.ok(heldEvent.usageBefore);
  assert.ok(heldEvent.usageAfter);
  assert.ok(heldEvent.plan);

  const notifications = await jsonHttp(
    h.base,
    `/api/admin/notifications?refCode=${a.application.code}`,
    { headers: { "x-api-key": "admin-key" } },
  );
  assert.equal(notifications.status, 200);
  assert.equal(notifications.body.notifications.length, 2);
  assert.ok(notifications.body.notifications.every((n) => n.toMask.includes("****")));
});

test("管理接口：上报故障与解除，触发重分配并可查", async () => {
  const h = await setup();
  const a = await apply(h, {
    applicantName: "手语", partySize: 7,
    needs: { signLanguage: true }, contactPhone: "13912340005",
  });

  const outage = await jsonHttp(h.base, "/api/admin/outages", {
    method: "POST",
    headers: { "x-api-key": "admin-key" },
    body: { kind: "shift", refId: "sign-a", reason: "译员请假" },
  });
  assert.equal(outage.status, 201);
  const outageId = outage.body.outage.id;

  const detail = await jsonHttp(
    h.base,
    `/api/admin/applications/${a.application.code}`,
    { headers: { "x-api-key": "admin-key" } },
  );
  assert.equal(detail.body.application.commitments[0].label, "手语导览B组");

  const resolve = await jsonHttp(h.base, `/api/admin/outages/${outageId}/resolve`, {
    method: "POST",
    headers: { "x-api-key": "admin-key" },
  });
  assert.equal(resolve.status, 200);
});

test("一线核验：凭编号查状态与服务项，无敏感字段", async () => {
  const h = await setup();
  const a = await apply(h, {
    applicantName: "孙七", partySize: 1,
    needs: { signLanguage: true }, contactPhone: "13912340006",
  });
  await h.service.confirm(a.application.code, a.managementToken);

  const v = await jsonHttp(
    h.base,
    `/api/staff/applications/${a.application.code}/verification`,
    { headers: { "x-api-key": "staff-key" } },
  );
  assert.equal(v.status, 200);
  assert.equal(v.body.status, "confirmed");
  assert.ok(v.body.serviceItems.some((s) => s.modality === "sign"));
  for (const key of ["contactPhone", "idMask", "idType", "needs"]) {
    assert.ok(!(key in v.body), `核验视图不含 ${key}`);
  }

  // 无密钥拒绝
  const denied = await jsonHttp(h.base, `/api/staff/applications/${a.application.code}/verification`);
  assert.equal(denied.status, 403);
});

test("申请人可查看候补实时名次", async () => {
  const h = await setup();
  await apply(h, { applicantType: "group", orgName: "g1", applicantName: "1", partySize: 40, contactPhone: "1" });
  await apply(h, { applicantType: "group", orgName: "g2", applicantName: "2", partySize: 20, contactPhone: "2" });
  const wl1 = await apply(h, { applicantName: "候补1", partySize: 1, contactPhone: "3" });
  const wl2 = await apply(h, {
    applicantName: "候补2", partySize: 1,
    needs: { wheelchairUnits: 1 }, contactPhone: "4",
  });
  const rank2 = await jsonHttp(
    h.base,
    `/api/applications/${wl2.application.code}?token=${wl2.managementToken}`,
  );
  assert.equal(rank2.body.waitlistRank, 1, "无障碍候补排首位");
  const rank1 = await jsonHttp(
    h.base,
    `/api/applications/${wl1.application.code}?token=${wl1.managementToken}`,
  );
  assert.equal(rank1.body.waitlistRank, 2);
});

test("目录接口：展示闭馆日与容量占用", async () => {
  const h = await setup();
  const days = await jsonHttp(h.base, "/api/catalog/days?from=2026-09-28");
  assert.equal(days.status, 200);
  const nationalDay = days.body.find((d) => d.date === "2026-10-01");
  assert.equal(nationalDay.closed, true);

  const slots = await jsonHttp(
    h.base,
    "/api/catalog/halls/digital-gallery/slots?date=2026-09-23",
  );
  assert.equal(slots.status, 200);
  assert.equal(slots.body.slots.length, 2);
  assert.equal(slots.body.slots[0].capacity, 60);
});
