'use strict';
/**
 * Neutral Forum / Chat — single-port HTTP + WebSocket server, zero external dependencies.
 * Data is persisted to data/db.json and uploaded blobs to data/uploads/.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const RECALL_WINDOW = Number(process.env.RECALL_WINDOW_MS) || 2 * 60 * 1000; // 2 minutes

for (const d of [DATA_DIR, UPLOAD_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */
const defaultDB = () => ({
  users: {},          // id -> user
  tokens: {},         // token -> id
  messages: [],       // all messages
  conversations: { group: { id: 'group', type: 'group', createdAt: Date.now() } },
  requests: {},       // id -> friend request
  friends: {},        // id -> [ids]
  files: {}           // id -> file meta
});

let db = defaultDB();
if (fs.existsSync(DB_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = Object.assign(defaultDB(), loaded);
    db.conversations.group = db.conversations.group || { id: 'group', type: 'group', createdAt: Date.now() };
  } catch (e) {
    console.error('[db] load failed, starting fresh:', e.message);
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    } catch (e) {
      console.error('[db] save failed:', e.message);
    }
  }, 60);
}
process.on('SIGINT', () => { flushSave(); process.exit(0); });
process.on('SIGTERM', () => { flushSave(); process.exit(0); });
function flushSave() {
  try {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  } catch (e) { console.error('[db] flush failed:', e.message); }
}

const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const now = () => Date.now();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Cache-Control': 'no-store'
  });
  res.end(b);
}
function readJSON(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('payload too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, avatar: u.avatar, friendVerify: !!u.friendVerify, createdAt: u.createdAt };
}
function userByToken(t) {
  if (!t) return null;
  const id = db.tokens[t];
  return id ? db.users[id] : null;
}
function displayNameValid(name) {
  if (typeof name !== 'string') return false;
  const s = name.trim();
  const len = Array.from(s).length; // counts CJK / emoji as one character
  return len >= 1 && len <= 10 && !/[\r\n\t]/.test(s);
}
function nameTaken(name, exceptId) {
  const s = name.trim().toLowerCase();
  return Object.values(db.users).some(u => u.id !== exceptId && u.name.toLowerCase() === s);
}
function dmId(a, b) { return 'dm:' + [a, b].sort().join(':'); }
function membersOf(conv) {
  if (conv === 'group') return Object.keys(db.users);
  const c = db.conversations[conv];
  return c ? c.members : [];
}
function isMember(conv, uid) { return membersOf(conv).includes(uid); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};
function safeMime(m) {
  if (typeof m !== 'string' || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(;[^,;]{0,80})?$/.test(m)) {
    return 'application/octet-stream';
  }
  return m;
}

/* ------------------------------------------------------------------ *
 * WebSocket (minimal RFC 6455 server implementation, no deps)
 * ------------------------------------------------------------------ */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const online = new Map();          // userId -> Set<WSConn>
const pendingUploads = new Map();  // uploadId -> meta

function readFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = !!(b0 & 0x80);
  const opcode = b0 & 0x0f;
  const masked = !!(b1 & 0x80);
  let len = b1 & 0x7f, off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > 16n * 1024n * 1024n) return null; // avoid pathological frames
    len = Number(big); off = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4); off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { frame: { fin, opcode, payload }, rest: buf.subarray(off + len) };
}
function makeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}
function sendToUser(uid, obj) {
  const set = online.get(uid);
  if (set) for (const c of set) c.send(obj);
}
function broadcastConv(conv, obj) { for (const uid of membersOf(conv)) sendToUser(uid, obj); }
function broadcastAll(obj) { for (const uid of Object.keys(db.users)) sendToUser(uid, obj); }
function presence() { broadcastAll({ t: 'presence', online: [...online.keys()] }); }

class WSConn {
  constructor(socket, userId, head) {
    this.socket = socket;
    this.userId = userId;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.alive = true;
    if (!online.has(userId)) online.set(userId, new Set());
    online.get(userId).add(this);
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
    socket.setNoDelay(true);
    this.send({ t: 'hello', me: publicUser(db.users[userId]), online: [...online.keys()] });
    presence();
    if (head && head.length) this.onData(head);
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const r = readFrame(this.buf);
      if (!r) break;
      this.buf = r.rest;
      this.handleFrame(r.frame);
      if (!this.alive) break;
    }
    if (this.buf.length > 24 * 1024 * 1024) this.socket.destroy();
  }
  handleFrame(f) {
    if (f.opcode === 0x8) { this.socket.end(); return; }
    if (f.opcode === 0x9) { try { this.socket.write(makeFrame(f.payload, 0xa)); } catch (e) {} return; }
    if (f.opcode === 0xa) return;
    if (f.opcode === 0x0 || f.opcode === 0x1 || f.opcode === 0x2) {
      if (f.opcode !== 0x0) { this.fragments = [f.payload]; this.fragOpcode = f.opcode; }
      else this.fragments.push(f.payload);
      if (f.fin) {
        const payload = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragOpcode === 0x1) {
          try { this.onMessage(JSON.parse(payload.toString('utf8'))); }
          catch (e) { this.send({ t: 'error', message: '无效的消息格式' }); }
        }
      }
    }
  }
  send(obj) {
    if (!this.alive) return;
    try { this.socket.write(makeFrame(Buffer.from(JSON.stringify(obj)), 0x1)); }
    catch (e) {}
  }
  close() {
    if (!this.alive) return;
    this.alive = false;
    const set = online.get(this.userId);
    if (set) { set.delete(this); if (!set.size) online.delete(this.userId); }
    presence();
  }
  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    const me = this.userId;
    switch (m.t) {
      case 'send': return this.actSend(m, me);
      case 'recall': return this.actRecall(m, me);
      case 'delete': return this.actDelete(m, me);
      case 'dm_open': return this.actDmOpen(m, me);
      case 'friend_accept': return this.actFriendAccept(m, me);
      case 'friend_reject': return this.actFriendReject(m, me);
      case 'profile': return this.actProfile(m, me);
      case 'settings': return this.actSettings(m, me);
      default: return;
    }
  }
  fail(msg) { this.send({ t: 'error', message: msg }); }

  actSend(m, me) {
    const conv = String(m.conv || '');
    if (!isMember(conv, me)) return this.fail('你不在这个会话中');
    const type = String(m.type || 'text');
    if (!['text', 'image', 'video', 'audio', 'file', 'system'].includes(type)) return this.fail('不支持的消息类型');
    const text = typeof m.text === 'string' ? m.text.slice(0, 20000) : '';
    // 合并发送：附件消息附带的说明文字（文字与附件合成一条消息）
    const caption = typeof m.caption === 'string' ? m.caption.slice(0, 20000) : '';
    // 引用消息：保存被引用消息的快照，避免原消息被撤回/删除后引用失效
    let quote = null;
    if (m.quote && typeof m.quote === 'object') {
      const q = m.quote;
      const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
      quote = {
        id: str(q.id, 40), sender: str(q.sender, 40), name: str(q.name, 40),
        type: ['text', 'image', 'video', 'audio', 'file'].includes(q.type) ? q.type : 'text',
        text: str(q.text, 600), fileName: str(q.fileName, 200), recorded: !!q.recorded
      };
    }
    let file = null;
    if (m.file && typeof m.file === 'object' && db.files[m.file.id]) {
      const f = db.files[m.file.id];
      file = { id: f.id, name: f.name, size: f.size, mime: f.mime };
    }
    if (type === 'text' && !text.trim()) return;
    if (type !== 'text' && !file) return this.fail('文件不存在');
    const msg = {
      id: rid(10), conv, sender: me, type, text, caption, quote, file,
      duration: Number(m.duration) || 0,
      recorded: !!m.recorded, // true = 录音语音, false = 上传的音频文件
      ts: now(), recalled: false, deletedBy: []
    };
    db.messages.push(msg);
    if (db.messages.length > 20000) db.messages.splice(0, db.messages.length - 20000);
    save();
    broadcastConv(conv, { t: 'message', conv, message: msg });
  }
  actRecall(m, me) {
    const msg = db.messages.find(x => x.id === m.id);
    if (!msg) return this.fail('消息不存在');
    if (msg.recalled) return;
    if (msg.sender !== me) return this.fail('只能撤回自己发送的消息');
    if (now() - msg.ts > RECALL_WINDOW) return this.fail('超过 2 分钟，不能撤回了');
    msg.recalled = true;
    save();
    broadcastConv(msg.conv, { t: 'recall', conv: msg.conv, id: msg.id });
  }
  actDelete(m, me) {
    const msg = db.messages.find(x => x.id === m.id);
    if (!msg) return this.fail('消息不存在');
    if (!isMember(msg.conv, me)) return this.fail('无权操作');
    if (!msg.deletedBy.includes(me)) msg.deletedBy.push(me);
    save();
    // Only visible to the deleting user (multi-device sync); others keep seeing it.
    sendToUser(me, { t: 'deleted', conv: msg.conv, id: msg.id });
  }
  ensureDm(a, b) {
    const id = dmId(a, b);
    if (!db.conversations[id]) {
      db.conversations[id] = { id, type: 'dm', members: [a, b], createdAt: now() };
      save();
    }
    if (!db.friends[a]) db.friends[a] = [];
    if (!db.friends[b]) db.friends[b] = [];
    if (!db.friends[a].includes(b)) db.friends[a].push(b);
    if (!db.friends[b].includes(a)) db.friends[b].push(a);
    save();
    const payload = { t: 'dm_created', conv: id, users: [publicUser(db.users[a]), publicUser(db.users[b])] };
    sendToUser(a, payload);
    sendToUser(b, payload);
    return id;
  }
  actDmOpen(m, me) {
    const to = String(m.to || '');
    if (!db.users[to] || to === me) return this.fail('用户不存在');
    const target = db.users[to];
    const alreadyFriends = (db.friends[me] || []).includes(to);
    if (target.friendVerify && !alreadyFriends) {
      const existing = Object.values(db.requests).find(r => r.from === me && r.to === to && r.status === 'pending');
      if (existing) return this.send({ t: 'request_sent', request: existing });
      const req = { id: rid(10), from: me, to, status: 'pending', ts: now() };
      db.requests[req.id] = req;
      save();
      this.send({ t: 'request_sent', request: req });
      sendToUser(to, { t: 'friend_request', request: req, from: publicUser(db.users[me]) });
      return;
    }
    const conv = this.ensureDm(me, to);
    this.send({ t: 'dm_ready', conv });
  }
  actFriendAccept(m, me) {
    const r = db.requests[m.id];
    if (!r || r.to !== me || r.status !== 'pending') return this.fail('申请不存在或已处理');
    r.status = 'accepted';
    r.resolvedAt = now();
    save();
    const conv = this.ensureDm(r.from, r.to);
    sendToUser(r.from, { t: 'request_resolved', request: r, conv, from: publicUser(db.users[me]) });
    this.send({ t: 'request_resolved', request: r, conv });
  }
  actFriendReject(m, me) {
    const r = db.requests[m.id];
    if (!r || r.to !== me || r.status !== 'pending') return this.fail('申请不存在或已处理');
    r.status = 'rejected';
    r.resolvedAt = now();
    save();
    sendToUser(r.from, { t: 'request_resolved', request: r });
    this.send({ t: 'request_resolved', request: r });
  }
  actProfile(m, me) {
    const u = db.users[me];
    if (typeof m.name === 'string') {
      if (!displayNameValid(m.name)) return this.fail('名字需为 1~10 个字符');
      if (nameTaken(m.name, me)) return this.fail('这个名字已经被使用了');
      u.name = m.name.trim();
    }
    if (typeof m.avatar === 'string' && m.avatar.length < 500) u.avatar = m.avatar;
    save();
    broadcastAll({ t: 'user_updated', user: publicUser(u) });
    this.send({ t: 'profile_ok', me: publicUser(u) });
  }
  actSettings(m, me) {
    const u = db.users[me];
    u.friendVerify = !!m.friendVerify;
    save();
    broadcastAll({ t: 'user_updated', user: publicUser(u) });
    this.send({ t: 'settings_ok', me: publicUser(u) });
  }
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */
function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  try { p = decodeURIComponent(p.split('?')[0]); } catch (e) { return json(res, 400, { error: 'bad path' }); }
  const full = path.join(PUBLIC_DIR, path.normalize(p));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(full).pipe(res);
  });
}
function serveFile(req, res, id) {
  const f = db.files[id];
  if (!f) return json(res, 404, { error: '文件不存在' });
  const full = path.join(UPLOAD_DIR, f.store);
  let size;
  try { size = fs.statSync(full).size; } catch (e) { return json(res, 404, { error: '文件已丢失' }); }
  const headers = {
    'Content-Type': f.mime,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Cache-Control': 'public, max-age=31536000, immutable'
  };
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start) || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      if (isNaN(end) || end >= size) end = size - 1;
      if (end < start) end = start;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
  }
  headers['Content-Length'] = size;
  res.writeHead(200, headers);
  fs.createReadStream(full).pipe(res);
}
async function appendToStream(src, out) {
  for await (const chunk of src) {
    if (!out.write(chunk)) await once(out, 'drain');
  }
}
function listConversations(uid) {
  const out = [{ id: 'group', type: 'group', name: '公共群聊', members: Object.keys(db.users) }];
  for (const c of Object.values(db.conversations)) {
    if (c.type !== 'dm' || !c.members.includes(uid)) continue;
    const other = c.members.find(x => x !== uid);
    out.push({ id: c.id, type: 'dm', with: other, name: db.users[other] ? db.users[other].name : '已注销用户', members: c.members });
  }
  return out;
}
function buildLasts(uid) {
  const lasts = {};
  for (const c of listConversations(uid)) {
    for (let i = db.messages.length - 1; i >= 0; i--) {
      const m = db.messages[i];
      if (m.conv !== c.id || m.recalled || m.deletedBy.includes(uid)) continue;
      lasts[c.id] = { id: m.id, sender: m.sender, type: m.type, text: m.text, caption: m.caption || '', quote: m.quote || null, file: m.file, ts: m.ts };
      break;
    }
  }
  return lasts;
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  if (route === '/api/register' && method === 'POST') {
    const b = await readJSON(req);
    if (!displayNameValid(b.name)) return json(res, 400, { error: '名字需为 1~10 个字符' });
    if (nameTaken(b.name)) return json(res, 409, { error: '这个名字已经被使用了' });
    const id = rid(10), tk = newToken();
    const u = {
      id, token: tk, name: b.name.trim(),
      avatar: typeof b.avatar === 'string' && b.avatar.length < 500 ? b.avatar : 'preset:0',
      friendVerify: false, createdAt: now()
    };
    db.users[id] = u;
    db.tokens[tk] = id;
    db.friends[id] = [];
    save();
    broadcastAll({ t: 'user_joined', user: publicUser(u) });
    return json(res, 200, { token: tk, me: publicUser(u) });
  }

  if (route === '/api/bootstrap' && method === 'POST') {
    const b = await readJSON(req);
    const u = userByToken(b.token);
    if (!u) return json(res, 401, { error: '身份已失效，请重新设置昵称' });
    const requests = Object.values(db.requests).filter(r => r.from === u.id || r.to === u.id);
    return json(res, 200, {
      me: publicUser(u),
      serverTime: now(),
      users: Object.values(db.users).map(publicUser),
      conversations: listConversations(u.id),
      lasts: buildLasts(u.id),
      requests,
      online: [...online.keys()]
    });
  }

  if (route === '/api/history' && method === 'POST') {
    const b = await readJSON(req);
    const u = userByToken(b.token);
    if (!u) return json(res, 401, { error: '未登录' });
    const conv = String(b.conv || '');
    if (!isMember(conv, u.id)) return json(res, 403, { error: '无权查看' });
    // 新加入成员同样能看到该会话的全部历史消息（不按加入时间过滤）
    let msgs = db.messages.filter(m => m.conv === conv && !m.recalled && !m.deletedBy.includes(u.id));
    const before = Number(b.before);
    if (Number.isFinite(before) && before > 0) msgs = msgs.filter(m => m.ts < before);
    const limit = Number(b.limit) > 0 ? Math.min(Math.floor(Number(b.limit)), 2000) : 2000;
    const total = msgs.length;
    const page = msgs.slice(-limit);
    return json(res, 200, { messages: page, total, hasMore: total > page.length });
  }

  if (route === '/api/upload/init' && method === 'POST') {
    const b = await readJSON(req);
    const u = userByToken(b.token); // uploads are allowed before registration (for avatars)
    const uploadId = rid(16);
    fs.mkdirSync(path.join(TMP_DIR, uploadId), { recursive: true });
    pendingUploads.set(uploadId, {
      owner: u ? u.id : 'anon',
      name: String(b.name || 'file').slice(0, 180).replace(/[\r\n]/g, '_'),
      size: Number(b.size) || 0,
      mime: safeMime(b.mime),
      kind: String(b.kind || 'file'),
      count: Math.max(0, Math.floor(Number(b.chunks) || 0)),
      done: new Set()
    });
    return json(res, 200, { uploadId });
  }

  if (route === '/api/upload/chunk' && method === 'POST') {
    const uploadId = url.searchParams.get('uploadId');
    const idx = parseInt(url.searchParams.get('index'), 10);
    const meta = pendingUploads.get(uploadId);
    if (!meta) return json(res, 404, { error: '上传会话不存在' });
    if (!Number.isInteger(idx) || idx < 0 || idx > 1000000) return json(res, 400, { error: '分片序号无效' });
    const dest = path.join(TMP_DIR, uploadId, String(idx));
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      req.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      req.on('aborted', reject);
    });
    meta.done.add(idx);
    return json(res, 200, { ok: true, index: idx });
  }

  if (route === '/api/upload/finish' && method === 'POST') {
    const b = await readJSON(req);
    const uploadId = String(b.uploadId || '');
    const meta = pendingUploads.get(uploadId);
    if (!meta) return json(res, 404, { error: '上传会话不存在' });
    const count = Math.max(meta.count, meta.done.size ? Math.max(...meta.done) + 1 : 0);
    for (let i = 0; i < count; i++) {
      if (!fs.existsSync(path.join(TMP_DIR, uploadId, String(i)))) {
        return json(res, 400, { error: `缺少第 ${i + 1} 个分片` });
      }
    }
    const fileId = rid(16);
    const dest = path.join(UPLOAD_DIR, fileId);
    const out = fs.createWriteStream(dest);
    for (let i = 0; i < count; i++) {
      await appendToStream(fs.createReadStream(path.join(TMP_DIR, uploadId, String(i))), out);
    }
    out.end();
    await once(out, 'finish');
    const size = fs.statSync(dest).size;
    const f = {
      id: fileId, store: fileId, name: meta.name, size,
      mime: meta.mime, kind: meta.kind, owner: meta.owner, ts: now()
    };
    db.files[fileId] = f;
    save();
    pendingUploads.delete(uploadId);
    fs.rmSync(path.join(TMP_DIR, uploadId), { recursive: true, force: true });
    return json(res, 200, { file: { id: f.id, name: f.name, size: f.size, mime: f.mime, url: '/file/' + f.id, kind: f.kind } });
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { return json(res, 400, { error: 'bad request' }); }
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    handleApi(req, res, url).catch(e => {
      console.error('[api]', p, e.message);
      if (!res.headersSent) json(res, 500, { error: '服务器开小差了：' + e.message });
    });
    return;
  }
  if (p.startsWith('/file/')) return serveFile(req, res, p.slice(6));
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
  json(res, 404, { error: 'not found' });
});

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { socket.destroy(); return; }
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const t = url.searchParams.get('token');
  const uid = t && db.tokens[t];
  const key = req.headers['sec-websocket-key'];
  if (!uid || !key) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  new WSConn(socket, uid, head);
});

// Clean up orphaned upload temp folders older than 24h
setInterval(() => {
  try {
    const cutoff = now() - 24 * 3600 * 1000;
    for (const name of fs.readdirSync(TMP_DIR)) {
      const d = path.join(TMP_DIR, name);
      try { if (fs.statSync(d).mtimeMs < cutoff) fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) {}
}, 3600 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Neutral Forum running on http://0.0.0.0:${PORT}`);
});
