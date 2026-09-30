/* 走词台公共前端逻辑：API 封装、WebSocket 自动重连、场次选择 */
'use strict';

const Api = {
  async req(method, url, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(url, opt);
    let data = {};
    try { data = await res.json(); } catch { /* 非 JSON */ }
    if (!res.ok) {
      const err = new Error((data.error && data.error.message) || `请求失败（${res.status}）`);
      err.code = data.error && data.error.code;
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get(u) { return this.req('GET', u); },
  post(u, b) { return this.req('POST', u, b || {}); },
  put(u, b) { return this.req('PUT', u, b || {}); },
};

const Sess = {
  get id() { return new URLSearchParams(location.search).get('sid'); },
};

/** WebSocket 自动重连：断线后指数退避，重连即由 hello 推送恢复最新已确认状态 */
function connectWS({ onState, onControl }) {
  const pill = document.getElementById('conn-pill');
  let ws = null;
  let closedByUser = false;
  let retry = 0;
  let pingTimer = null;

  function setPill(mode, text) {
    if (!pill) return;
    pill.className = 'conn-pill ' + mode;
    pill.textContent = text;
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?sid=${encodeURIComponent(Sess.id)}`);
    setPill('connecting', '连接中…');

    ws.onopen = () => {
      retry = 0;
      setPill('online', '实时已连接');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws.send('{"type":"ping"}'); } catch {} }, 20000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello' || msg.type === 'state') {
        if (msg.state && onState) onState(msg.state, msg.type);
        if (msg.control && onControl) onControl(msg.control);
      } else if (msg.type === 'control') {
        if (onControl) onControl(msg.control);
      }
    };
    ws.onclose = (ev) => {
      clearInterval(pingTimer);
      if (closedByUser) return;
      setPill('offline', '连接断开，正在重连…');
      retry += 1;
      setTimeout(connect, Math.min(1000 * 2 ** retry, 8000));
    };
    ws.onerror = () => ws.close();
  }

  // 握手前确认场次存在：会话非法则停止，避免无限重连
  (async () => {
    try {
      await Api.get(`/api/sessions/${encodeURIComponent(Sess.id)}`);
      connect();
    } catch {
      setPill('offline', '场次不存在');
      toast('该场次不存在，请回到场次首页确认链接', 'info');
    }
  })();
  return {
    close() { closedByUser = true; ws && ws.close(); },
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(msg, kind) {
  let box = document.getElementById('toast-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast-box';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || 'err');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('fade'); }, 3500);
  setTimeout(() => el.remove(), 4200);
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
