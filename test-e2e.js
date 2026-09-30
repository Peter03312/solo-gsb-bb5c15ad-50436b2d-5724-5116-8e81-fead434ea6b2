/* 端到端接口测试：覆盖全部验收点。node:sqlite 服务器需已在 8080 运行 */
'use strict';

const BASE = 'http://127.0.0.1:8080';
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra || ''); }
}

async function api(method, urlPath, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(BASE + urlPath, opt);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function expectFail(name, method, urlPath, body, expectedCode) {
  const r = await api(method, urlPath, body);
  ok(name, r.status >= 400 && r.json.error && r.json.error.code === expectedCode,
    `got ${r.status} ${JSON.stringify(r.json.error)} expected ${expectedCode}`);
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. 建场次
  let r = await api('POST', '/api/sessions', { name: 'E2E 测试场' });
  ok('创建场次', r.status === 200 && r.json.id && r.json.name === 'E2E 测试场');
  const sid = r.json.id;

  // 2. 草稿：空字幕 / 重复序号拒绝
  await expectFail('空字幕条目拒绝(PUT draft)', 'PUT', `/api/sessions/${sid}/draft`, { entries: [{ seq: 1, text: '  ' }] }, 'EMPTY_TEXT');
  await expectFail('重复序号拒绝(PUT draft)', 'PUT', `/api/sessions/${sid}/draft`,
    { entries: [{ seq: 1, text: '一' }, { seq: 1, text: '二' }] }, 'DUPLICATE_SEQ');
  await expectFail('非正整数序号拒绝', 'PUT', `/api/sessions/${sid}/draft`,
    { entries: [{ seq: 0, text: '一' }] }, 'INVALID_SEQ');

  // 3. 发布：空版本拒绝
  await expectFail('空版本拒绝发布', 'POST', `/api/sessions/${sid}/publish`, { entries: [] }, 'EMPTY_VERSION');
  // 发布合法版本
  r = await api('POST', `/api/sessions/${sid}/publish`, {
    entries: [{ seq: 1, text: '第一句台词' }, { seq: 3, text: '第三句' }, { seq: 2, text: '第二句' }],
  });
  ok('发布 v1（序号乱序也可，保存后排序）', r.status === 200 && r.json.versionNo === 1 && r.json.count === 3, JSON.stringify(r.json));
  const v1 = r.json.id;
  // 发布后草稿应为空（修改只进草稿）
  r = await api('GET', `/api/sessions/${sid}/draft`);
  ok('发布后草稿已清空（后续修改不影响演出版本）', r.status === 200 && r.json.entries.length === 0);
  // 再在草稿里改东西，演出版本不动
  await api('PUT', `/api/sessions/${sid}/draft`, { entries: [{ seq: 1, text: '草稿里的新内容' }] });
  r = await api('GET', `/api/sessions/${sid}/versions/${v1}`);
  ok('已发布版本条目保持原样', r.status === 200 &&
    r.json.entries.map((e) => e.seq).join(',') === '1,2,3' && r.json.entries[0].text === '第一句台词');

  // 4. 无控制权不能操作
  await expectFail('无控制权拒绝推进', 'POST', `/api/sessions/${sid}/ops`,
    { action: 'advance', stateVersion: 1 }, 'NO_CONTROL');

  // 5. A 取得控制权
  r = await api('POST', `/api/sessions/${sid}/control/grant`, { operator: '操作员A', ttl: 60 });
  ok('A 取得控制权', r.status === 200 && !!r.json.token, JSON.stringify(r.json));
  const tokenA = r.json.token;
  // B 不能同时取得
  await expectFail('同场仅一人持有：B 被拒', 'POST', `/api/sessions/${sid}/control/grant`, { operator: '操作员B', ttl: 60 }, 'CONTROL_HELD');

  // 6. 载入版本（首次），stateVersion 必须是 1
  r = await api('POST', `/api/sessions/${sid}/ops`, { action: 'load', versionId: v1, token: tokenA, stateVersion: 1 });
  ok('载入 v1，stateVersion 1→2，清屏', r.status === 200 && r.json.stateVersion === 2 && r.json.pos === null && r.json.activeVersionId === v1,
    JSON.stringify(r.json.stateVersion));

  // 演出中切换版本（载入 v2 尚不存在；先发 v2 再尝试 load）
  r = await api('POST', `/api/sessions/${sid}/publish`, { entries: [{ seq: 1, text: '第二版第一句' }] });
  const v2 = r.json.id;
  await expectFail('演出中切换版本拒绝', 'POST', `/api/sessions/${sid}/ops`,
    { action: 'load', versionId: v2, token: tokenA, stateVersion: 2 }, 'SHOW_IN_PROGRESS');

  // 7. 推进 / 回退 / 清屏，校验状态版本
  r = await api('POST', `/api/sessions/${sid}/ops`, { action: 'advance', token: tokenA, stateVersion: 2 });
  ok('推进到第1条 v3', r.status === 200 && r.json.pos === 1 && r.json.current.text === '第一句台词' && r.json.stateVersion === 3, JSON.stringify(r.json));

  // 旧版本号重复提交 -> 拒绝（防重复提交）
  await expectFail('重复提交(旧 stateVersion=2)拒绝 advance', 'POST', `/api/sessions/${sid}/ops`,
    { action: 'advance', token: tokenA, stateVersion: 2 }, 'STALE_STATE');
  // 缺 stateVersion
  await expectFail('缺少 stateVersion 拒绝', 'POST', `/api/sessions/${sid}/ops`,
    { action: 'advance', token: tokenA }, 'NO_STATE_VERSION');

  r = await api('POST', `/api/sessions/${sid}/ops`, { action: 'advance', token: tokenA, stateVersion: 3 });
  ok('推进到第2条 v4（第二句）', r.json.pos === 2 && r.json.current.text === '第二句' && r.json.stateVersion === 4);
  r = await api('POST', `/api/sessions/${sid}/ops`, { action: 'back', token: tokenA, stateVersion: 4 });
  ok('回退到第1条 v5', r.json.pos === 1 && r.json.stateVersion === 5);
  await expectFail('第一条再回退拒绝', 'POST', `/api/sessions/${sid}/ops`,
    { action: 'back', token: tokenA, stateVersion: 5 }, 'AT_START');

  r = await api('POST', `/api/sessions/${sid}/ops`, { action: 'advance', token: tokenA, stateVersion: 5 });
  ok('推进到第2条 v6（第二句）', r.json.pos === 2 && r.json.current.text === '第二句' && r.json.stateVersion === 6);
  r = await api('POST', `/api/sessions/${sid}/ops`, { action: 'advance', token: tokenA, stateVersion: 6 });
  ok('推进到第3条 v7（第三句）', r.json.pos === 3 && r.json.current.text === '第三句' && r.json.stateVersion === 7);
  await expectFail('末尾再推进拒绝', 'POST', `/api/sessions/${sid}/ops`,
    { action: 'advance', token: tokenA, stateVersion: 7 }, 'AT_END');

  r = await api('POST', `/api/sessions/${sid}/ops`, { action: 'clear', token: tokenA, stateVersion: 7 });
  ok('清屏 v8，current 为空但版本仍在', r.status === 200 && r.json.pos === null && r.json.current === null && r.json.activeVersionId === v1);
  await expectFail('重复清屏拒绝', 'POST', `/api/sessions/${sid}/ops`,
    { action: 'clear', token: tokenA, stateVersion: 8 }, 'ALREADY_CLEAR');

  // 8. 错误 token / 失效控制权
  await expectFail('错误 token 拒绝', 'POST', `/api/sessions/${sid}/ops`,
    { action: 'advance', token: 'deadbeef', stateVersion: 8 }, 'CONTROL_OTHER');

  // A 释放后 B 可立即取得
  r = await api('POST', `/api/sessions/${sid}/control/release`, { token: tokenA });
  ok('A 释放控制权', r.status === 200);
  r = await api('POST', `/api/sessions/${sid}/control/grant`, { operator: '操作员B', ttl: 10 });
  ok('B 接管成功', r.status === 200 && !!r.json.token);
  const tokenB = r.json.token;
  console.log('  ⏳ 等待 B 控制权过期（11 秒，TTL 最小 10 秒）…');
  await sleep(11500);
  await expectFail('过期控制权操作拒绝', 'POST', `/api/sessions/${sid}/ops`,
    { action: 'advance', token: tokenB, stateVersion: 8 }, 'CONTROL_EXPIRED');
  r = await api('POST', `/api/sessions/${sid}/control/grant`, { operator: '操作员C', ttl: 30 });
  ok('过期后他人可接管（C）', r.status === 200 && !!r.json.token);
  const tokenC = r.json.token;

  // 9. 结束演出后才能切换版本（复用 C 刚取得的控制权，不可重复 grant）
  r = await api('POST', `/api/sessions/${sid}/ops`, { action: 'end', token: tokenC, stateVersion: 8 });
  ok('结束演出 v9', r.status === 200 && r.json.activeVersionId === null && r.json.stateVersion === 9, JSON.stringify(r.json));
  r = await api('POST', `/api/sessions/${sid}/ops`, { action: 'load', versionId: v2, token: tokenC, stateVersion: 9 });
  ok('结束后可载入 v2，v10', r.status === 200 && r.json.activeVersionId === v2 && r.json.stateVersion === 10, JSON.stringify(r.json));
  r = await api('POST', `/api/sessions/${sid}/ops`, { action: 'advance', token: tokenC, stateVersion: 10 });
  ok('v2 首句为草稿修改后发布的内容', r.status === 200 && r.json.current.text === '第二版第一句');

  // 10. 状态恢复：GET state 与持久化一致（重启后再验证一次，见脚本外）
  r = await api('GET', `/api/sessions/${sid}/state`);
  ok('GET state 返回最新已确认状态', r.status === 200 && r.json.stateVersion >= 9);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常', e); process.exit(1); });
