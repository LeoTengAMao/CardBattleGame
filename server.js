/* =========================================================================
   server.js — 決鬥力場 帳號系統後端（零外部套件版）
   -------------------------------------------------------------------------
   只使用 Node.js 內建模組（http / crypto / fs），不需要 npm install，
   也就不會遇到任何套件安裝失敗或版本相容性問題，部署到任何有 Node.js
   的環境都能直接 `node server.js` 跑起來。

   功能：
     - 註冊 / 登入（密碼用 Node 內建 crypto.scrypt 雜湊，JWT 自己手刻簽章）
     - 個人戰績（勝/敗/平、勝率）
     - 好友系統（送出邀請、接受、列表）
     - 排行榜（依勝場數排序）
     - 對戰結果回報

   資料儲存：純 JSON 檔案（duel-db.json），不需要另外安裝資料庫服務。
   這個方式適合好友間規模的休閒對戰；如果之後使用者變多、需要更穩定的
   並行寫入，再升級成 SQLite 或其他正式資料庫即可（資料結構不需大改）。

   啟動方式：
     node server.js
   預設監聽 PORT=3001，可用環境變數 PORT 覆蓋。
   ========================================================================= */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
// 部署到正式環境時，請務必透過環境變數設定一組自己的密鑰，不要使用預設值。
const JWT_SECRET = process.env.JWT_SECRET || 'duel-field-dev-secret-please-change-me';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'duel-db.json');

// ---------- 簡易 JSON 檔案資料庫 ----------
function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: [], friendRequests: [], matchReports: [], nextUserId: 1, nextReqId: 1, nextReportId: 1 };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
// 簡單防止同時寫入互相覆蓋：所有寫入都包成這個函式，讀取→改→立即寫回。
let db = loadDb();
function withDb(fn) {
  const result = fn(db);
  saveDb(db);
  return result;
}

function getUserByUsername(username) {
  return db.users.find(u => u.username === username);
}
function getUserById(id) {
  return db.users.find(u => u.id === id);
}

// ---------- 密碼雜湊（Node內建 crypto.scrypt，不需要額外套件）----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

// ---------- 手刻簡易 JWT（HMAC-SHA256，等同 JWT 的 HS256）----------
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64').toString('utf8');
}
function signToken(payload, expiresInSec = 30 * 24 * 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSec };
  const headerEnc = base64url(JSON.stringify(header));
  const bodyEnc = base64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${headerEnc}.${bodyEnc}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${headerEnc}.${bodyEnc}.${sig}`;
}
function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerEnc, bodyEnc, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${headerEnc}.${bodyEnc}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (sig !== expectedSig) return null;
  const body = JSON.parse(base64urlDecode(bodyEnc));
  if (body.exp && Date.now() / 1000 > body.exp) return null;
  return body;
}

function computeStats(userId) {
  const reports = db.matchReports.filter(r => r.userId === userId);
  const stats = { wins: 0, losses: 0, draws: 0 };
  reports.forEach(r => {
    if (r.result === 'win') stats.wins++;
    else if (r.result === 'lose') stats.losses++;
    else if (r.result === 'draw') stats.draws++;
  });
  stats.total = stats.wins + stats.losses + stats.draws;
  stats.winRate = stats.total > 0 ? Math.round((stats.wins / stats.total) * 1000) / 10 : 0;
  return stats;
}

// ---------- 極簡 HTTP 路由器 ----------
const routes = []; // { method, pattern(RegExp), keys, auth, handler }
function addRoute(method, path, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const pattern = new RegExp('^' + path.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, keys, auth: !!opts.auth, handler });
}

// ---- 顯示遊戲首頁 ----
addRoute('GET', '/', ({ res, send }) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    send(404, { error: '找不到 index.html 遊戲檔案' });
  }
});

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  if (req.method === 'OPTIONS') {
    return send(res, 204, {});
  }

  const route = routes.find(r => r.method === req.method && r.pattern.test(pathname));
  if (!route) return send(res, 404, { error: '找不到這個路徑' });

  const match = pathname.match(route.pattern);
  const params = {};
  route.keys.forEach((k, i) => { params[k] = match[i + 1]; });

  let user = null;
  if (route.auth) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token ? verifyToken(token) : null;
    if (!payload) return send(res, 401, { error: '未登入或登入已過期' });
    user = payload; // { uid, username }
  }

  let body = {};
  if (req.method === 'POST') {
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: '請求格式錯誤' }); }
  }

  try {
    await route.handler({ req, res, params, query: urlObj.searchParams, body, user, send: (status, obj) => send(res, status, obj) });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: '伺服器內部錯誤' });
  }
});

// ===================== 路由定義 =====================

addRoute('GET', '/api/health', ({ send }) => send(200, { ok: true }));

// ---- 註冊 ----
addRoute('POST', '/api/auth/register', ({ body, send }) => {
  const { username, password } = body || {};
  if (!username || !password) return send(400, { error: '請輸入帳號與密碼' });
  if (username.length < 3 || username.length > 20) return send(400, { error: '帳號長度需介於3-20字元' });
  if (!/^[a-zA-Z0-9_\u4e00-\u9fff]+$/.test(username)) return send(400, { error: '帳號只能用中英文、數字、底線' });
  if (password.length < 6) return send(400, { error: '密碼至少需要6個字元' });
  if (getUserByUsername(username)) return send(409, { error: '這個帳號已經被使用了' });

  const user = withDb(d => {
    const newUser = { id: d.nextUserId++, username, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    d.users.push(newUser);
    return newUser;
  });
  const token = signToken({ uid: user.id, username: user.username });
  send(200, { token, username: user.username });
});

// ---- 登入 ----
addRoute('POST', '/api/auth/login', ({ body, send }) => {
  const { username, password } = body || {};
  if (!username || !password) return send(400, { error: '請輸入帳號與密碼' });
  const user = getUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return send(401, { error: '帳號或密碼錯誤' });
  }
  const token = signToken({ uid: user.id, username: user.username });
  send(200, { token, username: user.username });
});

// ---- 我的資料 ----
addRoute('GET', '/api/me', { auth: true }, ({ user, send }) => {
  const u = getUserById(user.uid);
  if (!u) return send(404, { error: '找不到使用者' });
  send(200, { username: u.username, createdAt: u.createdAt, stats: computeStats(u.id) });
});

// ---- 排行榜 ----
addRoute('GET', '/api/leaderboard', ({ query, send }) => {
  const limit = Math.min(parseInt(query.get('limit')) || 20, 100);
  const board = db.users.map(u => ({ username: u.username, ...computeStats(u.id) }))
    .filter(u => u.total > 0)
    .sort((a, b) => (b.wins - a.wins) || (b.winRate - a.winRate))
    .slice(0, limit);
  send(200, { leaderboard: board });
});

// ---- 對戰結果回報 ----
addRoute('POST', '/api/match/report', { auth: true }, ({ body, user, send }) => {
  const { matchUuid, opponentUsername, result, charKey, fieldKey } = body || {};
  if (!matchUuid || !['win', 'lose', 'draw'].includes(result)) {
    return send(400, { error: '回報資料不完整' });
  }
  const existing = db.matchReports.find(r => r.matchUuid === matchUuid && r.userId === user.uid);
  if (existing) return send(200, { ok: true, duplicate: true });

  withDb(d => {
    d.matchReports.push({
      id: d.nextReportId++, matchUuid, userId: user.uid,
      opponentUsername: opponentUsername || null, result,
      charKey: charKey || null, fieldKey: fieldKey || null,
      createdAt: new Date().toISOString(),
    });
  });
  send(200, { ok: true, stats: computeStats(user.uid) });
});

// ---- 對戰紀錄 ----
addRoute('GET', '/api/match/history', { auth: true }, ({ query, user, send }) => {
  const limit = Math.min(parseInt(query.get('limit')) || 20, 100);
  const rows = db.matchReports.filter(r => r.userId === user.uid)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
  send(200, { history: rows });
});

// ---- 好友：送出邀請 ----
addRoute('POST', '/api/friends/request', { auth: true }, ({ body, user, send }) => {
  const { toUsername } = body || {};
  if (!toUsername) return send(400, { error: '請輸入對方帳號' });
  if (toUsername === user.username) return send(400, { error: '不能加自己好友' });
  const target = getUserByUsername(toUsername);
  if (!target) return send(404, { error: '找不到這個帳號' });

  const reverse = db.friendRequests.find(r => r.fromUserId === target.id && r.toUserId === user.uid);
  if (reverse && reverse.status === 'accepted') return send(409, { error: '你們已經是好友了' });
  if (reverse && reverse.status === 'pending') {
    withDb(d => {
      reverse.status = 'accepted';
      d.friendRequests.push({ id: d.nextReqId++, fromUserId: user.uid, toUserId: target.id, status: 'accepted', createdAt: new Date().toISOString() });
    });
    return send(200, { ok: true, autoAccepted: true });
  }
  const already = db.friendRequests.find(r => r.fromUserId === user.uid && r.toUserId === target.id);
  if (already) return send(409, { error: already.status === 'accepted' ? '你們已經是好友了' : '已經送出過邀請了' });

  withDb(d => {
    d.friendRequests.push({ id: d.nextReqId++, fromUserId: user.uid, toUserId: target.id, status: 'pending', createdAt: new Date().toISOString() });
  });
  send(200, { ok: true });
});

// ---- 好友：回應邀請 ----
addRoute('POST', '/api/friends/respond', { auth: true }, ({ body, user, send }) => {
  const { requestId, accept } = body || {};
  const reqRow = db.friendRequests.find(r => r.id === requestId && r.toUserId === user.uid);
  if (!reqRow) return send(404, { error: '找不到這筆邀請' });

  withDb(d => {
    reqRow.status = accept ? 'accepted' : 'declined';
    if (accept) {
      const mirrorExists = d.friendRequests.find(r => r.fromUserId === user.uid && r.toUserId === reqRow.fromUserId);
      if (!mirrorExists) {
        d.friendRequests.push({ id: d.nextReqId++, fromUserId: user.uid, toUserId: reqRow.fromUserId, status: 'accepted', createdAt: new Date().toISOString() });
      } else {
        mirrorExists.status = 'accepted';
      }
    }
  });
  send(200, { ok: true });
});

// ---- 好友：列表 ----
addRoute('GET', '/api/friends', { auth: true }, ({ user, send }) => {
  const uid = user.uid;
  const friends = db.friendRequests
    .filter(r => r.fromUserId === uid && r.status === 'accepted')
    .map(r => getUserById(r.toUserId)?.username)
    .filter(Boolean);

  const incomingRequests = db.friendRequests
    .filter(r => r.toUserId === uid && r.status === 'pending')
    .map(r => ({ requestId: r.id, username: getUserById(r.fromUserId)?.username }))
    .filter(r => r.username);

  const outgoingRequests = db.friendRequests
    .filter(r => r.fromUserId === uid && r.status === 'pending')
    .map(r => getUserById(r.toUserId)?.username)
    .filter(Boolean);

  send(200, { friends, incomingRequests, outgoingRequests });
});

server.listen(PORT, () => {
  console.log(`決鬥力場後端已啟動：http://localhost:${PORT}`);
  console.log(`資料庫檔案：${DB_PATH}`);
});
