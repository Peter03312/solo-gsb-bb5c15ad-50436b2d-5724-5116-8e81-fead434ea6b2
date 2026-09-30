# 🎭 小剧场网页走词台（Theater Prompter）

一个完全本地化的网页走词台：**Node.js + SQLite + 浏览器 WebSocket 实时连接，无任何外部服务**。

- **编辑者**：在编辑页录入有序字幕条目（序号 + 文本），随时保存草稿、发布「演出版本」。**发布之后的修改只进入草稿，正在演出的字幕始终保持发布时的原版本**。
- **操作员**：输入名字取得**有时限**的控制权后，可推进 / 回退 / 清屏 / 载入版本 / 结束演出。**同一场次同一时刻仅一人持有控制权**；过期、主动释放后，他人可立即接管。
- **观众页**：投影或演员设备打开即大字实时显示当前字幕；**断线自动重连，服务重启后自动恢复最新已确认状态**。
- 每个操作都必须基于「页面所见的状态版本」。重复提交、基于旧版本、控制权失效或属于他人的请求一律拒绝，并返回明确中文原因。

## 一、一键启动（Docker Compose，推荐）

前置：已安装 Docker（含 Compose 插件）。

```bash
docker compose up -d --build
```

启动后访问（假设本机 IP 为 `localhost`）：

| 入口 | 地址 |
| --- | --- |
| 场次首页（建场次、进入各角色页） | http://localhost:8080/ |
| 编辑者页 | 首页点「编辑者页」，或 `http://localhost:8080/editor.html?sid=<场次ID>` |
| 操作员页 | `http://localhost:8080/operator.html?sid=<场次ID>` |
| 观众页（投影/演员手机） | `http://localhost:8080/audience.html?sid=<场次ID>` |

停止 / 查看日志：

```bash
docker compose logs -f
docker compose down            # 停止并删除容器（数据卷保留，见下）
docker compose down -v         # 同时删除字幕数据（谨慎）
```

数据保存在 Docker 命名卷 `prompter-data`（容器内 `/data/prompter.db`）中，容器重建、镜像升级后场次与演出版本不丢失。

## 二、不用 Docker 的本地启动

需要 Node.js **≥ 22.5**（使用 Node 内置的 `node:sqlite`，无需编译任何原生模块）。

```bash
npm install        # 仅安装一个纯 JS 依赖 ws
npm start          # 等价于 node --experimental-sqlite server.js
```

> Node 22 中 `node:sqlite` 为实验特性，启动参数 `--experimental-sqlite` 已在 `npm start` 与 Dockerfile 中配置好，仅有一行实验性提示，不影响使用。

## 三、配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口。Compose 中改宿主机端口请编辑 `docker-compose.yml` 的 `"宿主:8080"` 映射。 |
| `HOST` | `0.0.0.0` | 监听地址。 |
| `DB_PATH` | `./data/prompter.db`（容器内 `/data/prompter.db`） | SQLite 数据库文件路径，所在目录自动创建。 |
| `CONTROL_TTL` | `30` | 控制权默认有效秒数，服务端钳制在 **10～300 秒**；操作员每次取得/续期时也可在页面上自选 10～300 秒。 |

Compose 示例（改端口与默认时长）：

```yaml
ports:
  - "8081:8080"
environment:
  CONTROL_TTL: "60"
```

## 四、使用流程

1. 打开首页「新建场次」，得到一个场次及三个角色页链接。
2. **编辑者页**：逐行填写序号与字幕内容 →「保存草稿」可随时暂存；确认无误后「发布为演出版本」。
   - 校验规则：序号必须是正整数且**不可重复**；字幕文本**不能为空**；空草稿**不能发布**。
   - 发布后草稿自动清空，可继续编排下一版；历史版本永久保留。
3. **操作员页**：填写名字、选择时长 →「取得控制权」。
   - 页面显示倒计时，可「续期」或「释放」；到期未续则自动失效，他人点「取得/接管」即可。
   - 「载入版本」选择一个已发布版本开始演出（载入后为清屏，按「推进」显示第一条）。
   - 演出中可 推进 / 回退 / 清屏；**演出中不允许切换版本**，需先「结束演出」再载入其他版本。
4. **观众页**：打开后无需任何操作，自动跟随舞台；建议浏览器全屏（F11）。

## 五、一致性与冲突处理（设计要点）

- **状态版本 `stateVersion`**：每场演出维护一个单调递增版本号，随每次被接受的舞台操作 +1。操作请求必须携带页面当前所见的版本号：
  - 与服务器一致才执行；不一致返回 `409 STALE_STATE` 并提示「你的页面基于 vN，服务器当前为 vM」——重复点击、网络重试、基于旧页面的提交都不会改变状态。
  - 页面同时通过 WebSocket 实时收到权威状态，冲突后自动与服务器对齐。
- **控制权**：每场最多一条控制权记录（含随机 token、持用人、到期时间）。
  - 仍被他人持有且未过期 → `409 CONTROL_HELD`；token 缺失/错误/已过期 → `403 NO_CONTROL / CONTROL_OTHER / CONTROL_EXPIRED`。
  - 所有校验在 SQLite 事务（`BEGIN IMMEDIATE`）内完成；后台清扫仅按 `(场次, token)` 精确删除到期记录，不会误删并发取得的新控制权。
- **版本不可变**：发布时把草稿条目复制成独立的 published 版本；之后任何编辑都发生在新草稿上。舞台引用的版本 ID 不变，所以「演出中的字幕保持原版本」。
- **持久化与恢复**：当前版本、位置、状态版本、控制权全部在 SQLite（WAL 模式）。WebSocket 每次连接（包括观众断线重连、服务进程重启后的重连）立即下发一次 `hello`，内容即数据库中的最新已确认状态。

## 六、HTTP / WebSocket 接口摘要

REST 前缀 `/api/sessions/:sid`（场次 ID 为 12 位十六进制）：

| 方法与路径 | 作用 |
| --- | --- |
| `POST /api/sessions` | 创建场次 |
| `GET  /api/sessions` | 场次列表 |
| `GET  /api/sessions/:sid` | 场次详情（含当前状态） |
| `GET/PUT /api/sessions/:sid/draft` | 读取 / 替换草稿条目 |
| `POST /api/sessions/:sid/publish` | 发布草稿为新版本（空/重复序号拒绝） |
| `GET  /api/sessions/:sid/versions[/:id]` | 已发布版本列表 / 详情 |
| `GET  /api/sessions/:sid/state` | 当前已确认状态 |
| `POST /api/sessions/:sid/control/grant` | 取得或接管控制权 |
| `POST /api/sessions/:sid/control/renew` | 续期（须本人 token） |
| `POST /api/sessions/:sid/control/release` | 主动释放（须本人 token） |
| `POST /api/sessions/:sid/ops` | 舞台操作 `advance/back/clear/load/end`，须带 `token` 与 `stateVersion` |

WebSocket：`ws://<host>:8080/ws?sid=<场次ID>`，服务端消息 `hello` / `state` / `control`；客户端断线指数退避自动重连。

错误响应统一形如：

```json
{ "error": { "code": "STALE_STATE", "message": "状态版本过期：你的页面基于 v3，服务器当前为 v4，请刷新页面状态后重试（本次操作被忽略）" } }
```

## 七、目录结构

```
.
├── Dockerfile            # Node 22 精简镜像，含依赖安装与初始化
├── docker-compose.yml    # 一键启动 + 数据卷 + 健康检查
├── package.json          # 唯一运行时依赖 ws；start 已带 --experimental-sqlite
├── server.js             # HTTP API + WebSocket + SQLite 全部服务逻辑
├── public/
│   ├── index.html        # 场次首页
│   ├── editor.html       # 编辑者页
│   ├── operator.html     # 操作员页
│   ├── audience.html     # 观众页
│   ├── common.js         # API 封装 / WS 自动重连 / 通用 UI
│   └── style.css
├── test-e2e.js           # 接口端到端测试（33 项，node test-e2e.js）
└── README.md
```

自检（需先启动服务，Node ≥ 22）：

```bash
node test-e2e.js
```

局域网内其他设备访问时，把 `localhost` 换为运行机器的内网 IP 即可（同一剧场 Wi-Fi/内网）。
