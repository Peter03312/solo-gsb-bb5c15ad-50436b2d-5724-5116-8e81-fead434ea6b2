/**
 * 小剧场网页走词台 —— 服务端
 *
 * 技术：Node.js 内置 http + 内置 node:sqlite（SQLite）+ ws（WebSocket）
 * 无任何外部服务。状态全部持久化在 SQLite，重启后恢复。
 *
 * 并发模型要点：
 *  - show_state.state_version 为每场演出单调递增的“所见状态版本”，
 *    操作员的推进/回退/清屏/载入/结束必须携带页面所见版本号；
 *  - 控制权 control 表每场最多一行，未过期不可被他人取得；
 *  - 所有写操作在 SQLite 事务（BEGIN IMMEDIATE）内完成。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'prompter.db');
const CONTROL_TTL = Math.min(300, Math.max(10, parseInt(process.env.CONTROL_TTL || '30', 10))); // 默认控制权秒数
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('draft','published')),
  version_no INTEGER,
  published_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS show_state(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  active_version_id INTEGER,
  pos INTEGER,
  state_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS control(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  operator TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_session ON versions(session_id);
CREATE INDEX IF NOT EXISTS idx_entries_version ON entries(version_id);
`);

// ---------------------------------------------------------------- 工具

function withTx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function httpError(status, code, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.extra = extra;
  return err;
}

function getSessionOr404(sid) {
  const s = db.prepare('SELECT id, name, created_at FROM sessions WHERE id=?').get(sid);
  if (!s) throw httpError(404, 'SESSION_NOT_FOUND', '场次不存在');
  return s;
}

function getDraftId(sid) {
  const row = db.prepare("SELECT id FROM versions WHERE session_id=? AND kind='draft'").get(sid);
  return row ? row.id : null;
}

function getControl(sid, now = Date.now()) {
  const row = db.prepare(
    'SELECT token, operator, expires_at AS expiresAt FROM control WHERE session_id=?'
  ).get(sid);
  if (!row || row.expiresAt <= now) return null;
  return { operator: row.operator, expiresAt: row.expiresAt, heldByMe: false };
}

function entryCount(versionId) {
  return db.prepare('SELECT COUNT(*) AS n FROM entries WHERE version_id=?').get(versionId).n;
}

/** 组装“当前已确认状态”——REST 与 WebSocket 推送共用，也是重启后恢复的来源 */
function getState(sid) {
  const st = db.prepare(
    'SELECT active_version_id AS activeVersionId, pos, state_version AS stateVersion FROM show_state WHERE session_id=?'
  ).get(sid);
  if (!st) return null;

  let version = null;
  let current = null;
  if (st.activeVersionId != null) {
    const v = db.prepare(
      'SELECT id, version_no AS versionNo, published_at AS publishedAt FROM versions WHERE id=?'
    ).get(st.activeVersionId);
    if (v) version = { id: v.id, versionNo: v.versionNo, publishedAt: v.publishedAt };
    if (st.pos != null) {
      const e = db.prepare(
        'SELECT seq, text FROM entries WHERE version_id=? ORDER BY seq ASC LIMIT 1 OFFSET ?'
      ).get(st.activeVersionId, st.pos - 1);
      if (e) current = { seq: e.seq, text: e.text };
    }
  }

  return {
    sessionId: sid,
    stateVersion: st.stateVersion,
    activeVersionId: st.activeVersionId,
    version,
    pos: st.pos,
    total: st.activeVersionId != null ? entryCount(st.activeVersionId) : 0,
    current,
    showing: !!(current),
  };
}

/** 校验有序字幕条目：序号必须为正整数且唯一，字幕文本不能为空 */
function parseEntries(raw) {
  if (!Array.isArray(raw)) throw httpError(400, 'INVALID_ENTRIES', '字幕条目必须是数组');
  const seen = new Set();
  const out = [];
  raw.forEach((item, i) => {
    let seq = item && item.seq;
    if (typeof seq === 'string' && seq.trim() !== '' && Number.isInteger(Number(seq.trim()))) {
      seq = Number(seq.trim());
    }
    if (!Number.isInteger(seq) || seq < 1) {
      throw httpError(400, 'INVALID_SEQ', `第 ${i + 1} 行序号无效：必须是正整数`);
    }
    if (seen.has(seq)) {
      throw httpError(409, 'DUPLICATE_SEQ', `序号 ${seq} 重复，拒绝保存`);
    }
    seen.add(seq);
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text === '') {
      throw httpError(400, 'EMPTY_TEXT', `序号 ${seq} 的字幕内容为空，拒绝保存`);
    }
    out.push({ seq, text });
  });
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

function newId() {
  return crypto.randomBytes(6).toString('hex'); // 12 位十六进制
}
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------------------------------------------------------------- 业务处理

function createSession(body) {
  const name = (body.name || '').trim() || `场次 ${new Date().toLocaleString('zh-CN')}`;
  const id = newId();
  const now = Date.now();
  withTx(() => {
    db.prepare('INSERT INTO sessions(id, name, created_at) VALUES(?,?,?)').run(id, name, now);
    db.prepare('INSERT INTO versions(session_id, kind, created_at) VALUES(?, \'draft\', ?)').run(id, now);
    db.prepare(
      'INSERT INTO show_state(session_id, active_version_id, pos, state_version) VALUES(?, NULL, NULL, 1)'
    ).run(id);
  });
  return { id, name, createdAt: now };
}

function listSessions() {
  return db.prepare('SELECT id, name, created_at AS createdAt FROM sessions ORDER BY created_at DESC').all();
}

function sessionDetail(sid) {
  const s = getSessionOr404(sid);
  return { id: s.id, name: s.name, createdAt: s.created_at, state: getState(sid) };
}

function replaceDraft(sid, entries) {
  const s = getSessionOr404(sid);
  const draftId = getDraftId(sid);
  withTx(() => {
    db.prepare('DELETE FROM entries WHERE version_id=?').run(draftId);
    const ins = db.prepare('INSERT INTO entries(version_id, seq, text) VALUES(?,?,?)');
    for (const e of entries) ins.run(draftId, e.seq, e.text);
  });
  return { draftId, count: entries.length };
}

function getDraft(sid) {
  getSessionOr404(sid);
  const draftId = getDraftId(sid);
  const rows = db.prepare('SELECT seq, text FROM entries WHERE version_id=? ORDER BY seq ASC').all(draftId);
  return { draftId, entries: rows };
}

function listVersions(sid) {
  getSessionOr404(sid);
  const rows = db.prepare(`
    SELECT v.id, v.version_no AS versionNo, v.published_at AS publishedAt,
           (SELECT COUNT(*) FROM entries e WHERE e.version_id=v.id) AS count
    FROM versions v
    WHERE v.session_id=? AND v.kind='published'
    ORDER BY v.version_no DESC
  `).all(sid);
  return rows;
}

function getVersion(sid, vid) {
  getSessionOr404(sid);
  const v = db.prepare(
    "SELECT id, version_no AS versionNo, published_at AS publishedAt FROM versions WHERE id=? AND session_id=? AND kind='published'"
  ).get(vid, sid);
  if (!v) throw httpError(404, 'VERSION_NOT_FOUND', '演出版本不存在');
  const entries = db.prepare('SELECT seq, text FROM entries WHERE version_id=? ORDER BY seq ASC').all(vid);
  return { ...v, entries };
}

/** 发布草稿为不可变演出版本，并开启一份新的空草稿；演出中的状态不受影响 */
function publish(sid, body) {
  getSessionOr404(sid);
  const entries = parseEntries(body.entries);
  if (entries.length === 0) throw httpError(400, 'EMPTY_VERSION', '演出版本不能为空，拒绝发布');

  const result = withTx(() => {
    const oldDraftId = getDraftId(sid);
    // 先把本次编辑固化到旧草稿
    db.prepare('DELETE FROM entries WHERE version_id=?').run(oldDraftId);
    const ins = db.prepare('INSERT INTO entries(version_id, seq, text) VALUES(?,?,?)');
    for (const e of entries) ins.run(oldDraftId, e.seq, e.text);

    const maxRow = db.prepare(
      "SELECT COALESCE(MAX(version_no),0) AS m FROM versions WHERE session_id=? AND kind='published'"
    ).get(sid);
    const versionNo = maxRow.m + 1;
    const now = Date.now();
    const pubInfo = db.prepare(
      "INSERT INTO versions(session_id, kind, version_no, published_at, created_at) VALUES(?, 'published', ?, ?, ?)"
    ).run(sid, versionNo, now, now);
    const pubId = Number(pubInfo.lastInsertRowid);
    const copy = db.prepare('INSERT INTO entries(version_id, seq, text) SELECT ?, seq, text FROM entries WHERE version_id=?');
    copy.run(pubId, oldDraftId);

    // 旧草稿连同其条目删除，另开一份空草稿承载之后的修改
    db.prepare('DELETE FROM versions WHERE id=?').run(oldDraftId);
    db.prepare('INSERT INTO versions(session_id, kind, created_at) VALUES(?, \'draft\', ?)').run(sid, now);
    return { id: pubId, versionNo, publishedAt: now, count: entries.length };
  });
  return result;
}

/** 取得控制权：未持有或已过期时可（接管）取得，仍被他人持有时拒绝 */
function grantControl(sid, body) {
  getSessionOr404(sid);
  const operator = (body.operator || '').trim().slice(0, 40);
  if (!operator) throw httpError(400, 'NO_OPERATOR', '请填写操作员名称');
  let ttl = parseInt(body.ttl, 10);
  if (!Number.isFinite(ttl)) ttl = CONTROL_TTL;
  ttl = Math.min(300, Math.max(10, ttl));

  const now = Date.now();
  const res = withTx(() => {
    const cur = db.prepare('SELECT operator, expires_at AS expiresAt FROM control WHERE session_id=?').get(sid);
    if (cur && cur.expiresAt > now) {
      throw httpError(409, 'CONTROL_HELD',
        `控制权仍由「${cur.operator}」持有（${Math.ceil((cur.expiresAt - now) / 1000)} 秒后到期），到期后可接管`);
    }
    const token = newToken();
    const expiresAt = now + ttl * 1000;
    db.prepare(
      'INSERT INTO control(session_id, token, operator, expires_at) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET token=excluded.token, operator=excluded.operator, expires_at=excluded.expires_at'
    ).run(sid, token, operator, expiresAt);
    return { token, operator, expiresAt, ttl };
  });
  broadcastControl(sid);
  return res;
}

function requireHolder(sid, token) {
  if (!token) throw httpError(403, 'NO_CONTROL', '未携带控制权凭证，请先取得控制权');
  const row = db.prepare(
    'SELECT token, operator, expires_at AS expiresAt FROM control WHERE session_id=?'
  ).get(sid);
  const now = Date.now();
  if (!row || row.expiresAt <= now) {
    throw httpError(403, 'CONTROL_EXPIRED', '控制权已失效或已过期，请重新取得（或接管）控制权');
  }
  if (row.token !== token) {
    throw httpError(403, 'CONTROL_OTHER', `控制权当前属于「${row.operator}」，你的操作不被接受`);
  }
  return row;
}

function renewControl(sid, body) {
  getSessionOr404(sid);
  requireHolder(sid, body.token);
  let ttl = parseInt(body.ttl, 10);
  if (!Number.isFinite(ttl)) ttl = CONTROL_TTL;
  ttl = Math.min(300, Math.max(10, ttl));
  const expiresAt = Date.now() + ttl * 1000;
  db.prepare('UPDATE control SET expires_at=? WHERE session_id=?').run(expiresAt, sid);
  broadcastControl(sid);
  return { expiresAt, ttl };
}

function releaseControl(sid, body) {
  getSessionOr404(sid);
  requireHolder(sid, body.token);
  db.prepare('DELETE FROM control WHERE session_id=?').run(sid);
  broadcastControl(sid);
  return { released: true };
}

/**
 * 执行一次舞台操作。必须同时满足：
 *  1) 控制权有效且属于本人；
 *  2) 携带的 stateVersion 与库中当前版本一致（防重复提交/旧版本覆盖）。
 */
function performOp(sid, body) {
  getSessionOr404(sid);
  requireHolder(sid, body.token);

  const expected = parseInt(body.stateVersion, 10);
  if (!Number.isInteger(expected)) {
    throw httpError(400, 'NO_STATE_VERSION', '操作必须基于页面所见的状态版本（stateVersion 缺失）');
  }
  const action = body.action;
  const ALLOWED = ['advance', 'back', 'clear', 'load', 'end'];
  if (!ALLOWED.includes(action)) throw httpError(400, 'BAD_ACTION', `未知操作：${action}`);

  withTx(() => {
    const st = db.prepare(
      'SELECT active_version_id AS vid, pos, state_version AS sv FROM show_state WHERE session_id=?'
    ).get(sid);
    if (st.sv !== expected) {
      throw httpError(409, 'STALE_STATE',
        `状态版本过期：你的页面基于 v${expected}，服务器当前为 v${st.sv}，请刷新页面状态后重试（本次操作被忽略）`);
    }

    let newVid = st.vid;
    let newPos = st.pos;

    if (action === 'advance') {
      if (st.vid == null) throw httpError(409, 'NOT_LOADED', '尚未载入演出版本，无法推进');
      const total = entryCount(st.vid);
      if (total === 0) throw httpError(409, 'EMPTY_VERSION', '当前版本没有字幕条目');
      const next = st.pos == null ? 1 : st.pos + 1;
      if (next > total) throw httpError(409, 'AT_END', `已是最后一条（共 ${total} 条），无法继续推进`);
      newPos = next;
    } else if (action === 'back') {
      if (st.vid == null) throw httpError(409, 'NOT_LOADED', '尚未载入演出版本');
      if (st.pos == null) throw httpError(409, 'SCREEN_CLEAR', '当前为清屏状态，请用「推进」显示第一条');
      if (st.pos <= 1) throw httpError(409, 'AT_START', '已是第一条，无法回退');
      newPos = st.pos - 1;
    } else if (action === 'clear') {
      if (st.vid != null && st.pos == null) {
        throw httpError(409, 'ALREADY_CLEAR', '屏幕已清空，重复清屏操作被拒绝');
      }
      newPos = null;
    } else if (action === 'load') {
      if (st.vid != null) {
        throw httpError(409, 'SHOW_IN_PROGRESS', '演出进行中不可切换版本，请先「结束演出」再载入其他版本');
      }
      const vid = parseInt(body.versionId, 10);
      const v = db.prepare(
        "SELECT id FROM versions WHERE id=? AND session_id=? AND kind='published'"
      ).get(vid, sid);
      if (!v) throw httpError(404, 'VERSION_NOT_FOUND', '要载入的演出版本不存在');
      if (entryCount(vid) === 0) throw httpError(409, 'EMPTY_VERSION', '该版本没有字幕条目，拒绝载入');
      newVid = vid;
      newPos = null; // 载入后先清屏，首次「推进」显示第一条
    } else if (action === 'end') {
      if (st.vid == null) throw httpError(409, 'NOT_SHOWING', '当前没有进行中的演出');
      newVid = null;
      newPos = null;
    }

    db.prepare(
      'UPDATE show_state SET active_version_id=?, pos=?, state_version=state_version+1 WHERE session_id=?'
    ).run(newVid, newPos, sid);
  });

  const state = getState(sid);
  broadcastState(sid, state);
  return state;
}

// ---------------------------------------------------------------- HTTP API

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'BODY_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('未找到页面');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

/** 路由：[方法, 正则, 处理函数(需要 body 时自动解析)] */
const routes = [
  ['GET',    /^\/api\/health$/,                             (p, b, req) => ({ ok: true, time: Date.now() })],
  ['GET',    /^\/api\/sessions$/,                           () => ({ sessions: listSessions() })],
  ['POST',   /^\/api\/sessions$/,                           (p, b) => createSession(b)],
  ['GET',    /^\/api\/sessions\/([0-9a-f]{12})$/,           (p) => sessionDetail(p[0])],
  ['GET',    /^\/api\/sessions\/([0-9a-f]{12})\/draft$/,    (p) => getDraft(p[0])],
  ['PUT',    /^\/api\/sessions\/([0-9a-f]{12})\/draft$/,    (p, b) => replaceDraft(p[0], parseEntries(b.entries))],
  ['POST',   /^\/api\/sessions\/([0-9a-f]{12})\/publish$/,  (p, b) => publish(p[0], b)],
  ['GET',    /^\/api\/sessions\/([0-9a-f]{12})\/versions$/, (p) => ({ versions: listVersions(p[0]) })],
  ['GET',    /^\/api\/sessions\/([0-9a-f]{12})\/versions\/(\d+)$/, (p) => getVersion(p[0], Number(p[1]))],
  ['GET',    /^\/api\/sessions\/([0-9a-f]{12})\/state$/,    (p) => getState(p[0])],
  ['GET',    /^\/api\/sessions\/([0-9a-f]{12})\/control$/,  (p) => ({ control: controlView(p[0]) })],
  ['POST',   /^\/api\/sessions\/([0-9a-f]{12})\/control\/grant$/,   (p, b) => grantControl(p[0], b)],
  ['POST',   /^\/api\/sessions\/([0-9a-f]{12})\/control\/renew$/,   (p, b) => renewControl(p[0], b)],
  ['POST',   /^\/api\/sessions\/([0-9a-f]{12})\/control\/release$/, (p, b) => releaseControl(p[0], b)],
  ['POST',   /^\/api\/sessions\/([0-9a-f]{12})\/ops$/,      (p, b) => performOp(p[0], b)],
];

function controlView(sid) {
  const c = getControl(sid);
  return c ? { holder: c.operator, expiresAt: c.expiresAt } : { holder: null, expiresAt: null };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);

  try {
    for (const [method, re, handler] of routes) {
      if (method !== req.method) continue;
      const m = url.pathname.match(re);
      if (!m) continue;
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const data = await handler(m.slice(1), body, req);
      const payload = Buffer.from(JSON.stringify(data));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(payload);
    }
    sendError(res, httpError(404, 'NOT_FOUND', '接口不存在'));
  } catch (err) {
    sendError(res, err);
  }
});

function sendError(res, err) {
  const status = err.status || 500;
  const payload = {
    error: { code: err.code || 'INTERNAL', message: err.message || '服务器内部错误' },
  };
  if (err.extra) Object.assign(payload, err.extra);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
  if (status >= 500) console.error(err);
}

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ noServer: true });
const rooms = new Map(); // sid -> Set<ws>

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  const sid = url.searchParams.get('sid');
  if (!sid || !db.prepare('SELECT id FROM sessions WHERE id=?').get(sid)) {
    socket.write('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nUnknown session');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.sid = sid;
    wss.emit('connection', ws, req);
  });
});

function addToRoom(ws) {
  if (!rooms.has(ws.sid)) rooms.set(ws.sid, new Set());
  rooms.get(ws.sid).add(ws);
}
function removeFromRoom(ws) {
  rooms.get(ws.sid)?.delete(ws);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastState(sid, state = getState(sid)) {
  const msg = { type: 'state', state };
  rooms.get(sid)?.forEach((ws) => send(ws, msg));
}
function broadcastControl(sid) {
  const msg = { type: 'control', control: controlView(sid) };
  rooms.get(sid)?.forEach((ws) => send(ws, msg));
}

wss.on('connection', (ws) => {
  addToRoom(ws);
  // 连接（含断线重连、服务重启后重连）立即下发最新已确认状态
  send(ws, { type: 'hello', state: getState(ws.sid), control: controlView(ws.sid), serverTime: Date.now() });
  ws.on('close', () => removeFromRoom(ws));
  ws.on('error', () => removeFromRoom(ws));
});

// 定期使到期控制权失效并广播（接管者随后即可取得）
// 注意：删除必须带 token 条件——新取得的控制权会生成全新随机 token，
// 避免与并发的取得控制权事务交错时误删刚刚取得的新控制权。
setInterval(() => {
  const now = Date.now();
  const expired = db.prepare('SELECT session_id AS sid, token, expires_at AS exp FROM control WHERE expires_at <= ?').all(now);
  if (expired.length) {
    const del = db.prepare('DELETE FROM control WHERE session_id=? AND token=? AND expires_at<=?');
    for (const row of expired) {
      if (del.run(row.sid, row.token, now).changes > 0) broadcastControl(row.sid);
    }
  }
}, 2000).unref();

// ---------------------------------------------------------------- 启动 & 优雅退出

server.listen(PORT, HOST, () => {
  console.log(`走词台已启动: http://${HOST}:${PORT}  数据库: ${DB_PATH}  默认控制权时长: ${CONTROL_TTL}s`);
});

function shutdown() {
  console.log('正在关闭服务...');
  wss.clients.forEach((ws) => ws.close(1012, '服务重启'));
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
