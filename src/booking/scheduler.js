/**
 * 到期任务调度器。
 * 任务（暂留释放、候补过期、故障恢复）持久化在 state.dueQueue，
 * 启动时按任务原截止时间补偿执行：错过的任务立即执行，未到点的继续等待。
 */
export class Scheduler {
  constructor({ store, handlers, clock = () => new Date() }) {
    this.store = store;
    this.handlers = handlers; // { hold_expire, waitlist_expire, restore }
    this.clock = clock;
    this.timer = null;
    this.running = false;
    this.ticking = false;
  }

  start() {
    this.running = true;
    this.sync();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  sync() {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const next = this.store.read((s) =>
      [...s.dueQueue].sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))[0],
    );
    if (!next) return;
    const delay = Math.max(0, new Date(next.dueAt).getTime() - this.clock().getTime());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch(() => this.sync());
    }, Math.min(delay, 2_147_000_000));
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async tick() {
    // tick 期间的落盘回调可能再次 sync 并设定时器；用守卫避免并发 tick
    if (this.ticking) return;
    this.ticking = true;
    try {
      // 一次取出所有已到期任务，逐个交给幂等处理器
      const due = this.store.read((s) =>
        s.dueQueue
          .filter((item) => new Date(item.dueAt) <= this.clock())
          .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt) || a.seq - b.seq),
      );
      for (const item of due) {
        const handler = this.handlers[item.type];
        if (!handler) continue;
        try {
          await handler(item.refCode, item);
        } catch {
          // 处理器内部保证幂等；单个失败不阻塞其他到期任务，下一轮重试
        }
      }
    } finally {
      this.ticking = false;
      this.sync();
    }
  }
}
