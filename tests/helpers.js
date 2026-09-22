import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContainer } from "../src/container.js";
import { shanghaiDateParts } from "../src/domain/policy.js";

const BASE_NOW = "2026-09-22T10:00:00+08:00"; // 周二，避开周一闭馆

export function makeHarness({ nowIso = BASE_NOW, persist = false } = {}) {
  let now = Date.parse(nowIso);
  const clock = () => new Date(now).toISOString();
  let dir = null;
  let file = null;
  if (persist) {
    dir = mkdtempSync(path.join(tmpdir(), "resv-"));
    file = path.join(dir, "state.json");
  }
  const container = createContainer({ stateFile: file, clock, now: new Date(now) });
  return {
    container,
    svc: container.reservations,
    store: container.store,
    clock,
    get now() {
      return now;
    },
    advance(ms) {
      now += ms;
    },
    setNow(iso) {
      now = Date.parse(iso);
    },
    file,
    cleanup() {
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

let counter = 0;
export function doc(seed) {
  counter += 1;
  return `ID${String(seed ?? counter).padStart(6, "0")}2026`;
}

export function bookInput(slotId, overrides = {}) {
  return {
    slotId,
    kind: "INDIVIDUAL",
    partySize: 1,
    idDocument: doc(),
    contactName: "测试观众",
    contactPhone: "13800000000",
    ...overrides,
  };
}

/** 注入一个相对当前时钟 startsInMs 后开始的临时时段 */
export function injectSlot(harness, { id, startsInMs = 3 * 3600_000, capacity = 2, label = "测试场" } = {}) {
  const start = harness.now + startsInMs;
  const end = start + 2 * 3600_000;
  const startsAt = new Date(start).toISOString();
  const endsAt = new Date(end).toISOString();
  const slot = {
    id: id ?? `slot-test-${counter}`,
    date: shanghaiDateParts(start),
    label,
    startsAt,
    endsAt,
    capacity,
    status: "OPEN",
    closureReason: null,
  };
  harness.store.state.slots.push(slot);
  return slot;
}

export function notificationsOf(harness, applicationId) {
  return harness.store.state.notifications.filter((item) => item.applicationId === applicationId);
}
