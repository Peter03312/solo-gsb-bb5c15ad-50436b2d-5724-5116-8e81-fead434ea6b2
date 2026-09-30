'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'cuedesk.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS shows (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- 草稿：编辑者的可改工作副本，与已发布版本完全隔离
CREATE TABLE IF NOT EXISTS draft_entries (
  id            TEXT PRIMARY KEY,
  show_id       TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  text          TEXT NOT NULL,
  UNIQUE(show_id, seq)
);

-- 已发布版本：不可变快照
CREATE TABLE IF NOT EXISTS versions (
  id            TEXT PRIMARY KEY,
  show_id       TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  version_no    INTEGER NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  content_hash  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(show_id, version_no)
);

CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  version_id    TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  text          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_version ON entries(version_id);

CREATE TABLE IF NOT EXISTS runtime (
  show_id            TEXT PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
  rev                INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'idle',   -- idle | performing | ended
  performing_version TEXT REFERENCES versions(id) ON DELETE SET NULL,
  position           INTEGER,                        -- 条目 seq；NULL = 清屏
  controller_name    TEXT,
  control_token      TEXT,
  control_until      INTEGER
);

-- 操作去重（被拒绝的提交也记录，保证“重复提交”稳定返回同一裁决）
CREATE TABLE IF NOT EXISTS ops (
  op_id       TEXT PRIMARY KEY,
  show_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  accepted    INTEGER NOT NULL,
  reason      TEXT,
  new_rev     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_show ON ops(show_id, created_at);
`);

const now = () => Date.now();
const uuid = () => crypto.randomUUID();

const CONTROL_TTL_MS = (parseInt(process.env.CONTROL_TTL_SECONDS || '60', 10) || 60) * 1000;
const OPS_RETENTION_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 错误类型

class DomainError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const err = {
  notFound: (m) => new DomainError('NOT_FOUND', m, 404),
  validation: (m) => new DomainError('VALIDATION_ERROR', m, 400),
  conflict: (m) => new DomainError('CONFLICT', m, 409),
  controlRequired: (m) => new DomainError('CONTROL_REQUIRED', m, 403),
  controlBusy: (m) => new DomainError('CONTROL_BUSY', m, 423),
  stale: (m) => new DomainError('STALE_STATE', m, 409),
  duplicate: (m) => new DomainError('DUPLICATE_SUBMISSION', m, 409),
};

// ---------------------------------------------------------------- 条目校验

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw err.validation('字幕条目不能为空：至少需要一条字幕');
  }
  if (entries.length > 1000) {
    throw err.validation('字幕条目过多（上限 1000 条）');
  }
  const seen = new Set();
  const normalized = entries.map((e, i) => {
    const seq = Number(e && e.seq);
    if (!Number.isInteger(seq) || seq <= 0) {
      throw err.validation(`第 ${i + 1} 条的序号无效（须为正整数）`);
    }
    if (seen.has(seq)) {
      throw err.validation(`序号重复：${seq}（每条字幕的序号必须唯一）`);
    }
    seen.add(seq);
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    if (!text) {
      throw err.validation(`序号 ${seq} 的字幕为空：空字幕不允许保存/发布`);
    }
    if (text.length > 2000) {
      throw err.validation(`序号 ${seq} 的字幕过长（上限 2000 字）`);
    }
    return { seq, text };
  });
  normalized.sort((a, b) => a.seq - b.seq);
  return normalized;
}

function hashEntries(entries) {
  const h = crypto.createHash('sha256');
  for (const e of entries) h.update(e.seq + '|' + e.text + '\n');
  return h.digest('hex');
}

// ---------------------------------------------------------------- 场次 / 草稿 / 版本

function createShow(name) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) throw err.validation('场次名称不能为空');
  if (clean.length > 100) throw err.validation('场次名称过长（上限 100 字）');
  const id = uuid();
  db.prepare('INSERT INTO shows (id, name, created_at) VALUES (?, ?, ?)').run(id, clean, now());
  db.prepare('INSERT INTO runtime (show_id, rev) VALUES (?, 0)').run(id);
  return getShow(id);
}

function listShows() {
  return db.prepare(`
    SELECT s.id, s.name, s.created_at,
           r.rev, r.status, r.performing_version AS performing_version_id,
           (SELECT MAX(version_no) FROM versions v WHERE v.show_id = s.id) AS latest_version_no,
           (SELECT COUNT(*) FROM draft_entries d WHERE d.show_id = s.id) AS draft_count,
           r.controller_name, r.control_until
      FROM shows s JOIN runtime r ON r.show_id = s.id
     ORDER BY s.created_at DESC
  `).all();
}

function getShow(showId) {
  const show = db.prepare('SELECT id, name, created_at FROM shows WHERE id = ?').get(showId);
  if (!show) throw err.notFound('场次不存在');
  return show;
}

function ensureShow(showId) {
  if (!db.prepare('SELECT 1 FROM shows WHERE id = ?').get(showId)) {
    throw err.notFound('场次不存在');
  }
}

function getDraftEntries(showId) {
  return db.prepare('SELECT seq, text FROM draft_entries WHERE show_id = ? ORDER BY seq').all(showId);
}

function getDraft(showId) {
  ensureShow(showId);
  return { entries: getDraftEntries(showId) };
}

function getEntries(versionId) {
  return db.prepare('SELECT seq, text FROM entries WHERE version_id = ? ORDER BY seq').all(versionId);
}

function listVersions(showId) {
  ensureShow(showId);
  const rows = db.prepare('SELECT id, version_no, note, created_at FROM versions WHERE show_id = ? ORDER BY version_no DESC').all(showId);
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE version_id = ?');
  return rows.map((v) => ({ ...v, entry_count: countStmt.get(v.id).c }));
}

// 保存草稿：整体替换工作副本，永远不触碰任何已发布版本（含正在演出的版本）
function saveDraft(showId, entriesRaw) {
  ensureShow(showId);
  const entries = validateEntries(entriesRaw);
  db.transaction(() => {
    db.prepare('DELETE FROM draft_entries WHERE show_id = ?').run(showId);
    const ins = db.prepare('INSERT INTO draft_entries (id, show_id, seq, text) VALUES (?, ?, ?, ?)');
    for (const e of entries) ins.run(uuid(), showId, e.seq, e.text);
  })();
  return { entries };
}

// 发布：把当前草稿固化为不可变新版本。
// 演出进行中也可发布（只生成快照，演出版本已锁定、台上字幕不受影响）；
// 但“开始/切换演出版本”在演出中会被拒绝。
// 草稿内容与最新版本一致时复用该版本，避免重复发版。
function publish(showId, note) {
  ensureShow(showId);
  const noteText = typeof note === 'string' ? note.trim().slice(0, 200) : '';
  return db.transaction(() => {
    const draft = validateEntries(getDraftEntries(showId));
    const hash = hashEntries(draft);
    const latest = db.prepare('SELECT * FROM versions WHERE show_id = ? ORDER BY version_no DESC LIMIT 1').get(showId);
    if (latest && latest.content_hash === hash) {
      return { version_id: latest.id, version_no: latest.version_no, reused: true };
    }
    const nextNo = latest ? latest.version_no + 1 : 1;
    const vid = uuid();
    db.prepare('INSERT INTO versions (id, show_id, version_no, note, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(vid, showId, nextNo, noteText, hash, now());
    const ins = db.prepare('INSERT INTO entries (id, version_id, seq, text) VALUES (?, ?, ?, ?)');
    for (const e of draft) ins.run(uuid(), vid, e.seq, e.text);
    return { version_id: vid, version_no: nextNo, reused: false };
  })();
}

// ---------------------------------------------------------------- 运行时状态

function getRuntimeRow(showId) {
  const r = db.prepare('SELECT * FROM runtime WHERE show_id = ?').get(showId);
  if (!r) throw err.notFound('场次不存在');
  return r;
}

// 清理过期控制权（惰性 + 定时），返回更新后的行
function expireControl(showId, r = getRuntimeRow(showId)) {
  if (r.control_token && r.control_until && r.control_until <= now()) {
    db.prepare('UPDATE runtime SET controller_name = NULL, control_token = NULL, control_until = NULL WHERE show_id = ?')
      .run(showId);
    return getRuntimeRow(showId);
  }
  return r;
}

function getState(showId) {
  ensureShow(showId);
  const show = getShow(showId);
  let r = getRuntimeRow(showId);
  if (r.control_token && r.control_until && r.control_until <= now()) r = expireControl(showId, r);

  let currentText = null;
  let currentSeq = null;
  if (r.status === 'performing' && r.performing_version && r.position != null) {
    const row = db.prepare('SELECT seq, text FROM entries WHERE version_id = ? AND seq = ?')
      .get(r.performing_version, r.position);
    if (row) { currentSeq = row.seq; currentText = row.text; }
  }

  const pv = r.performing_version
    ? db.prepare('SELECT id, version_no, note, created_at FROM versions WHERE id = ?').get(r.performing_version)
    : null;
  const latest = db.prepare('SELECT id, version_no FROM versions WHERE show_id = ? ORDER BY version_no DESC LIMIT 1').get(showId);

  return {
    show_id: showId,
    show_name: show.name,
    rev: r.rev,
    status: r.status,                              // idle | performing | ended
    performing_version: pv ? { id: pv.id, version_no: pv.version_no, note: pv.note } : null,
    latest_version: latest ? { id: latest.id, version_no: latest.version_no } : null,
    position: r.position,                          // 当前序号，null = 清屏
    current_seq: currentSeq,
    current_text: currentText,                     // 观众屏所见；null = 清屏/无字幕
    control: r.control_token ? {
      holder: r.controller_name,
      expires_at: r.control_until,
      ttl_ms: CONTROL_TTL_MS,
    } : null,
    server_time: now(),
  };
}

// 操作去重：同一 opId 永远返回首次裁决结果，不重复执行
function checkOpId(opId, showId, kind) {
  if (!opId || typeof opId !== 'string') throw err.validation('缺少操作标识 opId（防止重复提交）');
  if (opId.length > 100) throw err.validation('opId 过长');
  const seen = db.prepare('SELECT * FROM ops WHERE op_id = ?').get(opId);
  if (seen) {
    if (seen.show_id !== showId || seen.kind !== kind) {
      throw err.duplicate(`重复提交：操作标识已被其他操作占用（首次结果：${seen.reason || '已接受'}），本次未执行`);
    }
    throw err.duplicate(seen.accepted
      ? `重复提交：该操作已执行过（状态版本 rev=${seen.new_rev}），未再次改变状态`
      : `重复提交：此前该提交已被拒绝（原因：${seen.reason}），本次仍不改变状态`);
  }
}

function recordOp(opId, showId, kind, accepted, reason, newRev) {
  db.prepare(`INSERT INTO ops (op_id, show_id, kind, accepted, reason, new_rev, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(opId, showId, kind, accepted ? 1 : 0, reason || null, newRev, now());
}

function pruneOps() {
  db.prepare('DELETE FROM ops WHERE created_at < ?').run(now() - OPS_RETENTION_MS).changes;
}

// 校验控制权
function requireControl(r, token) {
  if (!r.control_token) throw err.controlRequired('当前无人持有控制权，请先取得控制权');
  if (!token) throw err.controlRequired('缺少控制权凭证 token，请重新取得控制权');
  if (r.control_token !== token) {
    throw err.controlRequired(`控制权在「${r.controller_name || '他人'}」手中：同一场次仅一人可操作，待其释放或过期后可接管`);
  }
  if (r.control_until <= now()) {
    throw err.controlRequired('控制权已过期，请重新取得；过期后也可由他人接管');
  }
}

function bumpRev(showId) {
  db.prepare('UPDATE runtime SET rev = rev + 1 WHERE show_id = ?').run(showId);
}

// 所有运行时变更的统一事务入口：
// 去重 → 场次存在 → 控制权 → 页面状态版本(expected_rev) → 应用变更
function mutateRuntime(showId, { opId, kind, token, expectedRev }, apply) {
  ensureShow(showId);
  return db.transaction(() => {
    checkOpId(opId, showId, kind);
    const r = expireControl(showId);

    try {
      requireControl(r, token);

      const expected = Number(expectedRev);
      if (!Number.isInteger(expected)) throw err.validation('缺少页面状态版本 expected_rev');
      if (expected !== r.rev) {
        throw err.stale(`页面所见状态已过期（页面 rev=${expected}，服务端 rev=${r.rev}）：请按最新状态重新操作`);
      }

      const result = apply(r);
      bumpRev(showId);
      const newRev = getRuntimeRow(showId).rev;
      recordOp(opId, showId, kind, true, null, newRev);
      return { accepted: true, result, rev: newRev };
    } catch (e) {
      if (e instanceof DomainError) recordOp(opId, showId, kind, false, e.message, r.rev);
      throw e;
    }
  })();
}

// ---------------------------------------------------------------- 控制权

// 取得控制权：无人持有 / 持有者已过期时可取得；已被他人持有时拒绝（423）
function acquireControl(showId, holderRaw, opId) {
  ensureShow(showId);
  const holder = typeof holderRaw === 'string' ? holderRaw.trim().slice(0, 50) : '';
  if (!holder) throw err.validation('请填写操作员名称');

  return db.transaction(() => {
    checkOpId(opId, showId, 'acquire');
    const r = expireControl(showId);
    if (r.control_token) {
      throw err.controlBusy(`控制权正由「${r.controller_name}」持有（至 ${new Date(r.control_until).toLocaleTimeString()}），过期或被释放后方可接管`);
    }
    const token = crypto.randomBytes(24).toString('hex');
    const until = now() + CONTROL_TTL_MS;
    db.prepare('UPDATE runtime SET controller_name = ?, control_token = ?, control_until = ? WHERE show_id = ?')
      .run(holder, token, until, showId);
    recordOp(opId, showId, 'acquire', true, null, r.rev);
    return { token, holder, expires_at: until, ttl_ms: CONTROL_TTL_MS, rev: r.rev };
  })();
}

// 续期（心跳）：必须持有有效控制权，基于页面 rev
function renewControl(showId, token, opId, expectedRev) {
  return mutateRuntime(showId, { opId, kind: 'renew', token, expectedRev }, () => {
    const until = now() + CONTROL_TTL_MS;
    db.prepare('UPDATE runtime SET control_until = ? WHERE show_id = ?').run(until, showId);
    return { expires_at: until, ttl_ms: CONTROL_TTL_MS };
  });
}

// 主动释放
function releaseControl(showId, token, opId, expectedRev) {
  return mutateRuntime(showId, { opId, kind: 'release', token, expectedRev }, () => {
    db.prepare('UPDATE runtime SET controller_name = NULL, control_token = NULL, control_until = NULL WHERE show_id = ?')
      .run(showId);
    return { released: true };
  });
}

// ---------------------------------------------------------------- 演出与字幕操作

// 开始演出 = 锁定一个已发布版本快照。演出进行中调用即“切换版本”，拒绝。
function startPerformance(showId, versionIdRaw, token, opId, expectedRev) {
  const versionId = typeof versionIdRaw === 'string' && versionIdRaw ? versionIdRaw : null;
  return mutateRuntime(showId, { opId, kind: 'start', token, expectedRev }, (r) => {
    if (r.status === 'performing') {
      throw err.conflict('演出进行中：不能切换演出版本；请先结束当前演出');
    }
    let version;
    if (versionId) {
      version = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?').get(versionId, showId);
      if (!version) throw err.validation('所选版本不存在或不属于本场次');
    } else {
      version = db.prepare('SELECT * FROM versions WHERE show_id = ? ORDER BY version_no DESC LIMIT 1').get(showId);
      if (!version) throw err.validation('尚无已发布版本，无法开始演出');
    }
    const first = db.prepare('SELECT MIN(seq) AS s FROM entries WHERE version_id = ?').get(version.id);
    db.prepare(`UPDATE runtime
                SET status = 'performing', performing_version = ?, position = ? WHERE show_id = ?`)
      .run(version.id, first.s, showId);
    return { version_no: version.version_no, position: first.s };
  });
}

function endPerformance(showId, token, opId, expectedRev) {
  return mutateRuntime(showId, { opId, kind: 'end', token, expectedRev }, (r) => {
    if (r.status !== 'performing') throw err.conflict('当前没有进行中的演出');
    // 结束后清屏；演出版本保留记录，便于查看“刚才演的是哪一版”
    db.prepare(`UPDATE runtime SET status = 'ended', position = NULL WHERE show_id = ?`).run(showId);
    return { ended: true };
  });
}

function advance(showId, token, opId, expectedRev) {
  return mutateRuntime(showId, { opId, kind: 'advance', token, expectedRev }, (r) => {
    if (r.status !== 'performing') throw err.conflict('演出未开始，无法推进字幕');
    if (r.position == null) {
      // 清屏后推进：回到第一条
      const first = db.prepare('SELECT MIN(seq) AS s FROM entries WHERE version_id = ?').get(r.performing_version);
      db.prepare('UPDATE runtime SET position = ? WHERE show_id = ?').run(first.s, showId);
      return { position: first.s };
    }
    const next = db.prepare('SELECT MIN(seq) AS s FROM entries WHERE version_id = ? AND seq > ?')
      .get(r.performing_version, r.position);
    if (!next || next.s == null) throw err.conflict('已经是最后一条字幕，无法继续推进');
    db.prepare('UPDATE runtime SET position = ? WHERE show_id = ?').run(next.s, showId);
    return { position: next.s };
  });
}

function back(showId, token, opId, expectedRev) {
  return mutateRuntime(showId, { opId, kind: 'back', token, expectedRev }, (r) => {
    if (r.status !== 'performing') throw err.conflict('演出未开始，无法回退字幕');
    if (r.position == null) {
      // 清屏状态下回退：回到最后一条
      const last = db.prepare('SELECT MAX(seq) AS s FROM entries WHERE version_id = ?').get(r.performing_version);
      db.prepare('UPDATE runtime SET position = ? WHERE show_id = ?').run(last.s, showId);
      return { position: last.s };
    }
    const prev = db.prepare(`SELECT MAX(seq) AS s FROM entries WHERE version_id = ? AND seq < ?`)
      .get(r.performing_version, r.position);
    if (!prev || prev.s == null) throw err.conflict('已经是第一条字幕，无法继续回退');
    db.prepare('UPDATE runtime SET position = ? WHERE show_id = ?').run(prev.s, showId);
    return { position: prev.s };
  });
}

function clearScreen(showId, token, opId, expectedRev) {
  return mutateRuntime(showId, { opId, kind: 'clear', token, expectedRev }, (r) => {
    if (r.status !== 'performing') throw err.conflict('演出未开始，无法清屏');
    if (r.position == null) throw err.conflict('屏幕已处于清空状态，无需重复清屏');
    db.prepare('UPDATE runtime SET position = NULL WHERE show_id = ?').run(showId);
    return { position: null };
  });
}

// ---------------------------------------------------------------- 初始化示例场次

function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) AS c FROM shows').get().c > 0) return null;
  return db.transaction(() => {
    const show = createShow('示例：今晚八点场');
    saveDraft(show.id, [
      { seq: 1, text: '第一幕 · 晚风初起' },
      { seq: 2, text: '「你来啦，我等你很久了。」' },
      { seq: 3, text: '「这条路，我只陪你走到这里。」' },
      { seq: 4, text: '（灯光渐暗，幕落）' },
    ]);
    publish(show.id, '首演定稿');
    return show.id;
  })();
}

module.exports = {
  db,
  DomainError,
  CONTROL_TTL_MS,
  createShow,
  listShows,
  getShow,
  getState,
  getDraft,
  listVersions,
  getEntries,
  saveDraft,
  publish,
  acquireControl,
  renewControl,
  releaseControl,
  startPerformance,
  endPerformance,
  advance,
  back,
  clearScreen,
  seedIfEmpty,
  pruneOps,
  expireControl,
};
