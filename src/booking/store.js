import fs from "node:fs";
import path from "node:path";

/**
 * 单一 JSON 文件状态库。
 * - 所有业务变更经 mutate() 串行执行，崩溃时只可能停在变更前或原子 rename 之后。
 * - dueQueue 持久化“到期任务”（暂留释放 / 候补过期），重启后按原截止时间补执行。
 */
export class JsonStore {
  constructor(filePath, logger = console) {
    this.filePath = filePath;
    this.logger = logger;
    this.state = emptyState();
    this.chain = Promise.resolve();
    this.afterPersist = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = { ...emptyState(), ...parsed };
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return this.state;
  }

  /** 串行执行一次变更；fn 直接修改 state，返回值透传 */
  async mutate(fn) {
    const run = this.chain.then(() => fn(this.state));
    // 串行化但不让单个失败打断后续任务
    this.chain = run.then(() => undefined, () => undefined);
    const result = await run;
    await this.persist();
    return result;
  }

  /** 只读快照访问 */
  read(fn) {
    return fn(this.state);
  }

  async persist() {
    if (!this.filePath || this.filePath === ":memory:") {
      this.afterPersist?.();
      return;
    }
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.filePath);
    this.afterPersist?.();
  }
}

export function emptyState() {
  return {
    version: 1,
    applications: {}, // code -> application
    identityIndex: {}, // hash -> [code]
    slotIndex: {}, // slotKey -> { capacityOverrides, applications: [code] }
    dueQueue: [], // { dueAt, type, refCode, seq }
    outages: [], // 班次 / 资源池临时故障记录
    auditLog: [], // 审计事件
    notifications: {}, // idempotencyKey -> notification record
    counters: { dueSeq: 1, auditSeq: 1 },
  };
}
