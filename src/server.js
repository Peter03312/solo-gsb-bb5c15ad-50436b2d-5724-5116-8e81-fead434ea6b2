'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./db');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------- 工具

// 每场次维护一个订阅者集合；重连后用最新已确认状态重新初始化
const channels = new Map();

function channel(showId) {
  if (!channels.has(showId)) channels.set(showId, new Set());
  return channels.get(showId);
}

function broadcast(showId, state) {
  const msg = JSON.stringify({ type: 'state', state });
  for (const ws of channel(showId)) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// 运行时（rev）发生变化后推送
function pushState(showId) {
  const state = store.getState(showId);
  broadcast(showId, state);
  return state;
}

// 控制权到期后由定时任务发现并推送（保证他人界面及时解锁）
function sweepExpiredControl() {
  try {
    const rows = store.db.prepare(`SELECT show_id FROM runtime
      WHERE control_token IS NOT NULL AND control_until <= ?`).all(Date.now());
    for (const { show_id } of rows) {
      store.expireControl(show_id);
      pushState(show_id);
    }
    store.pruneOps();
  } catch (e) {
    console.error('[sweep]', e);
  }
}
setInterval(sweepExpiredControl, 1000);

// ---------------------------------------------------------------- 响应包装

function wrap(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((e) => {
        if (e instanceof store.DomainError) {
          return res.status(e.status).json({ error: e.code, message: e.message });
        }
        console.error('[api]', req.method, req.originalUrl, e);
        res.status(500).json({ error: 'INTERNAL', message: '服务器内部错误' });
      });
  };
}

// ---------------------------------------------------------------- 场次 / 编辑接口

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

app.get('/api/shows', wrap((req, res) => {
  res.json({ shows: store.listShows() });
}));

app.post('/api/shows', wrap((req, res) => {
  const show = store.createShow(req.body && req.body.name);
  res.status(201).json({ show });
}));

app.get('/api/shows/:id', wrap((req, res) => {
  res.json({ state: store.getState(req.params.id) });
}));

app.get('/api/shows/:id/draft', wrap((req, res) => {
  res.json({ draft: store.getDraft(req.params.id) });
}));

app.put('/api/shows/:id/draft', wrap((req, res) => {
  const { entries } = req.body || {};
  const draft = store.saveDraft(req.params.id, entries);
  res.json({ ok: true, draft });
}));

app.get('/api/shows/:id/versions', wrap((req, res) => {
  res.json({ versions: store.listVersions(req.params.id) });
}));

app.get('/api/shows/:id/versions/:vid', wrap((req, res) => {
  const v = store.db.prepare('SELECT id, version_no, note, created_at FROM versions WHERE id = ? AND show_id = ?')
    .get(req.params.vid, req.params.id);
  if (!v) return res.status(404).json({ error: 'NOT_FOUND', message: '版本不存在' });
  res.json({ version: v, entries: store.getEntries(v.id) });
}));

// 发布新版本（不可变快照；演出中发布不影响台上）
app.post('/api/shows/:id/publish', wrap((req, res) => {
  const result = store.publish(req.params.id, (req.body && req.body.note) || '');
  res.status(201).json({ ok: true, ...result });
}));

// ---------------------------------------------------------------- 操作员接口

app.post('/api/shows/:id/control', wrap((req, res) => {
  const { holder, opId } = req.body || {};
  const result = store.acquireControl(req.params.id, holder, opId);
  const state = pushState(req.params.id);
  res.status(201).json({ ok: true, ...result, state });
}));

app.post('/api/shows/:id/control/renew', wrap((req, res) => {
  const { token, opId, expectedRev } = req.body || {};
  store.renewControl(req.params.id, token, opId, expectedRev);
  res.json({ ok: true, state: pushState(req.params.id) });
}));

app.post('/api/shows/:id/control/release', wrap((req, res) => {
  const { token, opId, expectedRev } = req.body || {};
  store.releaseControl(req.params.id, token, opId, expectedRev);
  res.json({ ok: true, state: pushState(req.params.id) });
}));

app.post('/api/shows/:id/start', wrap((req, res) => {
  const { versionId, token, opId, expectedRev } = req.body || {};
  store.startPerformance(req.params.id, versionId, token, opId, expectedRev);
  res.json({ ok: true, state: pushState(req.params.id) });
}));

app.post('/api/shows/:id/end', wrap((req, res) => {
  const { token, opId, expectedRev } = req.body || {};
  store.endPerformance(req.params.id, token, opId, expectedRev);
  res.json({ ok: true, state: pushState(req.params.id) });
}));

app.post('/api/shows/:id/advance', wrap((req, res) => {
  const { token, opId, expectedRev } = req.body || {};
  store.advance(req.params.id, token, opId, expectedRev);
  res.json({ ok: true, state: pushState(req.params.id) });
}));

app.post('/api/shows/:id/back', wrap((req, res) => {
  const { token, opId, expectedRev } = req.body || {};
  store.back(req.params.id, token, opId, expectedRev);
  res.json({ ok: true, state: pushState(req.params.id) });
}));

app.post('/api/shows/:id/clear', wrap((req, res) => {
  const { token, opId, expectedRev } = req.body || {};
  store.clearScreen(req.params.id, token, opId, expectedRev);
  res.json({ ok: true, state: pushState(req.params.id) });
}));

// ---------------------------------------------------------------- WebSocket

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const showId = url.searchParams.get('show');
  if (!showId || !store.db.prepare('SELECT 1 FROM shows WHERE id = ?').get(showId)) {
    ws.send(JSON.stringify({ type: 'error', message: '场次不存在' }));
    ws.close(4004, 'unknown show');
    return;
  }

  channel(showId).add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // 重连 / 服务重启后：立即下发最新“已确认”状态
  ws.send(JSON.stringify({ type: 'state', state: store.getState(showId) }));

  ws.on('close', () => channel(showId).delete(ws));
  ws.on('error', () => channel(showId).delete(ws));
});

// 断线探测
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
wss.on('close', () => clearInterval(wsHeartbeat));

// 单页应用路由（简易，无前端框架）
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ---------------------------------------------------------------- 启动

const seeded = store.seedIfEmpty();
server.listen(PORT, HOST, () => {
  console.log(`走词台已启动: http://${HOST}:${PORT}`);
  if (seeded) console.log(`已初始化示例场次: ${seeded}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
