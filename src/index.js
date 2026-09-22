import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";

const app = createApp();
app.listen(port, host, async () => {
  console.log("文物公共教育预约服务已启动");
  await app.start();
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    app.stop();
    app.close(() => process.exit(0));
  });
}
