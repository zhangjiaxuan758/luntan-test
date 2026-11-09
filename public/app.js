'use strict';
/* ==================================================================
 * 轩的论坛 — client
 * ================================================================== */

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = n => `<svg><use href="#i-${n}"/></svg>`;
const pad2 = n => String(n).padStart(2, '0');
const fmtSize = n => {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + ' ' + u[i];
};
const fmtClock = ts => { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
const fmtTimeShort = ts => {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtClock(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const fmtDay = ts => {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};
const PRESET = ['#7c7c86', '#8d8d96', '#696974', '#9b9ba3', '#5e5e69', '#83838d',
  '#a1a1a8', '#6c6c77', '#909099', '#777781', '#9e9ea5', '#63636e'];
function avatarHTML(u, cls = '') {
  const name = (u && u.name) || '?';
  const klass = cls ? `avatar ${cls}` : 'avatar';
  if (u && typeof u.avatar === 'string' && u.avatar.startsWith('file:')) {
    return `<div class="${klass}"><img src="/file/${encodeURIComponent(u.avatar.slice(5))}" alt=""></div>`;
  }
  let idx = 0;
  const m = u && typeof u.avatar === 'string' && /^preset:(\d+)$/.exec(u.avatar);
  if (m) idx = Number(m[1]) % PRESET.length;
  else if (u && u.id) idx = [...u.id].reduce((a, c) => a + c.charCodeAt(0), 0) % PRESET.length;
  return `<div class="${klass}" style="background:${PRESET[idx]}">${esc(Array.from(name)[0] || '?')}</div>`;
}
const groupAvatar = () => `<div class="avatar" style="background:#565660">${icon('users')}</div>`;
function textHTML(s) {
  return esc(s).replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}
/* 只接受 http/https 链接，防止 javascript: 等伪协议 */
function safeLink(u) {
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : ''; }
  catch (e) { return ''; }
}
function linksIn(s) {
  const out = [];
  const re = /https?:\/\/[^\s<>"']+/gi;
  let m;
  while ((m = re.exec(String(s || ''))) && out.length < 5) {
    const clean = m[0].replace(/[.,;:!?)\]}>，。；：！？）】》]+$/, '');
    const href = safeLink(clean);
    if (href && !out.includes(href)) out.push(href);
  }
  return out;
}
/* 文字下方画一条横线 + 「打开」按钮 */
function linkCardHTML(s) {
  const links = linksIn(s);
  if (!links.length) return '';
  return `<div class="link-card"><div class="link-card-line"></div>${links.map(h =>
    `<div class="link-row"><button class="link-open" data-act="openlink" data-url="${esc(h)}" title="打开链接">${icon('external')}<span>打开</span></button><span class="link-url">${esc(h)}</span></div>`
  ).join('')}</div>`;
}
function toast(msg, ms = 2300) {
  const box = $('#toasts');
  for (const old of Array.from(box.children)) if (old.textContent === msg) old.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.25s'; setTimeout(() => el.remove(), 260); }, ms);
}
async function api(path, body = {}) {
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  let d;
  try { d = await r.json(); } catch (e) { throw new Error('服务器响应异常'); }
  if (!r.ok || d.error) throw new Error(d.error || '请求失败');
  return d;
}
async function writeClip(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (e) { return false; }
}

/* ---------------- state ---------------- */
const S = {
  token: localStorage.getItem('hf_token') || '',
  me: null, users: {}, convs: [], requests: [], online: new Set(), lasts: {},
  conv: 'group', tab: 'chats', search: '', unread: {}, messages: [],
  ws: null, everConnected: false, stopped: false, reconnect: null,
  serverOffset: 0, convSeq: 0, renderedDay: '',
  liveDuringLoad: [], loadingConv: null,
  pendingDmTo: null, regAvatar: 'preset:0', setAvatar: null,
  drafts: [], modalOpen: false, quote: null
};
const serverNow = () => Date.now() + S.serverOffset;
const wsSend = o => {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o));
  else toast('连接中，请稍候再试');
};

/* ==================================================================
 * Auth screen
 * ================================================================== */
function showAuth(msg) {
  S.stopped = true;
  if (S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
  S.everConnected = false;
  clearTimeout(S.reconnect);
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  if (msg) $('#authError').textContent = msg;
}
function showApp() {
  S.stopped = false;
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
}
function updateRegAvatar() {
  $('#regAvatarBig').outerHTML = avatarHTML(
    { name: $('#regName').value.trim() || '?', avatar: S.regAvatar }, 'avatar-xl'
  ).replace('class="avatar avatar-xl"', 'class="avatar avatar-xl" id="regAvatarBig"');
  $$('#regPresets .preset').forEach(b => b.classList.toggle('active', S.regAvatar === 'preset:' + b.dataset.i));
}
function initAuth() {
  const p = $('#regPresets');
  p.innerHTML = PRESET.map((c, i) => `<button type="button" class="preset" data-i="${i}" style="background:${c}">${i + 1}</button>`).join('');
  p.addEventListener('click', e => {
    const b = e.target.closest('.preset');
    if (!b) return;
    S.regAvatar = 'preset:' + b.dataset.i;
    updateRegAvatar();
  });
  $('#regName').addEventListener('input', () => {
    const n = Array.from($('#regName').value.trim()).length;
    $('#regNameCount').textContent = n + ' / 10';
    $('#regNameCount').style.color = n > 10 ? '#a33b3b' : '';
    $('#authError').textContent = '';
    updateRegAvatar();
  });
  $('#regName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#regBtn').click(); });
  $('#regAvatarUpload').addEventListener('click', () => $('#regAvatarFile').click());
  $('#regAvatarFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    toast('正在上传头像…');
    try {
      const file = await uploadFile(f, 'image');
      S.regAvatar = 'file:' + file.id;
      updateRegAvatar();
      toast('头像已设置');
    } catch (err) { toast('头像上传失败：' + err.message); }
  });
  $('#showRestore').addEventListener('click', () => $('#restoreBox').classList.toggle('hidden'));
  $('#restoreBtn').addEventListener('click', async () => {
    const t = $('#restoreToken').value.trim();
    if (!t) return;
    S.token = t;
    localStorage.setItem('hf_token', t);
    S.stopped = false;
    await boot();
  });
  $('#regBtn').addEventListener('click', async () => {
    const name = $('#regName').value.trim();
    const n = Array.from(name).length;
    if (n < 1 || n > 10) { $('#authError').textContent = '名字需为 1~10 个字符'; return; }
    $('#authError').textContent = '';
    const btn = $('#regBtn'); btn.disabled = true; btn.textContent = '正在进入…';
    try {
      const r = await api('/api/register', { name, avatar: S.regAvatar });
      S.token = r.token;
      localStorage.setItem('hf_token', r.token);
      S.stopped = false;
      await boot();
    } catch (e) {
      $('#authError').textContent = e.message;
      btn.disabled = false; btn.textContent = '进入论坛';
    }
  });
  updateRegAvatar();
}

/* ==================================================================
 * Bootstrap & WebSocket
 * ================================================================== */
function applyBootstrap(r) {
  S.me = r.me;
  S.users = {};
  for (const u of r.users) S.users[u.id] = u;
  S.convs = r.conversations;
  S.requests = r.requests || [];
  S.lasts = r.lasts || {};
  S.online = new Set(r.online || []);
  if (r.serverTime) S.serverOffset = r.serverTime - Date.now();
  renderMe();
  renderSide();
}
async function boot() {
  if (!S.token) return showAuth();
  try {
    const r = await api('/api/bootstrap', { token: S.token });
    applyBootstrap(r);
    showApp();
    if (!S.ws || S.ws.readyState === 3) connectWS();
    await openConv('group', true);
  } catch (e) {
    showAuth(e.message);
  }
}
function setConn(ok) {
  $('#connDot').classList.toggle('on', ok);
  $('#connText').textContent = ok ? '已连接' : '连接中…';
  $('#meStatus').textContent = ok ? '在线' : '连接中…';
}
function connectWS() {
  if (S.stopped) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try { ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(S.token)}`); }
  catch (e) { return scheduleReconnect(); }
  S.ws = ws;
  ws.onopen = async () => {
    if (S.ws !== ws) return;
    setConn(true);
    if (S.everConnected) {
      try {
        const r = await api('/api/bootstrap', { token: S.token });
        applyBootstrap(r);
        await openConv(S.conv, true);
        toast('已重新连接');
      } catch (e) {}
    }
    S.everConnected = true;
  };
  ws.onmessage = e => {
    if (S.ws !== ws) return;
    let d; try { d = JSON.parse(e.data); } catch (err) { return; }
    handleEvent(d);
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    setConn(false);
    scheduleReconnect();
  };
  ws.onerror = () => {};
}
function scheduleReconnect() {
  if (S.stopped) return;
  clearTimeout(S.reconnect);
  S.reconnect = setTimeout(connectWS, 1200);
}

/* ==================================================================
 * Realtime events
 * ================================================================== */
function handleEvent(d) {
  switch (d.t) {
    case 'hello':
      if (d.online) S.online = new Set(d.online);
      renderSide(); break;
    case 'presence':
      S.online = new Set(d.online || []);
      renderSide(); updateConvSub(); break;
    case 'message': onNewMessage(d.message); break;
    case 'recall': onRecall(d); break;
    case 'deleted': onDeleted(d); break;
    case 'user_joined':
      S.users[d.user.id] = d.user; renderSide(); updateConvSub(); break;
    case 'user_updated':
      S.users[d.user.id] = d.user;
      if (S.me && d.user.id === S.me.id) S.me = d.user;
      renderMe(); renderSide(); renderMessages(); break;
    case 'dm_created': onDmCreated(d); break;
    case 'dm_ready': openConv(d.conv); break;
    case 'friend_request': onFriendRequest(d); break;
    case 'request_sent': onRequestSent(d); break;
    case 'request_resolved': onRequestResolved(d); break;
    case 'profile_ok':
      S.me = d.me; S.users[d.me.id] = d.me;
      renderMe(); renderSide(); renderMessages(); toast('已保存'); break;
    case 'settings_ok':
      S.me = d.me; S.users[d.me.id] = d.me;
      renderMe(); renderSide(); break;
    case 'error': toast(d.message || '操作失败'); break;
  }
}
function onNewMessage(m) {
  if (!m) return;
  S.lasts[m.conv] = m;
  if (!S.convs.some(c => c.id === m.conv)) {
    api('/api/bootstrap', { token: S.token }).then(applyBootstrap).catch(() => {});
  }
  if (m.conv === S.conv) {
    if (S.loadingConv === S.conv) S.liveDuringLoad.push(m);
    else {
      const stick = nearBottom();
      S.messages.push(m);
      appendMessage(m);
      if (stick) scrollBottom();
    }
  } else {
    S.unread[m.conv] = (S.unread[m.conv] || 0) + 1;
  }
  renderSide();
}
function recomputeLast(conv) {
  if (conv === S.conv && S.messages.length) S.lasts[conv] = S.messages[S.messages.length - 1];
  else delete S.lasts[conv];
}
function onRecall(d) {
  S.messages = S.messages.filter(m => m.id !== d.id);
  if (S.lasts[d.conv] && S.lasts[d.conv].id === d.id) recomputeLast(d.conv);
  if (d.conv === S.conv) renderMessages();
  renderSide();
}
function onDeleted(d) {
  S.messages = S.messages.filter(m => m.id !== d.id);
  if (S.lasts[d.conv] && S.lasts[d.conv].id === d.id) recomputeLast(d.conv);
  if (d.conv === S.conv) renderMessages();
  renderSide();
}
function onDmCreated(d) {
  if (!S.convs.some(c => c.id === d.conv)) {
    const other = (d.users || []).find(u => u.id !== S.me.id);
    S.convs.push({ id: d.conv, type: 'dm', with: other ? other.id : '', name: other ? other.name : '私聊', members: d.users.map(u => u.id) });
  }
  for (const u of d.users || []) S.users[u.id] = u;
  renderSide();
  const target = d.users.find(u => u.id !== S.me.id);
  if (S.pendingDmTo && target && target.id === S.pendingDmTo) {
    S.pendingDmTo = null;
    openConv(d.conv);
    toast('私聊已建立');
  } else if (target) {
    toast(`${target.name} 现在可以和你私聊了`);
  }
}
function upsertRequest(r) {
  const i = S.requests.findIndex(x => x.id === r.id);
  if (i >= 0) S.requests[i] = r; else S.requests.push(r);
  renderSide();
}
function onFriendRequest(d) {
  if (d.request) upsertRequest(d.request);
  toast(`收到来自 ${d.from ? d.from.name : '有人'} 的好友申请`);
}
function onRequestSent(d) {
  if (d.request) upsertRequest(d.request);
  toast('好友申请已发送，等待对方同意');
}
function onRequestResolved(d) {
  if (d.request) upsertRequest(d.request);
  const accepted = d.request && d.request.status === 'accepted';
  toast(accepted ? '对方同意了你的好友申请' : '对方拒绝了你的好友申请');
  if (accepted && d.conv && !S.convs.some(c => c.id === d.conv)) {
    api('/api/bootstrap', { token: S.token }).then(applyBootstrap).catch(() => {});
  }
}
function startDm(to) {
  if (to === S.me.id) return;
  S.pendingDmTo = to;
  wsSend({ t: 'dm_open', to });
  closeSidebarMobile();
}

/* ==================================================================
 * Rendering
 * ================================================================== */
function renderMe() {
  if (!S.me) return;
  const el = $('#meAvatar');
  el.outerHTML = avatarHTML(S.me).replace('class="avatar"', 'class="avatar" id="meAvatar"');
  $('#meName').textContent = S.me.name;
}
function updateConvSub() {
  const c = S.convs.find(x => x.id === S.conv);
  if (!c) return;
  if (S.conv === 'group') $('#convSub').textContent = `${Object.keys(S.users).length} 位成员 · ${S.online.size} 人在线`;
  else $('#convSub').textContent = S.online.has(c.with) ? '在线' : '离线';
}
function msgPreview(m, conv) {
  if (!m) return '暂无消息';
  let body = '';
  switch (m.type) {
    case 'text': body = (m.text || '').replace(/\n/g, ' '); break;
    case 'image': body = '[图片]'; break;
    case 'video': body = '[视频]'; break;
    case 'audio': body = m.recorded ? '[语音]' : '[音频文件] ' + (m.file ? m.file.name : ''); break;
    default: body = '[文件] ' + (m.file ? m.file.name : '');
  }
  if (m.caption) body += (body ? ' · ' : '') + m.caption.replace(/\n/g, ' ');
  if (m.quote) body = '引用 ' + (m.quote.name || '') + '：' + body;
  if (conv === 'group') {
    const u = S.users[m.sender];
    return ((u ? u.name : '?') + '：' + body);
  }
  return body;
}
function renderSide() {
  const q = S.search.trim().toLowerCase();
  let html = '';
  if (S.tab === 'chats') {
    const items = S.convs.filter(c => !q || (c.name || '').toLowerCase().includes(q) || msgPreview(S.lasts[c.id], c.id).toLowerCase().includes(q));
    const group = items.filter(c => c.id === 'group');
    const dms = items.filter(c => c.id !== 'group').sort((a, b) => (S.lasts[b.id]?.ts || 0) - (S.lasts[a.id]?.ts || 0));
    html += '<div class="list-section">会话</div>';
    for (const c of [...group, ...dms]) {
      const last = S.lasts[c.id];
      const un = S.unread[c.id] || 0;
      const av = c.id === 'group' ? groupAvatar() : avatarHTML(S.users[c.with] || { name: c.name });
      const dot = c.id !== 'group' && S.online.has(c.with) ? '<span class="online-dot on"></span>' : '';
      html += `<div class="list-item ${c.id === S.conv ? 'active' : ''}" data-act="conv" data-id="${c.id}">
        <div class="li-avatar">${av}${dot}</div>
        <div class="li-main">
          <div class="li-title"><span class="li-name">${esc(c.name)}</span><span class="li-time">${last ? fmtTimeShort(last.ts) : ''}</span></div>
          <div class="li-sub"><span class="li-preview">${esc(msgPreview(last, c.id))}</span>${un ? `<span class="li-unread">${un > 99 ? '99+' : un}</span>` : ''}</div>
        </div></div>`;
    }
    if (![...group, ...dms].length) html += '<div class="list-empty">没有匹配的会话</div>';
  } else if (S.tab === 'people') {
    const users = Object.values(S.users).filter(u => u.id !== S.me.id && (!q || u.name.toLowerCase().includes(q)));
    users.sort((a, b) => (S.online.has(b.id) ? 1 : 0) - (S.online.has(a.id) ? 1 : 0) || a.name.localeCompare(b.name));
    html += `<div class="list-section">所有成员 · 点击即可私聊（共 ${users.length} 人）</div>`;
    for (const u of users) {
      const isFriend = S.convs.some(c => c.type === 'dm' && c.with === u.id);
      const tag = u.friendVerify && !isFriend ? '需验证' : (isFriend ? '已添加' : '直接添加');
      html += `<div class="list-item" data-act="dm" data-id="${u.id}">
        <div class="li-avatar">${avatarHTML(u)}<span class="online-dot ${S.online.has(u.id) ? 'on' : ''}"></span></div>
        <div class="li-main">
          <div class="li-title"><span class="li-name">${esc(u.name)}</span><span class="li-time">${S.online.has(u.id) ? '在线' : '离线'}</span></div>
          <div class="li-sub"><span class="li-preview">${u.friendVerify && !isFriend ? icon('lock') + ' 开启好友验证' : '点击发起私聊'}</span><span class="li-time">${tag}</span></div>
        </div></div>`;
    }
    if (!users.length) html += '<div class="list-empty">还没有其他成员</div>';
  } else {
    const incoming = S.requests.filter(r => r.to === S.me.id && r.status === 'pending');
    const outgoing = S.requests.filter(r => r.from === S.me.id && r.status === 'pending');
    html += '<div class="list-section">收到的申请</div>';
    if (!incoming.length) html += '<div class="list-empty" style="padding:14px">暂无待处理申请</div>';
    for (const r of incoming) {
      const u = S.users[r.from] || { name: '已注销用户' };
      html += `<div class="list-item" style="cursor:default">
        <div class="li-avatar">${avatarHTML(u)}</div>
        <div class="li-main"><div class="li-title"><span class="li-name">${esc(u.name)}</span></div>
        <div class="li-sub"><span class="li-preview">想添加你为好友</span></div></div>
        <button class="btn btn-ghost btn-sm" data-act="reject" data-id="${r.id}">拒绝</button>
        <button class="btn btn-primary btn-sm" data-act="accept" data-id="${r.id}">同意</button></div>`;
    }
    html += '<div class="list-section">我发出的申请</div>';
    if (!outgoing.length) html += '<div class="list-empty" style="padding:14px">暂无</div>';
    for (const r of outgoing) {
      const u = S.users[r.to] || { name: '已注销用户' };
      html += `<div class="list-item" style="cursor:default">
        <div class="li-avatar">${avatarHTML(u)}</div>
        <div class="li-main"><div class="li-title"><span class="li-name">${esc(u.name)}</span></div>
        <div class="li-sub"><span class="li-preview">等待对方同意…</span></div></div></div>`;
    }
    const done = S.requests.filter(r => r.status !== 'pending' && (r.to === S.me.id || r.from === S.me.id));
    if (done.length) {
      html += '<div class="list-section">已处理</div>';
      for (const r of done.slice(-8)) {
        const u = S.users[r.from === S.me.id ? r.to : r.from] || { name: '已注销用户' };
        html += `<div class="list-item" style="cursor:default;opacity:.6">
          <div class="li-avatar">${avatarHTML(u)}</div>
          <div class="li-main"><div class="li-title"><span class="li-name">${esc(u.name)}</span></div>
          <div class="li-sub"><span class="li-preview">${r.status === 'accepted' ? '已同意' : '已拒绝'}</span></div></div></div>`;
      }
    }
  }
  $('#sideList').innerHTML = html;
  $('#onlineCount').textContent = S.online.size + ' 人在线';
  updateReqBadge();
}
function updateReqBadge() {
  const n = S.requests.filter(r => r.to === S.me.id && r.status === 'pending').length;
  const b = $('#reqBadge');
  b.textContent = n;
  b.classList.toggle('hidden', n === 0);
}

/* ---------------- messages ---------------- */
const typeIcon = t => t === 'image' ? 'image' : t === 'video' ? 'video' : t === 'audio' ? 'music' : 'file';
const typeLabel = t => t === 'image' ? '图片' : t === 'video' ? '视频' : t === 'audio' ? '音频文件' : '文件';
// 播放/暂停两个图标常驻，靠 .playing 切换，避免 innerHTML 替换导致状态丢失
function playBtnHTML(id, extraClass = '') {
  return `<button class="play-btn ${extraClass}" data-act="play" data-id="${id}" title="播放" aria-label="播放">
    <svg class="ic-play"><use href="#i-play"/></svg><svg class="ic-pause"><use href="#i-pause"/></svg></button>`;
}
function voiceHTML(m, url) {
  const secs = Math.round(m.duration || 0);
  const bars = [7, 12, 9, 17, 22, 13, 19, 10, 15, 21, 11, 18, 8, 14, 20, 12, 9, 16, 7, 13];
  const wave = bars.map(h => `<i style="--h:${h}px"></i>`).join('');
  const dur = `${Math.floor(secs / 60)}:${pad2(secs % 60)}`;
  return `<div class="voice-box" data-voice="${m.id}">
    ${playBtnHTML(m.id, 'voice-play')}
    <div class="voice-wave">${wave}</div>
    <span class="voice-dur">${dur}</span>
    <span class="media-tag">语音</span>
  </div>`;
}
function quoteText(q) {
  if (!q) return '';
  switch (q.type) {
    case 'text': return q.text || '';
    case 'image': return '[图片]' + (q.text || '');
    case 'video': return '[视频]' + (q.text || '');
    case 'audio': return (q.recorded ? '[语音]' : '[音频文件] ' + (q.fileName || '')) + (q.text || '');
    default: return '[文件] ' + (q.fileName || '') + (q.text || '');
  }
}
function quoteHTML(q) {
  if (!q) return '';
  return `<div class="msg-quote" role="button" tabindex="0" data-act="jumpquote" data-id="${esc(q.id)}" title="定位到原消息">
    <div class="mq-name">${esc(q.name || '已注销用户')}</div>
    <div class="mq-text">${esc(quoteText(q))}</div></div>`;
}
function makeQuote(m) {
  const u = S.users[m.sender] || { name: '已注销用户' };
  return {
    id: m.id, sender: m.sender, name: u.name, type: m.type,
    text: (m.text || m.caption || '').slice(0, 600),
    fileName: m.file ? m.file.name : '', recorded: !!m.recorded
  };
}
function captionHTML(m) {
  if (!m.caption) return '';
  return `<div class="bubble-caption">${textHTML(m.caption)}${linkCardHTML(m.caption)}</div>`;
}
function bubbleHTML(m) {
  const f = m.file || {};
  const url = '/file/' + encodeURIComponent(f.id || '');
  const poster = url + '#t=0.1';
  switch (m.type) {
    case 'text': return textHTML(m.text || '') + linkCardHTML(m.text || '');
    case 'image':
      return `<img class="bm-img" src="${url}" alt="${esc(f.name || '图片')}" loading="lazy" data-act="preview" data-id="${m.id}">`;
    case 'video':
      // 气泡内不使用浏览器原生播放器：自定义封面 + 播放图标，点击打开自有播放器
      return `<div class="bm-video-wrap" data-act="preview" data-id="${m.id}" title="点击播放视频">
        <video class="bm-video-cover" src="${poster}" preload="metadata" muted playsinline></video>
        <div class="bm-video-play"><span>${icon('play')}</span></div>
        <span class="bm-video-tag">视频</span></div>`;
    case 'audio':
      // 录音 = 语音气泡（标「语音」）；上传的音频文件 = 文件卡片（标「音频文件」）
      // 两者都只在气泡内用自有播放按钮播放，不进预览页
      if (m.recorded) return voiceHTML(m, url);
      return `<div class="file-card audio-card" data-act="play" data-id="${m.id}" title="播放音频文件">
        <div class="file-icon">${icon('music')}</div>
        <div class="file-meta"><div class="file-name" title="${esc(f.name)}">${esc(f.name || '音频文件')}</div>
        <div class="file-size"><span class="media-tag">音频文件</span> ${fmtSize(f.size)}</div></div>
        ${playBtnHTML(m.id, 'file-play-icon')}</div>`;
    default:
      return `<div class="file-card">
        <div class="file-icon">${icon('file')}</div>
        <div class="file-meta"><div class="file-name" title="${esc(f.name)}">${esc(f.name || '文件')}</div>
        <div class="file-size"><span class="media-tag">文件</span> ${fmtSize(f.size)}</div></div></div>`;
  }
}
function messageHTML(m) {
  const mine = S.me && m.sender === S.me.id;
  const u = S.users[m.sender] || { name: '已注销用户', avatar: 'preset:0' };
  const canRecall = mine && (serverNow() - m.ts <= 120000);
  const media = m.type === 'image' || m.type === 'video';
  const hasExtra = !!(m.quote || m.caption);
  const cls = m.type === 'text' ? 'text' : (media ? 'media' + (hasExtra ? ' has-extra' : '') : '');
  const acts = [];
  // 引用：任何人的消息都能引用
  acts.push(`<button class="msg-act act-quote" data-act="quote" data-id="${m.id}" title="引用这条消息">${icon('reply')}<span>引用</span></button>`);
  // 复制：只有文本消息
  if (m.type === 'text') acts.push(`<button class="msg-act act-copy" data-act="copy" data-id="${m.id}" title="复制">${icon('copy')}<span>复制</span></button>`);
  // 预览：只有图片和视频
  if (media) acts.push(`<button class="msg-act act-preview" data-act="preview" data-id="${m.id}" title="预览">${icon('eye')}<span>预览</span></button>`);
  if (m.file) acts.push(`<button class="msg-act" data-act="download" data-id="${m.id}" title="下载">${icon('download')}<span>下载</span></button>`);
  if (canRecall) acts.push(`<button class="msg-act act-recall" data-act="recall" data-id="${m.id}" data-recall-until="${m.ts + 120000}" title="撤回（发送后 2 分钟内）">${icon('undo')}<span>撤回</span></button>`);
  acts.push(`<button class="msg-act act-delete" data-act="delete" data-id="${m.id}" title="删除（仅自己看不到）">${icon('trash')}<span>删除</span></button>`);
  return `<div class="msg ${mine ? 'mine' : ''}" data-mid="${m.id}">
    ${avatarHTML(u)}
    <div class="msg-col">
      <div class="msg-name">${esc(u.name)}</div>
      <div class="bubble ${cls}">${quoteHTML(m.quote)}${bubbleHTML(m)}${captionHTML(m)}</div>
      <div class="msg-foot"><span class="msg-time">${fmtClock(m.ts)}</span>
        <div class="msg-actions">${acts.join('')}</div>
      </div>
    </div></div>`;
}
function renderMessages() {
  const el = $('#messages');
  if (!S.messages.length) {
    el.innerHTML = '<div class="list-empty" style="padding-top:60px">还没有消息<br>发送文字、文件、图片、视频或语音开始聊天吧</div>';
    S.renderedDay = '';
    return;
  }
  const parts = [];
  let day = '';
  for (const m of S.messages) {
    const d = new Date(m.ts).toDateString();
    if (d !== day) { day = d; parts.push(`<div class="day-sep"><span>${fmtDay(m.ts)}</span></div>`); }
    parts.push(messageHTML(m));
  }
  S.renderedDay = day;
  el.innerHTML = parts.join('');
  scrollBottom(false);
  if (typeof player !== 'undefined' && player && !player.audio.paused) syncPlayerUI(true);
}
function appendMessage(m) {
  const el = $('#messages');
  if (el.querySelector('.list-empty')) { el.innerHTML = ''; S.renderedDay = ''; }
  const d = new Date(m.ts).toDateString();
  if (d !== S.renderedDay) {
    S.renderedDay = d;
    el.insertAdjacentHTML('beforeend', `<div class="day-sep"><span>${fmtDay(m.ts)}</span></div>`);
  }
  el.insertAdjacentHTML('beforeend', messageHTML(m));
}
const nearBottom = () => {
  const el = $('#messages');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 180;
};
function scrollBottom(smooth) {
  const el = $('#messages');
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}
async function openConv(conv, force) {
  if (!S.convs.some(c => c.id === conv)) conv = 'group';
  const seq = ++S.convSeq;
  S.conv = conv;
  S.unread[conv] = 0;
  clearQuote();
  const c = S.convs.find(x => x.id === conv);
  $('#convTitle').textContent = c ? c.name : '公共群聊';
  $('#draftTarget').textContent = '发送到 ' + draftTargetName();
  updateConvSub();
  renderSide();
  $('#messages').innerHTML = '<div class="list-empty" style="padding-top:60px">加载中…</div>';
  S.loadingConv = conv;
  S.liveDuringLoad = [];
  try {
    const r = await api('/api/history', { token: S.token, conv });
    if (seq !== S.convSeq) return;
    S.messages = r.messages;
    for (const m of S.liveDuringLoad) {
      if (!S.messages.some(x => x.id === m.id)) S.messages.push(m);
    }
    S.messages.sort((a, b) => a.ts - b.ts);
    S.liveDuringLoad = [];
    S.loadingConv = null;
    renderMessages();
  } catch (e) {
    if (seq === S.convSeq) {
      S.loadingConv = null;
      $('#messages').innerHTML = `<div class="list-empty">${esc(e.message)}</div>`;
    }
  }
  closeSidebarMobile();
}

/* ==================================================================
 * Message actions
 * ================================================================== */
function findMsg(id) { return S.messages.find(m => m.id === id); }
async function copyMessage(m, btn) {
  let ok = false, label = '';
  if (m.type === 'text') {
    ok = await writeClip(m.text || '');
    label = '消息文字已复制';
  } else {
    const url = location.origin + '/file/' + encodeURIComponent(m.file.id);
    if (m.type === 'image' && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      try {
        const blob = await (await fetch('/file/' + encodeURIComponent(m.file.id))).blob();
        let png = blob;
        if (blob.type !== 'image/png') {
          const bmp = await createImageBitmap(blob);
          const c = document.createElement('canvas');
          c.width = bmp.width; c.height = bmp.height;
          c.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
          png = await new Promise(res => c.toBlob(res, 'image/png'));
        }
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        ok = true; label = '图片已复制，可直接粘贴';
      } catch (e) {}
    }
    if (!ok) { ok = await writeClip(url); label = '文件链接已复制，粘贴即可分享或下载'; }
  }
  toast(ok ? label : '复制失败，请检查浏览器剪贴板权限');
  if (ok && btn) {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 900);
  }
}
function downloadFile(m) {
  const f = m.file; if (!f) return;
  const a = document.createElement('a');
  a.href = '/file/' + encodeURIComponent(f.id);
  a.download = f.name || 'file';
  a.target = '_blank';
  document.body.appendChild(a); a.click(); a.remove();
}
const LB = { video: null, view: null, cleanup: [] };
const fmtDur = s => {
  s = Math.max(0, Math.floor(Number(s) || 0));
  return Math.floor(s / 60) + ':' + pad2(s % 60);
};
function setBtnIcon(el, name) { if (el) el.innerHTML = icon(name); }
/* 只有图片和视频有预览。两者都完全使用自有播放器，不出现浏览器原生控件 */
function openLightbox(m) {
  const f = m.file; if (!f) return;
  if (m.type !== 'image' && m.type !== 'video') return;
  // 若上一个预览仍开着，先彻底清理（含自定义播放器监听器）
  if (!$('#lightbox').classList.contains('hidden')) closeLightbox();
  stopPlayer();
  const url = '/file/' + encodeURIComponent(f.id);
  const label = typeLabel(m.type);
  let inner, bodyCls;
  if (m.type === 'video') {
    bodyCls = 'player';
    inner = `<div class="vp-stage" id="vpStage">
      <video class="vp-video" id="vpVideo" src="${url}" preload="metadata" playsinline></video>
      <button class="vp-big-play" id="vpBigPlay" title="播放">${icon('play')}</button>
      <div class="vp-bar">
        <button class="vp-btn" id="vpToggle" title="播放/暂停">${icon('play')}</button>
        <span class="vp-time" id="vpCur">0:00</span>
        <div class="vp-track" id="vpTrack"><div class="vp-buffer" id="vpBuffer"></div><div class="vp-played" id="vpPlayed"></div><div class="vp-knob" id="vpKnob"></div></div>
        <span class="vp-time" id="vpDur">0:00</span>
        <button class="vp-btn" id="vpMute" title="静音">${icon('volume')}</button>
        <input type="range" class="vp-vol" id="vpVol" min="0" max="1" step="0.05" value="1" title="音量">
        <button class="vp-btn rate" id="vpRate" title="倍速">1×</button>
        <button class="vp-btn" id="vpFull" title="全屏">${icon('maximize')}</button>
        <button class="vp-btn" id="vpClose" title="退出/关闭">${icon('close')}</button>
      </div>
    </div>`;
  } else {
    bodyCls = 'viewer';
    inner = `<div class="iv-stage" id="ivStage">
        <img class="iv-img" id="ivImg" src="${url}" alt="${esc(f.name)}">
        <div class="iv-bar">
          <button class="iv-btn" id="ivOut" title="缩小">${icon('zoom-out')}</button>
          <span class="iv-pct" id="ivPct">100%</span>
          <button class="iv-btn" id="ivIn" title="放大">${icon('zoom-in')}</button>
          <button class="iv-btn" id="ivFit" title="适应窗口">${icon('fit')}</button>
          <button class="iv-btn" id="ivFull" title="全屏">${icon('maximize')}</button>
          <button class="iv-btn" id="ivClose" title="退出/关闭">${icon('close')}</button>
        </div>
      </div>`;
  }
  const lb = $('#lightbox');
  lb.innerHTML = `<div class="lb-card">
    <div class="lb-head">
      <div class="lb-icon">${icon(typeIcon(m.type))}</div>
      <div class="lb-meta"><div class="lb-title">${esc(f.name)}</div>
        <div class="lb-sub">${label} · ${fmtSize(f.size)}</div></div>
      <div class="lb-actions">
        <button class="lb-btn" id="lbDl">${icon('download')}<span>下载</span></button>
        <button class="lb-btn icon-only" id="lbClose" title="关闭">${icon('close')}</button>
      </div>
    </div>
    <div class="lb-body ${bodyCls}">${inner}</div>
  </div>`;
  lb.classList.remove('hidden');
  $('#lbDl', lb).onclick = () => downloadFile(m);
  $('#lbClose', lb).onclick = closeLightbox;
  lb.onclick = e => { if (e.target === lb) closeLightbox(); };
  if (m.type === 'video') initVideoPlayer(lb);
  else initImageView(lb);
}
function initVideoPlayer(lb) {
  const v = $('#vpVideo', lb), big = $('#vpBigPlay', lb), toggle = $('#vpToggle', lb);
  const cur = $('#vpCur', lb), dur = $('#vpDur', lb), track = $('#vpTrack', lb);
  const played = $('#vpPlayed', lb), knob = $('#vpKnob', lb), buffer = $('#vpBuffer', lb);
  const mute = $('#vpMute', lb), vol = $('#vpVol', lb), rate = $('#vpRate', lb), full = $('#vpFull', lb);
  const stage = $('#vpStage', lb);
  LB.video = v;
  const sync = () => {
    const playing = !v.paused && !v.ended;
    setBtnIcon(toggle, playing ? 'pause' : 'play');
    big.classList.toggle('hidden', playing);
  };
  const togglePlay = () => { if (v.paused || v.ended) v.play().catch(() => {}); else v.pause(); };
  const on = (el, ev, fn) => { el.addEventListener(ev, fn); LB.cleanup.push(() => el.removeEventListener(ev, fn)); };
  on(toggle, 'click', togglePlay);
  on(big, 'click', togglePlay);
  on(v, 'click', togglePlay);
  on(v, 'play', sync);
  on(v, 'pause', sync);
  on(v, 'ended', sync);
  on(v, 'loadedmetadata', () => { dur.textContent = fmtDur(v.duration); sync(); });
  on(v, 'durationchange', () => dur.textContent = fmtDur(v.duration));
  on(v, 'timeupdate', () => {
    cur.textContent = fmtDur(v.currentTime);
    const p = v.duration ? Math.min(100, v.currentTime / v.duration * 100) : 0;
    played.style.width = p + '%'; knob.style.left = p + '%';
  });
  on(v, 'progress', () => {
    if (v.buffered.length && v.duration) buffer.style.width = Math.min(100, v.buffered.end(v.buffered.length - 1) / v.duration * 100) + '%';
  });
  const seek = e => {
    if (!v.duration) return;
    const r = track.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    v.currentTime = x * v.duration;
  };
  on(track, 'pointerdown', e => { seek(e); track.setPointerCapture(e.pointerId); });
  on(track, 'pointermove', e => { if (e.buttons) seek(e); });
  on(mute, 'click', () => {
    v.muted = !v.muted;
    setBtnIcon(mute, v.muted ? 'volume-x' : 'volume');
    vol.value = v.muted ? 0 : v.volume;
  });
  on(vol, 'input', () => { v.volume = Number(vol.value); v.muted = v.volume === 0; setBtnIcon(mute, v.muted ? 'volume-x' : 'volume'); });
  const rates = [1, 1.25, 1.5, 2, 0.5];
  let ri = 0;
  on(rate, 'click', () => { ri = (ri + 1) % rates.length; v.playbackRate = rates[ri]; rate.textContent = rates[ri] + '×'; });
  on(full, 'click', () => toggleFullscreen(stage, full));
  on(document, 'fullscreenchange', () => setBtnIcon(full, document.fullscreenElement ? 'minimize' : 'maximize'));
  on($('#vpClose', lb), 'click', closeLightbox);
  // 打开即尝试播放；若被浏览器自动播放策略拦截，则显示中央大播放按钮
  v.play().catch(() => sync());
  sync();
}
/* 全屏切换：优先标准 API，兼容 webkit 前缀（旧 Safari） */
function toggleFullscreen(el, btn) {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    return;
  }
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req) req.call(el).catch?.(() => {});
  if (btn && !fsEl) setBtnIcon(btn, 'minimize');
}
function initImageView(lb) {
  const stage = $('#ivStage', lb), img = $('#ivImg', lb), pct = $('#ivPct', lb);
  let scale = 1, tx = 0, ty = 0, drag = null;
  LB.view = { get scale() { return scale; } };
  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    pct.textContent = Math.round(scale * 100) + '%';
  };
  const setScale = s => {
    scale = Math.max(0.2, Math.min(6, s));
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  };
  const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); LB.cleanup.push(() => el.removeEventListener(ev, fn, opt)); };
  on($('#ivIn', lb), 'click', () => setScale(scale + 0.25));
  on($('#ivOut', lb), 'click', () => setScale(scale - 0.25));
  on($('#ivFit', lb), 'click', () => setScale(1));
  const ivFull = $('#ivFull', lb);
  on(ivFull, 'click', () => toggleFullscreen(stage, ivFull));
  on(document, 'fullscreenchange', () => setBtnIcon(ivFull, (document.fullscreenElement || document.webkitFullscreenElement) ? 'minimize' : 'maximize'));
  on($('#ivClose', lb), 'click', closeLightbox);
  on(stage, 'wheel', e => { e.preventDefault(); setScale(scale + (e.deltaY < 0 ? 0.15 : -0.15)); }, { passive: false });
  on(stage, 'dblclick', () => setScale(1));
  on(stage, 'pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.iv-bar')) return;
    drag = { x: e.clientX, y: e.clientY, tx, ty };
    stage.classList.add('dragging');
    stage.setPointerCapture(e.pointerId);
  });
  on(stage, 'pointermove', e => {
    if (!drag) return;
    tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y;
    apply();
  });
  const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
  on(stage, 'pointerup', endDrag);
  on(stage, 'pointercancel', endDrag);
  apply();
}
/* 全局单一播放器：任何时刻只有一个音频在播，按钮/波形状态由 audio 事件驱动 */
let player = null;
function clearPlayerUI() {
  $$('.play-btn.playing').forEach(b => { b.classList.remove('playing'); b.title = '播放'; });
  $$('.voice-box.playing, .audio-card.playing').forEach(b => b.classList.remove('playing'));
}
function stopPlayer() {
  if (!player) return;
  const { audio } = player;
  audio.onplay = audio.onpause = audio.onended = audio.onerror = null;
  try { audio.pause(); } catch (e) {}
  player = null;
  clearPlayerUI();
}
function syncPlayerUI(playing) {
  if (!player) return;
  const btn = player.btn && player.btn.isConnected
    ? player.btn
    : document.querySelector(`.play-btn[data-id="${player.id}"]`);
  player.btn = btn || null;
  const box = btn ? btn.closest('.voice-box, .audio-card') : null;
  if (btn) { btn.classList.toggle('playing', playing); btn.title = playing ? '暂停' : '播放'; }
  if (box) box.classList.toggle('playing', playing);
}
function togglePlay(id, clickedBtn) {
  const m = findMsg(id);
  if (!m || !m.file) return;
  if (player && player.id === id) {
    if (player.audio.paused) player.audio.play().catch(() => toast('播放失败'));
    else player.audio.pause();
    return;
  }
  stopPlayer();
  const audio = new Audio('/file/' + encodeURIComponent(m.file.id));
  audio.preload = 'metadata';
  // 始终以真正的 .play-btn 作为状态按钮（整卡也可点播放，但图标状态要落在按钮上）
  const btn = document.querySelector(`.play-btn[data-id="${id}"]`) || clickedBtn;
  player = { id, audio, btn };
  audio.onplay = () => syncPlayerUI(true);
  audio.onpause = () => { if (player && player.audio === audio) syncPlayerUI(false); };
  audio.onended = () => { if (player && player.audio === audio) stopPlayer(); };
  audio.onerror = () => { if (player && player.audio === audio) { toast('播放失败'); stopPlayer(); } };
  audio.play().catch(() => { toast('播放失败'); stopPlayer(); });
  syncPlayerUI(true);
}
function closeLightbox() {
  const lb = $('#lightbox');
  const v = LB.video;
  if (v) {
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
  }
  for (const off of LB.cleanup) { try { off(); } catch (e) {} }
  LB.cleanup = []; LB.video = null; LB.view = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  lb.innerHTML = ''; lb.classList.add('hidden');
}
function confirmModal(title, text, onYes, yesLabel = '确定') {
  openModal({
    title,
    body: `<div style="font-size:13.5px;color:var(--text-2);line-height:1.7">${esc(text)}</div>`,
    foot: `<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" id="confirmYes">${esc(yesLabel)}</button>`,
    onMount: root => { $('#confirmYes', root).onclick = () => { closeModal(); onYes(); }; }
  });
}
function onMessageAction(act, id, el) {
  // 打开链接不需要消息对象
  if (act === 'openlink') {
    const u = safeLink(el && el.dataset.url);
    if (u) window.open(u, '_blank', 'noopener,noreferrer');
    else toast('链接无效');
    return;
  }
  // 跳转引用：原消息可能不在当前会话或已撤回
  if (act === 'jumpquote') {
    const node = document.querySelector(`.msg[data-mid="${CSS.escape ? CSS.escape(id) : id}"]`);
    if (!node) { toast('原消息不在当前可见范围内'); return; }
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1200);
    return;
  }
  const m = findMsg(id);
  if (!m) return;
  switch (act) {
    case 'copy': copyMessage(m, el); break;
    case 'play': togglePlay(id, el); break;
    case 'download': downloadFile(m); break;
    case 'preview': openLightbox(m); break;
    case 'quote': setQuote(m); break;
    case 'recall':
      confirmModal('撤回这条消息？', '撤回后自己和所有人都看不到这条消息，且无法恢复。只有发送后 2 分钟内可以撤回。',
        () => wsSend({ t: 'recall', id }), '撤回');
      break;
    case 'delete':
      confirmModal('删除这条消息？', '删除后只有你自己看不到，其他人仍然可以正常看到这条消息。',
        () => wsSend({ t: 'delete', id }), '删除');
      break;
  }
}
/* ---- 引用消息 ---- */
function setQuote(m) {
  S.quote = makeQuote(m);
  renderQuoteBar();
  $('#msgInput').focus();
}
function clearQuote() { S.quote = null; renderQuoteBar(); }
function renderQuoteBar() {
  const bar = $('#quoteBar');
  if (!S.quote) { bar.classList.add('hidden'); return; }
  $('#quoteName').textContent = S.quote.name;
  $('#quoteText').textContent = quoteText(S.quote) || '[消息]';
  bar.classList.remove('hidden');
}

/* ==================================================================
 * Upload (chunked — no size limit)
 * ================================================================== */
const CHUNK = 1024 * 1024;
let draftSeq = 0;
const TYPE_LABEL = { image: '图片', video: '视频', audio: '音频文件', file: '文件' };

/* ---- pending-send drafts: upload first, send only on the send button ---- */
function addDraft(o) {
  const d = {
    id: 'd' + (++draftSeq), type: o.type, name: o.name, size: o.size,
    mime: o.mime || '', duration: o.duration || 0, recorded: !!o.recorded,
    localUrl: o.localUrl || '', file: null, status: 'uploading', pct: 0
  };
  S.drafts.push(d);
  renderDrafts();
  return d;
}
function patchDraft(d, p) { Object.assign(d, p); renderDrafts(); }
function removeDraft(id) {
  const d = S.drafts.find(x => x.id === id);
  if (d && d.localUrl) URL.revokeObjectURL(d.localUrl);
  S.drafts = S.drafts.filter(x => x.id !== id);
  renderDrafts();
}
function clearDrafts() {
  for (const d of S.drafts) if (d.localUrl) URL.revokeObjectURL(d.localUrl);
  S.drafts = [];
  renderDrafts();
}
function draftThumb(d) {
  if (d.localUrl && d.type === 'image') return `<img src="${d.localUrl}" alt="">`;
  if (d.localUrl && d.type === 'video') return `<video src="${d.localUrl}" muted></video>`;
  return icon(typeIcon(d.type));
}
function draftTargetName() {
  const c = S.convs.find(x => x.id === S.conv);
  return c ? c.name : '公共群聊';
}
function renderDrafts() {
  $('#draftBar').classList.toggle('hidden', S.drafts.length === 0);
  const ready = S.drafts.filter(d => d.status === 'ready').length;
  $('#draftCount').textContent = S.drafts.length;
  $('#draftTarget').textContent = '发送到 ' + draftTargetName();
  const badge = $('#sendBadge');
  badge.textContent = ready;
  badge.classList.toggle('hidden', ready === 0);
  $('#draftList').innerHTML = S.drafts.map(d => {
    const label = TYPE_LABEL[d.type] || '文件';
    const done = d.status === 'ready';
    const pct = done ? 100 : (d.pct || 0);
    const sub = done
      ? `${label} · ${fmtSize(d.size)}${d.duration ? ' · ' + d.duration + ' 秒' : ''}`
      : `${label} · ${fmtSize(d.size)} · 上传中`;
    const play = d.type === 'audio' && d.localUrl
      ? `<button class="draft-play play-btn" data-dact="play" data-id="${d.id}" title="试听" aria-label="试听">
           <svg class="ic-play"><use href="#i-play"/></svg><svg class="ic-pause"><use href="#i-pause"/></svg></button>` : '';
    const audio = d.type === 'audio' && d.localUrl
      ? `<audio class="draft-audio" src="${d.localUrl}" data-daudio="${d.id}"></audio>` : '';
    return `<div class="draft-item" data-id="${d.id}">
      <div class="draft-thumb">${draftThumb(d)}</div>
      <div class="draft-meta">
        <div class="draft-name" title="${esc(d.name)}">${esc(d.name)}</div>
        <div class="draft-sub">${sub}</div>
        <div class="draft-track ${done ? 'done' : ''}"><span class="draft-fill" style="width:${pct}%"></span></div>
      </div>
      ${play}
      <span class="draft-pct ${done ? 'done' : ''}">${pct}%</span>
      <button class="draft-del" data-dact="del" data-id="${d.id}" title="删除">${icon('close')}</button>
      ${audio}
    </div>`;
  }).join('');
}
function setDraftProgress(d, p) {
  d.pct = p;
  const el = document.querySelector(`.draft-item[data-id="${d.id}"]`);
  if (!el) return;
  const fill = $('.draft-fill', el); if (fill) fill.style.width = p + '%';
  const pctEl = $('.draft-pct', el); if (pctEl) pctEl.textContent = p + '%';
}
function sendAll() {
  const text = $('#msgInput').value.trim();
  const ready = S.drafts.filter(d => d.status === 'ready');
  const busy = S.drafts.filter(d => d.status === 'uploading');
  if (!text && !ready.length) {
    if (busy.length) toast('文件还在上传中，请稍等');
    else if (S.quote) toast('输入内容后再发送');
    return;
  }
  if (!S.ws || S.ws.readyState !== 1) { toast('连接中，请稍候再试'); return; }
  const quote = S.quote; // 引用快照，随第一条消息一起发出
  if (ready.length) {
    // 文字不单独发一条，而是作为说明附在第一个附件消息上（像 QQ/微信的图文合并）
    ready.forEach((d, i) => {
      const payload = {
        t: 'send', conv: S.conv, type: d.type,
        file: { id: d.file.id }, duration: d.duration || 0, recorded: d.recorded
      };
      if (i === 0) {
        if (text) payload.caption = text;
        if (quote) payload.quote = quote;
      }
      wsSend(payload);
    });
  } else {
    const payload = { t: 'send', conv: S.conv, type: 'text', text };
    if (quote) payload.quote = quote;
    wsSend(payload);
  }
  for (const d of ready) if (d.localUrl) URL.revokeObjectURL(d.localUrl);
  S.drafts = S.drafts.filter(d => d.status !== 'ready');
  $('#msgInput').value = '';
  $('#msgInput').style.height = 'auto';
  clearQuote();
  renderDrafts();
  $('#msgInput').focus();
}
async function uploadFile(file, kind, opts = {}) {
  const count = Math.max(1, Math.ceil(file.size / CHUNK));
  const init = await api('/api/upload/init', {
    token: S.token, name: file.name, size: file.size,
    mime: file.type || 'application/octet-stream', kind, chunks: count
  });
  const uploadId = init.uploadId;
  const queue = Array.from({ length: count }, (_, i) => i);
  // 按字节精确计算进度：每片用 XHR 的 upload.onprogress 实时汇报
  const loaded = new Array(count).fill(0);
  let lastP = -1;
  const report = () => {
    let bytes = 0;
    for (let i = 0; i < count; i++) bytes += loaded[i];
    // 分片全部完成后仍需等服务端合并，因此封顶 99%，完成后再到 100%
    const p = bytes >= file.size ? 99 : Math.min(99, Math.floor(bytes / file.size * 100));
    if (p !== lastP) { lastP = p; if (opts.onProgress) opts.onProgress(p); }
  };
  const postChunk = (i, blob) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${i}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) { loaded[i] = e.loaded; report(); } };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('分片上传失败'));
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(blob);
  });
  const worker = async () => {
    while (queue.length) {
      const i = queue.shift();
      if (opts.cancelled && opts.cancelled()) throw new Error('已取消');
      const blob = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
      let ok = false, lastErr;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try { await postChunk(i, blob); ok = true; }
        catch (e) { lastErr = e; loaded[i] = 0; report(); await new Promise(r => setTimeout(r, 350 * (attempt + 1))); }
      }
      if (!ok) throw lastErr || new Error('上传失败');
      loaded[i] = blob.size; report();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const fin = await api('/api/upload/finish', { uploadId });
  if (opts.onProgress) opts.onProgress(100);
  return fin.file;
}
function kindOf(file, hint) {
  const n = file.name.toLowerCase(), t = (file.type || '').toLowerCase();
  if (hint === 'audio') return 'audio';
  if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|ico)$/.test(n)) return 'image';
  if (t.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi|mkv|ogv|3gp|flv)$/.test(n)) return 'video';
  if (t.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|opus|wma)$/.test(n)) return 'audio';
  return 'file';
}
async function handleFiles(files, hint) {
  for (const f of files) {
    const kind = kindOf(f, hint);
    const localUrl = ['image', 'video', 'audio'].includes(kind) ? URL.createObjectURL(f) : '';
    const d = addDraft({ type: kind, name: f.name, size: f.size, mime: f.type || '', localUrl, recorded: false });
    try {
      const meta = await uploadFile(f, kind, {
        onProgress: p => setDraftProgress(d, p),
        cancelled: () => !S.drafts.includes(d)
      });
      if (!S.drafts.includes(d)) continue;
      patchDraft(d, { status: 'ready', file: meta, pct: 100 });
    } catch (e) {
      if (S.drafts.includes(d)) { removeDraft(d.id); toast('上传失败：' + e.message); }
    }
  }
}
function bindPicker(btnId, inputId, hint) {
  $(btnId).addEventListener('click', () => $(inputId).click());
  $(inputId).addEventListener('change', e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) handleFiles(files, hint);
  });
}

/* ==================================================================
 * Voice recording (max 2 minutes)
 * ================================================================== */
const MAX_REC = 120;
let rec = null;
function pickMime() {
  if (!window.MediaRecorder) return '';
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}
async function startRecording() {
  if (rec) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('当前浏览器不支持录音');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { return toast('需要麦克风权限才能录音'); }
  const mime = pickMime();
  let mr;
  try { mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
  catch (e) { stream.getTracks().forEach(t => t.stop()); return toast('无法开始录音'); }
  const chunks = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const state = { mr, stream, chunks, startAt: Date.now(), timer: null, keep: true, secs: 0 };
  rec = state;
  mr.onstop = async () => {
    clearInterval(state.timer);
    stream.getTracks().forEach(t => t.stop());
    $('#recorder').classList.add('hidden');
    $('#btnMic').classList.remove('recording');
    rec = null;
    if (!state.keep) return;
    if (!chunks.length) return toast('录音太短了');
    const type = mr.mimeType || mime || 'audio/webm';
    const ext = /mp4/.test(type) ? 'm4a' : (/ogg/.test(type) ? 'ogg' : 'webm');
    const blob = new Blob(chunks, { type });
    const file = new File([blob], `语音_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type });
    const localUrl = URL.createObjectURL(blob);
    const d = addDraft({
      type: 'audio', name: file.name, size: blob.size, mime: type,
      duration: state.secs, recorded: true, localUrl
    });
    try {
      const meta = await uploadFile(file, 'audio', {
        onProgress: p => setDraftProgress(d, p),
        cancelled: () => !S.drafts.includes(d)
      });
      if (!S.drafts.includes(d)) return;
      patchDraft(d, { status: 'ready', file: meta, pct: 100 });
      toast('录音已准备好，点「发送」才会发出');
    } catch (e) {
      if (S.drafts.includes(d)) { removeDraft(d.id); toast('录音上传失败：' + e.message); }
    }
  };
  mr.start(200);
  $('#recorder').classList.remove('hidden');
  $('#btnMic').classList.add('recording');
  state.timer = setInterval(() => {
    state.secs = Math.floor((Date.now() - state.startAt) / 1000);
    $('#recTime').textContent = `${pad2(Math.floor(state.secs / 60))}:${pad2(state.secs % 60)}`;
    if (state.secs >= MAX_REC) stopRecording(true);
  }, 200);
  toast('开始录音，最长 2 分钟');
}
// keep=true → 停止并放进「待发送」；false → 取消。两者都不会直接发送
function stopRecording(keep) {
  if (!rec) return;
  rec.keep = keep;
  try { rec.mr.stop(); } catch (e) {}
}

/* ==================================================================
 * Modals
 * ================================================================== */
function openModal({ title, body, foot, onMount }) {
  const root = $('#modalRoot');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close>${icon('close')}</button></div>
    <div class="modal-body">${body}</div>
    ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
  </div>`;
  root.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask || e.target.closest('[data-close]')) closeModal(); });
  S.modalOpen = true;
  if (onMount) onMount($('.modal', mask));
}
function closeModal() {
  const root = $('#modalRoot');
  if (root.lastElementChild) root.lastElementChild.remove();
  S.modalOpen = !!root.children.length;
}
function closeAllModals() { $('#modalRoot').innerHTML = ''; S.modalOpen = false; }
function openSettings() {
  if (!S.me) return;
  S.setAvatar = S.me.avatar;
  const presetHTML = PRESET.map((c, i) => `<button type="button" class="preset" data-i="${i}" style="background:${c}">${i + 1}</button>`).join('');
  openModal({
    title: '设置',
    body: `
      <div class="modal-field"><div class="modal-label">头像</div>
        <div class="avatar-picker"><div id="setAvatarBig" class="avatar avatar-xl"></div>
          <div class="avatar-presets" id="setPresets">${presetHTML}</div>
          <button class="btn btn-ghost btn-sm" id="setAvatarUpload">${icon('upload')} 上传头像</button>
          <input type="file" id="setAvatarFile" accept="image/*" hidden>
        </div></div>
      <div class="modal-field"><div class="modal-label">名字</div>
        <input id="setName" class="input" value="${esc(S.me.name)}" autocomplete="off">
        <div class="modal-hint">1~10 位字符，中文、英文、数字、符号都可以；不能与别人重复。</div></div>
      <div class="modal-field"><div class="modal-label">加好友设置</div>
        <div class="switch-row"><div><strong>好友验证</strong>
          <small>开启后，别人添加你需要你同意；关闭时别人可以直接添加成功（默认关闭）</small></div>
          <button class="switch ${S.me.friendVerify ? 'on' : ''}" id="verifySwitch" aria-label="好友验证"></button></div></div>
      <div class="modal-field"><div class="modal-label">我的身份码</div>
        <div class="token-box"><span id="tokenText">${esc(S.token)}</span>
          <button class="icon-btn" id="copyToken" title="复制">${icon('copy')}</button></div>
        <div class="modal-hint">换设备或清理浏览器数据后，可在登录页用身份码恢复这个账号。请自行保存。</div></div>`,
    foot: `<button class="btn btn-ghost" id="switchIdentity">切换身份</button>
           <button class="btn btn-primary" id="saveProfile">保存</button>`,
    onMount: root => {
      const paint = () => {
        $('#setAvatarBig', root).outerHTML = avatarHTML({ name: $('#setName', root).value.trim() || '?', avatar: S.setAvatar }, 'avatar-xl')
          .replace('class="avatar avatar-xl"', 'class="avatar avatar-xl" id="setAvatarBig"');
        $$('#setPresets .preset', root).forEach(b => b.classList.toggle('active', S.setAvatar === 'preset:' + b.dataset.i));
      };
      paint();
      $('#setPresets', root).addEventListener('click', e => {
        const b = e.target.closest('.preset'); if (!b) return;
        S.setAvatar = 'preset:' + b.dataset.i; paint();
      });
      $('#setName', root).addEventListener('input', paint);
      $('#setAvatarUpload', root).addEventListener('click', () => $('#setAvatarFile', root).click());
      $('#setAvatarFile', root).addEventListener('change', async e => {
        const f = e.target.files[0]; e.target.value = '';
        if (!f) return;
        toast('正在上传头像…');
        try {
          const meta = await uploadFile(f, 'image');
          S.setAvatar = 'file:' + meta.id; paint(); toast('头像已上传，记得保存');
        } catch (err) { toast('上传失败：' + err.message); }
      });
      let verify = !!S.me.friendVerify;
      $('#verifySwitch', root).onclick = e => {
        verify = !verify;
        e.currentTarget.classList.toggle('on', verify);
        wsSend({ t: 'settings', friendVerify: verify });
        toast(verify ? '好友验证已开启' : '好友验证已关闭');
      };
      $('#copyToken', root).onclick = async () => toast((await writeClip(S.token)) ? '身份码已复制' : '复制失败');
      $('#saveProfile', root).onclick = () => {
        const name = $('#setName', root).value.trim();
        const n = Array.from(name).length;
        if (n < 1 || n > 10) return toast('名字需为 1~10 个字符');
        const changed = {};
        if (name !== S.me.name) changed.name = name;
        if (S.setAvatar !== S.me.avatar) changed.avatar = S.setAvatar;
        if (Object.keys(changed).length) wsSend({ t: 'profile', ...changed });
        else toast('没有需要保存的修改');
        closeModal();
      };
      $('#switchIdentity', root).onclick = () => {
        confirmModal('切换身份？', '当前身份会从这台设备移除。请确认已保存身份码，否则将无法找回这个名字和聊天记录。', () => {
          localStorage.removeItem('hf_token');
          S.token = ''; S.me = null; S.ws && S.ws.close(); S.ws = null;
          closeAllModals(); showAuth();
        }, '确认切换');
      };
    }
  });
}
function openConvInfo() {
  const c = S.convs.find(x => x.id === S.conv);
  if (!c) return;
  const ids = S.conv === 'group' ? Object.keys(S.users) : c.members;
  const rows = ids.map(id => {
    const u = S.users[id]; if (!u) return '';
    return `<div class="member-row">${avatarHTML(u)}
      <span class="m-name">${esc(u.name)} ${id === S.me.id ? '（我）' : ''}</span>
      <span class="m-tag">${S.online.has(id) ? '在线' : '离线'}${u.friendVerify ? ' · 需验证' : ''}</span></div>`;
  }).join('');
  openModal({
    title: S.conv === 'group' ? '公共群聊' : '会话信息',
    body: `<div class="modal-hint" style="margin-bottom:10px">${ids.length} 位成员 · 所有人自动加入公共群聊</div>${rows}`,
    foot: `<button class="btn btn-ghost" data-close>关闭</button>`
  });
}

/* ==================================================================
 * Wiring
 * ================================================================== */
function closeSidebarMobile() {
  $('#sidebar').classList.remove('open');
  $('#sidebarMask').classList.remove('show');
}
function initUI() {
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    S.tab = t.dataset.tab;
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    S.search = ''; $('#searchInput').value = '';
    renderSide();
  }));
  $('#searchInput').addEventListener('input', e => { S.search = e.target.value; renderSide(); });
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#convInfoBtn').addEventListener('click', openConvInfo);
  $('#menuBtn').addEventListener('click', () => {
    $('#sidebar').classList.add('open'); $('#sidebarMask').classList.add('show');
  });
  $('#sidebarMask').addEventListener('click', closeSidebarMobile);

  $('#sideList').addEventListener('click', e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const { act, id } = el.dataset;
    if (act === 'conv') openConv(id);
    else if (act === 'dm') startDm(id);
    else if (act === 'accept') wsSend({ t: 'friend_accept', id });
    else if (act === 'reject') wsSend({ t: 'friend_reject', id });
  });

  $('#messages').addEventListener('click', e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    onMessageAction(el.dataset.act, el.dataset.id, el);
  });
  $('#quoteCancel').addEventListener('click', clearQuote);

  $('#msgInput').addEventListener('input', e => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 130) + 'px';
  });
  $('#msgInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendAll(); }
  });
  $('#sendBtn').addEventListener('click', sendAll);

  bindPicker('#btnFile', '#fileInput', null);
  bindPicker('#btnImage', '#imageInput', 'image');
  bindPicker('#btnVideo', '#videoInput', 'video');
  // 音频文件统一走「添加任意文件」入口，不再有独立的音乐按钮
  $('#btnMic').addEventListener('click', () => rec ? stopRecording(true) : startRecording());
  $('#recCancel').addEventListener('click', () => stopRecording(false));
  $('#recDone').addEventListener('click', () => stopRecording(true));

  $('#draftList').addEventListener('click', e => {
    const el = e.target.closest('[data-dact]'); if (!el) return;
    const d = S.drafts.find(x => x.id === el.dataset.id); if (!d) return;
    if (el.dataset.dact === 'del') removeDraft(d.id);
    else if (el.dataset.dact === 'play') {
      const a = document.querySelector(`[data-daudio="${d.id}"]`);
      if (!a) return;
      $$('.draft-play.playing').forEach(b => {
        if (b === el) return;
        b.classList.remove('playing');
        const other = document.querySelector(`[data-daudio="${b.dataset.id}"]`);
        if (other) other.pause();
      });
      if (a.paused) {
        a.play().catch(() => toast('试听失败'));
        el.classList.add('playing');
      } else {
        a.pause();
        el.classList.remove('playing');
      }
      a.onended = () => el.classList.remove('playing');
      a.onpause = () => el.classList.remove('playing');
      a.onplay = () => el.classList.add('playing');
    }
  });
  $('#clearDrafts').addEventListener('click', clearDrafts);

  // Drag & drop anywhere in the chat area
  const chat = $('.chat');
  chat.addEventListener('dragover', e => { e.preventDefault(); });
  chat.addEventListener('drop', e => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) handleFiles(files, null);
  });
  // Paste images / files
  document.addEventListener('paste', e => {
    if (S.modalOpen || !$('#app') || $('#app').classList.contains('hidden')) return;
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) { e.preventDefault(); handleFiles(files, null); }
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').classList.contains('hidden')) closeLightbox();
    else if (S.modalOpen) closeModal();
  });

  // 撤回按钮不显示倒计时数字，仅在 2 分钟窗口结束后自动消失
  setInterval(() => {
    const t = serverNow();
    $$('[data-recall-until]').forEach(b => {
      if (Number(b.dataset.recallUntil) <= t) b.remove();
    });
  }, 1000);

  // 强制锁定缩放：拦截双指手势、Ctrl+滚轮、键盘缩放（PC 也不允许缩放页面）
  document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });
  document.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0', 'Add', 'Subtract'].includes(e.key)) e.preventDefault();
  });
}

/* ---------------- go ---------------- */
initAuth();
initUI();
boot();
