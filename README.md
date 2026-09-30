# 🎭 走词台 CueDesk

小剧场网页「走词台」（提词台）：编辑者录入有序字幕并发布演出版本；操作员在演出时取得**有时限的控制权**推进、回退、清屏；观众页实时显示当前字幕。

纯本地部署：Node.js + SQLite + 浏览器 WebSocket，**不依赖任何外部服务**（无需 Redis / 消息队列 / CDN）。

## 核心规则（已在服务端强制）

| 需求 | 实现 |
|---|---|
| 发布后的修改仅进入草稿，演出字幕保持原版本 | 草稿表 `draft_entries` 与版本表 `versions/entries` 物理隔离；发布生成不可变快照，开始演出时锁定版本 ID，之后发布新版本不影响台上 |
| 同一场次仅一人持有控制权，有时限，过期可被接管 | 每场一条控制权记录 + 随机 token，默认 60 秒过期；未过期他人申请返回 `423`，过期后任何人可接管，旧 token 立即失效 |
| 每次操作基于页面所见状态版本 | 每个运行时状态带单调递增 `rev`；提交必须带 `expected_rev`，不一致返回 `409 STALE_STATE`，状态不变 |
| 重复提交不改变状态 | 每次操作带客户端生成的 `opId`，服务端 `ops` 表去重；同一 `opId` 重放返回首次裁决结果（含首次被拒原因），不再次执行 |
| 失效控制权不得改变状态 | token 不符/缺失/过期返回 `403`，状态不变 |
| 观众页实时显示，断线重连、服务重启后恢复 | WebSocket 推送；重连首帧下发最新已确认状态；状态全部持久化在 SQLite（WAL），重启进程后 HTTP 与 WS 均恢复 |
| 空字幕、重复序号拒绝 | 保存草稿/发布时校验：至少一条、序号为正整数且唯一、内容非空，返回 `400` 并指明条目 |
| 演出中切换版本拒绝 | 演出进行中再次「开始演出」返回 `409`（需先结束演出） |

## 一键启动（Docker Compose）

```bash
docker compose up -d --build
```

打开浏览器访问：

- 首页 / 场次列表：<http://localhost:8080/>
- 编辑器（编辑者）：`http://localhost:8080/editor.html?show=<场次ID>`（首页点「编辑」进入）
- 操作员台：`http://localhost:8080/operator.html?show=<场次ID>`
- 观众屏（投影/提词屏）：`http://localhost:8080/stage.html?show=<场次ID>`

首次启动会自动建库并创建一个「示例：今晚八点场」，含 4 条已发布字幕，可直接用来走一遍流程。

停止：

```bash
docker compose down            # 保留数据
docker compose down -v         # 同时删除数据卷
```

查看日志：`docker compose logs -f`

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | 容器内监听端口 |
| `CONTROL_TTL_SECONDS` | `60` | 控制权有效期（秒）；过期后同场次其他人可接管。操作员台会在剩余约 1/3 有效期时自动续期（页面保持打开即持续持有） |
| `DATA_DIR` | `/data`（容器）/ `./data`（本机直跑） | SQLite 数据库目录 |

通过宿主机端口或 TTL 覆盖启动：

```bash
PORT=9090 CONTROL_TTL_SECONDS=30 docker compose up -d --build
# 然后访问 http://localhost:9090/
```

数据保存在 Docker 卷 `cuedesk-data`（挂载到容器 `/data`，含 SQLite WAL 文件）。想改用宿主机目录，可把 compose 里的
`cuedesk-data:/data` 改成 `./data:/data`。

## 不用 Docker，本机直跑

需要 Node.js ≥ 20（better-sqlite3 安装时会本地编译，需有 python3/make/g++）：

```bash
npm ci
npm start
# → http://localhost:8080/
```

可选：`PORT=8080 CONTROL_TTL_SECONDS=60 DATA_DIR=./data npm start`

## 操作流程

1. **编辑者**：首页创建场次 → 编辑器录入「序号 + 字幕」（可一键重排连续序号）→ 保存草稿 → 填备注 → 发布为新版本。可反复修改草稿、发布新版本；已发布版本不可变。
2. **操作员**：打开操作员台，输入姓名「取得控制权」（右上角显示倒计时，可续期/释放）→ 选择已发布版本 →「开始演出」锁定该版本 → 用 `推进 / 回退 / 清屏` 或键盘 `→ / ← / 空格` 操作。
3. **观众屏**：全屏打开 `stage.html`，字幕实时切换；网络中断会自动重连并恢复最新字幕，无需人工干预。
4. 控制权过期未续期时，同场次另一名操作员可立即「取得控制权」接管，原持有者的操作会被拒绝并提示原因。

所有被拒绝的操作（旧版本、重复提交、控制权失效/过期、越界操作、非法内容）都会在页面提示明确原因，**状态绝不被改变**。

## HTTP 接口摘要

- `GET  /api/shows` / `POST /api/shows`
- `GET/PUT /api/shows/:id/draft`（PUT body：`{entries:[{seq,text}]}`）
- `POST /api/shows/:id/publish`（`{note}`）
- `GET  /api/shows/:id/versions` / `GET /api/shows/:id/versions/:vid`
- `POST /api/shows/:id/control`（`{holder, opId}` → 返回 `token`）
- `POST /api/shows/:id/control/renew` / `…/control/release`
- `POST /api/shows/:id/start`（`{versionId?, token, opId, expectedRev}`）
- `POST /api/shows/:id/end` / `…/advance` / `…/back` / `…/clear`（均需 `{token, opId, expectedRev}`）
- `GET  /api/shows/:id` → 最新已确认状态（含 `rev`、`status`、`current_text`、`control`）
- WebSocket：`/ws?show=<场次ID>`，连接即推送 `{type:'state', state}`，之后每次状态变化广播

错误响应：`{ "error": "<CODE>", "message": "<中文原因>" }`，代码包括
`VALIDATION_ERROR / CONTROL_BUSY(423) / CONTROL_REQUIRED(403) / STALE_STATE / DUPLICATE_SUBMISSION / CONFLICT / NOT_FOUND`。

## 目录结构

```
Dockerfile            # 多阶段构建：编译 better-sqlite3 原生模块
docker-compose.yml    # 一键启动 + 数据卷
src/db.js             # SQLite 建表、校验、事务化领域逻辑（乐观并发/去重/控制权）
src/server.js         # Express API + WebSocket 实时广播
public/               # 首页 / 编辑器 / 操作员台 / 观众屏（无框架，原生 JS）
```
