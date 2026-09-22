import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { after } from "node:test";
import { createApp } from "../src/app.js";

const servers = new Set();
after(async () => {
  await Promise.all(
    [...servers].map(
      (server) => new Promise((resolve) => (server.listening ? server.close(resolve) : resolve())),
    ),
  );
  servers.clear();
});

export const SILENT_LOGGER = { info() {}, warn() {}, error() {}, log() {} };

let idCounter = 0;

export function makeHarness(options = {}) {
  let current = new Date(options.now ?? "2026-09-22T08:00:00+08:00");
  const sent = [];
  const failOnce = new Set(options.failDelivery ?? []);
  const deliverer = async (msg) => {
    sent.push(msg);
    if (failOnce.has(msg.id)) {
      failOnce.delete(msg.id);
      throw new Error("模拟网关抖动");
    }
  };

  const app = createApp({
    dataFile: options.dataFile ?? ":memory:",
    clock: () => new Date(current),
    deliverer,
    logger: SILENT_LOGGER,
    staffKey: "staff-key",
    adminKey: "admin-key",
  });

  return {
    app,
    service: app.service,
    store: app.store,
    notifications: app.notifications,
    config: app.config,
    sent,
    setNow(iso) {
      current = new Date(iso);
    },
    advanceMs(ms) {
      current = new Date(current.getTime() + ms);
    },
    advance(minutes) {
      this.advanceMs(minutes * 60_000);
    },
  };
}

export function uniqueIdNumber() {
  idCounter += 1;
  return `1101011990010${String(idCounter).padStart(4, "0")}`;
}

/** 构造一份标准申请体 */
export function applicationBody(overrides = {}) {
  return {
    hallId: "digital-gallery",
    slotDate: "2026-09-23",
    slotId: "morning",
    applicantType: "individual",
    applicantName: "张三",
    idType: "id_card",
    idNumber: uniqueIdNumber(),
    contactPhone: "13800000001",
    partySize: 1,
    needs: { signLanguage: false, wheelchairUnits: 0 },
    ...overrides,
  };
}

export async function apply(harness, overrides = {}) {
  const result = await harness.service.apply(applicationBody(overrides));
  return result;
}

export function tempDataFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "booking-test-"));
  return path.join(dir, "state.json");
}

export async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.add(server);
  return `http://127.0.0.1:${server.address().port}`;
}

export async function jsonHttp(base, pathname, options = {}) {
  const response = await fetch(base + pathname, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}
