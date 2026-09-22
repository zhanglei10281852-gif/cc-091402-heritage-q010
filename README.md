# 预约与服务协调服务

面向热门文物数字展的预约后端：管理展厅时段容量、团体/个人申请、无障碍服务资源（轮椅、手语导览）、
候补队列与节假日规则，支持观众凭管理令牌自助改期/取消而不暴露敏感需求细节。

零第三方依赖，Node.js 22 内置 `node:http` 与 `node:test`。

## 运行

```bash
npm ci
npm start            # 默认 0.0.0.0:8000
npm test             # 32 项测试
docker compose up --build
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8000` / `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./.data` | JSON 状态文件目录（原子写入，可挂载持久卷） |
| `SWEEP_INTERVAL_MS` | `30000` | 定时扫描间隔（过期候补、爽约释放、候补晋级） |
| `ADMIN_TOKEN` / `STAFF_TOKEN` | 首次启动随机生成 | 覆盖种子令牌，便于部署轮换；未设置时启动日志打印初始令牌 |

健康检查 `/health` 只表示进程存活，不代表任何业务流程已完成。

## 业务规则

- **证件唯一**：同一证件在同一时段至多一个有效（已确认/候补）预约；证件号只存 SHA-256 哈希。
- **整团原子占座**：团体（5–40 人）按整团人数判定，名额不足整体进候补，绝不拆分突破容量。
- **候补 FIFO**：按登记顺序严格先进先出；队首整团放不下时不跳过后面的候补。
- **候补截止**：开场前 60 分钟（`policy.waitlistCutoffMinutes`）候补资格失效，过期候补永不晋级、
  绝不挤掉已确认名额，即使随后有名额释放。
- **爽约释放**：开场后 15 分钟宽限（`policy.noShowGraceMinutes`）未到场，名额释放并标记 `NO_SHOW`。
- **自助改期**：开场前 60 分钟（`policy.rescheduleDeadlineMinutes`）前可改期；目标时段须整团放得下，
  且同一证件不得与目标时段已有预约冲突。
- **独立服务容量**：入场席位、手语班次耳机位（按班次）、轮椅（共享设备，时间重叠时段不可重复借出）
  分别计数。
- **资源故障重分配**：已承诺的资源故障时按「同类改派 → 服务候补（入场名额保留）→ 明确无法安排」
  处理，并发出解释变更的通知；资源恢复或有人释放时按顺序回填服务候补。
- **闭馆**：周一及节假日（种子数据含 2026 中秋/国庆示例）时段不可预约；强制闭馆会批量取消并通知。

所有截止时间（候补截止、爽约释放）在申请创建时固化到记录中并随状态落盘；进程启动先追补一次，
停机期间错过的释放/过期在重启后仍按**原截止时间**执行，定时扫描不改变任何截止点。

## 通知与幂等

每条通知以 `applicationId:type:dedupeKey` 为幂等键（确认/取消/晋级每生命周期一次、改期按次、
服务变更按服务与序号）。取消、改期、候补晋级、故障改派重复触发或重启回放都不会产生重复通知；
通知结果写入 `notifications` 并进入 `NOTIFICATION` 审计类别。

## 隐私与最小知情

- 预约响应一次性返回随机 `manageToken`（仅存哈希）；自助接口凭 `x-manage-token` 头操作，令牌不进 URL。
- 公共接口、现场履约视图、管理列表均不返回证件号、证件哈希、管理令牌、需求原文；联系电话掩码。
- 现场工作人员（`staff`）只能看到本时段履约所需：预约编号、人数、掩码电话、需要交付的服务及
  具体设备/班次；审计、容量调整、资源管理仅管理员（`admin`）可用。

## 接口

公共（无需鉴权）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/slots?date=YYYY-MM-DD` | 时段余量、候补数、无障碍资源余量 |
| GET | `/api/v1/slots/:id` / `/tours` | 时段详情 / 手语导览班次余量 |
| POST | `/api/v1/applications` | 提交申请（`kind`,`partySize`,`idDocument`,`contactPhone`,`serviceTypes`） |
| GET | `/api/v1/applications/:reference` | 自助查看（头 `x-manage-token`） |
| POST | `/api/v1/applications/:reference/update` | 自助修改人数/无障碍需求（不换时段；头或体携带 token） |
| POST | `/api/v1/applications/:reference/cancel` | 自助取消（头或体携带 token） |
| POST | `/api/v1/applications/:reference/reschedule` | 自助改期（`newSlotId`，可更新 `serviceTypes`） |

现场（`x-api-token: <staff>`）：

- `GET /api/v1/staff/slots/:id/roster` — 履约名单（最小知情视图）。

管理员（`x-api-token: <admin>`）：

- `GET /api/v1/admin/applications?slotId&status`
- `POST /api/v1/admin/applications/:id/cancel`
- `PUT /api/v1/admin/slots/:id/capacity`（不得低于已确认人数）、`POST /api/v1/admin/slots/:id/close`
- `GET /api/v1/admin/resources?type`
- `POST /api/v1/admin/resources/:id/down|recover|retire`（`resumeAt`,`note`,`force`）
- `GET /api/v1/admin/audit?category=CAPACITY|SERVICE_COMMITMENT|NOTIFICATION|APPLICATION|RESOURCE&slotId&applicationId`
- `GET /api/v1/admin/notifications?applicationId&type` — 通知发送结果
- `POST /api/v1/admin/tick` — 手动触发一次定时扫描（运维/测试用）

## 代码结构

```
src/domain/policy.js          纯业务规则与时间/节假日计算
src/data/seed.js              时段、班次、资源、节假日初始数据
src/store/jsonStore.js        原子落盘的 JSON 存储
src/services/reservationService.js  容量/候补/服务分配/故障重分配/定时处理
src/services/notificationService.js 幂等通知；notificationTemplates.js 模板
src/services/auditService.js  名额、服务承诺、通知审计
src/app.js                    HTTP 路由与基于令牌的角色鉴权
```

审计事件统一包含经办角色（`actor.role`）与发生时间（`at`），状态使用结构化枚举而非展示文本。
