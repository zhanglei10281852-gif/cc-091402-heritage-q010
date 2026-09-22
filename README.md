# 文物公共教育预约与服务协调服务

面向热门文物数字展的团体/个人预约后端：管理展厅时段容量、导览班次、无障碍服务资源、候补队列与通知。

## 运行

需要 Node.js 22+。

```bash
npm ci
npm start          # 默认 :8000
npm test           # 内置 test runner，零外部依赖
docker compose up --build
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATA_FILE` | `data/booking-state.json` | JSON 状态文件（原子 rename 落盘）；测试用 `:memory:` |
| `STAFF_API_KEY` | 无 | 一线工作人员接口密钥（`x-api-key`） |
| `ADMIN_API_KEY` | 无 | 管理员接口密钥（`x-api-key`） |
| `PORT` / `HOST` | `8000` / `0.0.0.0` | 监听地址 |

参考数据位于 `reference/booking/`：`catalog.json`（时段容量、班次、资源池、节假日）、
`failover-rules.json`（故障改派规则）、`notification-templates.json`（通知模板）。

## 领域模型

- **时段（slot）**：展厅 + 日期 + 场次。总容量中含 `accessibleHeld` 个无障碍保留位；
  开场前 24h 的保护窗口内，保留位只可被无障碍需求者占用，窗口过后对普通申请释放。
- **申请（application）** 状态机：
  - `held`：名额已暂留，须在 30 分钟内（且不晚于开场前 30 分钟预约关闭点）确认；
  - `confirmed`：已确认；
  - `waitlisted`：容量不足进入候补，带过期时间（默认 72h，不晚于预约关闭点）；
  - `cancelled` / `expired`：终态。
- **容量三层约束**：时段座位 → 导览班次（standard/sign，团体可跨班次拆分，各分片不得超容）
  → 服务资源池（轮椅主用/备用）。
- **候补晋级**：只依据"当前真实空闲容量"分配，无障碍需求优先、其后 FIFO；
  候补过期不释放任何名额，**不可能挤掉已确认者**。
- **故障改派**：管理员上报班次/资源池故障后，按 `failover-rules.json` 重新分配，
  通知中说明原因与新旧安排；无完整替代方案时保留时段名额、仅标记服务不可用并通知可改期/取消；
  故障恢复时补登承诺，容量仍不足的承诺在后续名额释放时优先于候补重试。

## 可靠性与幂等

- 所有变更在单进程内串行提交并原子落盘；通知经 outbox 以业务幂等键发送
  （如 `cancel:<code>`、`promote:<code>`），重复触发只投递一次，失败的通知重启后重投。
- 暂留释放、候补过期、故障恢复均为持久化到期任务；重启时按**原截止时间**补偿执行，
  运行中由持久化回调驱动定时器，新入队任务立即生效。
- 证件号只保存 SHA-256 哈希与掩码；申请人凭不透明管理令牌自助查看/确认/取消/改期。

## 接口（摘要）

申请人（自助，令牌在创建申请时返回）：

- `POST /api/applications`
- `GET  /api/applications/:code?token=…`
- `POST /api/applications/:code/{confirm|cancel|reschedule}`
- `GET  /api/catalog/days`、`GET /api/catalog/halls/:hallId/slots?date=…`

一线工作人员（`x-api-key: $STAFF_API_KEY`，仅履约信息，无证件/电话/需求原因）：

- `GET  /api/staff/halls/:hallId/dates/:date/roster`
- `GET  /api/staff/applications/:code/verification`
- `POST /api/staff/applications/:code/notify`（系统代联，不回显手机号）

管理员（`x-api-key: $ADMIN_API_KEY`）：

- `GET  /api/admin/applications[?status=&slotKey=]`、`GET /api/admin/applications/:code`
- `POST /api/admin/applications/:code/{cancel|reschedule}`
- `GET  /api/admin/audit[?action=&slotKey=&refCode=]`（名额变化/服务承诺，含前后用量快照）
- `GET  /api/admin/notifications[?refCode=&status=]`（投递结果可审计）
- `POST /api/admin/outages`、`POST /api/admin/outages/:id/resolve`、`GET /api/admin/outages`
- `POST /api/admin/maintenance/run-due`
