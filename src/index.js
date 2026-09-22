import { createApp } from "./app.js";
import { createContainer } from "./container.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const container = createContainer({ stateFile: config.stateFile });
const { store, reservations } = container;

const server = createApp(container);

// 定时释放与候补处理：截止时间在创建时固化并随状态落盘。
// 启动时先按持久化的原截止时间追补一次，停机期间错过的释放/晋级在重启后仍然执行。
const startupResult = reservations.runTimedOperations();
if (startupResult.actions.length > 0) {
  console.log(`启动追补定时操作 ${startupResult.actions.length} 项`, startupResult.actions);
}
const sweepTimer = setInterval(() => {
  try {
    reservations.runTimedOperations();
  } catch (error) {
    console.error("定时处理失败", error);
  }
}, config.sweepIntervalMs);
sweepTimer.unref();

server.listen(config.port, config.host, () => {
  console.log(`预约与服务协调服务已启动: ${config.host}:${config.port}`);
  if (!process.env.ADMIN_TOKEN) {
    console.log(`初始管理令牌(管理员): ${store.state.apiTokens.admin}`);
    console.log(`初始管理令牌(现场): ${store.state.apiTokens.staff}`);
  }
});

function shutdown() {
  clearInterval(sweepTimer);
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
