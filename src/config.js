import path from "node:path";

export function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR ?? path.join(process.cwd(), ".data");
  return {
    port: Number.parseInt(env.PORT ?? "8000", 10),
    host: env.HOST ?? "0.0.0.0",
    dataDir,
    stateFile: path.join(dataDir, "state.json"),
    sweepIntervalMs: Number.parseInt(env.SWEEP_INTERVAL_MS ?? "30000", 10),
  };
}

export const ROLES = Object.freeze({
  ADMIN: "管理员",
  STAFF: "现场工作人员",
  VIEWER: "只读访客",
});
