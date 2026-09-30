/* 公共工具：API 请求、操作去重、WebSocket 重连、提示条 */

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    const e = new Error((data && data.message) || `请求失败 (${res.status})`);
    e.code = data && data.error;
    e.status = res.status;
    throw e;
  }
  return data;
}

// 带操作标识的运行时变更请求：opId 一次生成，重试用同一个 opId，
// 这样网络抖动导致的重复提交也只会生效一次。
function opAction(method, url, payload, opts = {}) {
  const opId = opts.opId || uuid();
  return api(method, url, { ...payload, opId }).then((r) => ({ ...r, opId }));
}

function toast(message, kind = '') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, kind === 'error' ? 5200 : 3200);
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 连接场次实时通道：断线自动重连，重连后以服务端最新已确认状态为准
function connectShow(showId, handlers = {}) {
  const conn = {
    ws: null,
    closedByUser: false,
    retry: 0,
    setIndicator: null,
  };

  function setStatus(label, on) {
    if (conn.setIndicator) conn.setIndicator(label, on);
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?show=${encodeURIComponent(showId)}`);
    conn.ws = ws;
    setStatus(conn.retry ? `重连中…(${conn.retry})` : '连接中…', false);

    ws.onopen = () => { conn.retry = 0; setStatus('实时已连接', true); handlers.onOpen && handlers.onOpen(); };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'state') handlers.onState && handlers.onState(msg.state);
    };
    ws.onclose = () => {
      if (conn.closedByUser) return;
      setStatus('连接断开，重连中…', false);
      conn.retry += 1;
      setTimeout(connect, Math.min(1000 * 2 ** Math.min(conn.retry, 4), 15000));
    };
    ws.onerror = () => ws.close();
  }

  connect();
  return conn;
}

// 统一的错误提示：把各类拒绝原因直接展示给操作员
function explainError(e) {
  return e.message || '操作失败';
}
