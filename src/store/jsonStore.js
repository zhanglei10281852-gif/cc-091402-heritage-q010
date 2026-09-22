import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 单进程 JSON 文档存储：状态整体驻留内存，每次业务变更后同步原子落盘，
 * 保证定时任务所依赖的截止时间在进程重启后仍然可读。
 */
export class JsonStore {
  constructor(file, initialFactory) {
    this.file = file; // null 表示纯内存模式（测试用）
    let state = null;
    if (file) {
      try {
        state = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (state === null) {
      if (!initialFactory) throw new Error(`状态文件不存在且未提供种子数据: ${file ?? "<memory>"}`);
      state = initialFactory();
      this.#persist(state);
    }
    this.state = state;
  }

  save() {
    this.#persist(this.state);
  }

  #persist(state) {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, this.file);
  }
}
