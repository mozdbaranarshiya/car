import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomToken, digest, equal, hashPassword, verifyPassword, base32, verifyTotp, encrypt, decrypt, digits, phone } from './auth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const allowedAssets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/config.js', ['config.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/vendor/maplibre-gl.js', ['vendor/maplibre-gl.js', 'text/javascript; charset=utf-8']],
  ['/vendor/maplibre-gl.css', ['vendor/maplibre-gl.css', 'text/css; charset=utf-8']],
  ['/vendor/rtl-text-plugin.js', ['vendor/rtl-text-plugin.js', 'text/javascript; charset=utf-8']]
]);
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message, status = 400) => { throw new HttpError(status, message); };

export async function makeServer(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || resolve(here, 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = resolve(dataDir, 'server.key');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const key = readFileSync(keyPath);
  const db = new DatabaseSync(resolve(dataDir, 'tracker.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password TEXT NOT NULL,
      totp TEXT NOT NULL, last_step INTEGER NOT NULL DEFAULT -1);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
      consent INTEGER NOT NULL DEFAULT 1, disclosure_version INTEGER NOT NULL, consent_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, latitude REAL, longitude REAL, accuracy REAL, captured_at INTEGER,
      received_at INTEGER, battery INTEGER);
    CREATE INDEX IF NOT EXISTS devices_phone ON devices(phone);`);
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN || '';
  const production = options.production ?? process.env.NODE_ENV === 'production';
  if (production && (!publicOrigin || !publicOrigin.startsWith('https://'))) {
    db.close(); throw new Error('PUBLIC_ORIGIN must be an HTTPS origin in production');
  }
  const setupToken = options.setupToken || process.env.ADMIN_SETUP_TOKEN || randomToken();
  const dummyHash = await hashPassword(randomToken());
  let setupPending = null;
  const challenges = new Map(), limits = new Map();
  const adminRecord = () => db.prepare('SELECT * FROM admin WHERE id=1').get();

  function rateLimit(req, category, maximum, interval) {
    const now = Date.now();
    // Use the connection IP. Do not trust a client-supplied X-Forwarded-For header.
    const key = `${category}:${req.socket.remoteAddress}`;
    for (const [k, v] of limits) if (v.reset <= now) limits.delete(k);
    if (!limits.has(key) && limits.size >= 5000) bad('سامانه شلوغ است؛ کمی بعد تلاش کنید.', 429);
    const value = limits.get(key) || { count: 0, reset: now + interval };
    value.count++; limits.set(key, value);
    if (value.count > maximum) bad('تعداد تلاش‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.', 429);
  }
  function json(res, status, payload, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(payload));
  }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) bad('قالب درخواست نامعتبر است.', 415);
    let text = '';
    for await (const chunk of req) {
      text += chunk.toString('utf8'); if (Buffer.byteLength(text) > 16384) bad('درخواست بیش از حد بزرگ است.', 413);
    }
    try { const v = JSON.parse(text); if (!v || Array.isArray(v) || typeof v !== 'object') bad('درخواست نامعتبر است.'); return v; }
    catch (e) { if (e instanceof HttpError) throw e; bad('درخواست نامعتبر است.'); }
  }
  function requireOrigin(req) {
    const expected = publicOrigin || `http://${req.headers.host}`;
    if (!req.headers.origin || req.headers.origin !== expected) bad('مبدأ درخواست مجاز نیست.', 403);
  }
  function device(req) {
    const auth = req.headers.authorization || '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) bad('دسترسی مجاز نیست.', 401);
    const user = db.prepare('SELECT * FROM devices WHERE token_hash=?').get(digest(auth.slice(7)));
    if (!user) bad('دسترسی مجاز نیست.', 401);
    return user;
  }
  function session(req) {
    const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('tracker_session='));
    const token = cookie?.slice('tracker_session='.length) || '';
    const value = db.prepare('SELECT expires FROM sessions WHERE hash=?').get(digest(token));
    if (!value || value.expires <= Date.now()) bad('لطفاً وارد شوید.', 401);
    return digest(token);
  }
  function cookie(value, maxAge = 8 * 60 * 60) {
    return `tracker_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${production || publicOrigin.startsWith('https://') ? '; Secure' : ''}`;
  }
  function credentials(input) {
    const username = String(input.username || '').trim();
    const password = String(input.password || '');
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) bad('نام کاربری باید ۳ تا ۶۴ حرف یا عدد انگلیسی باشد.');
    if (password.length < 12 || password.length > 256) bad('رمز عبور باید بین ۱۲ تا ۲۵۶ نویسه باشد.');
    return { username, password };
  }
  function profile(d) {
    return { id: d.id, name: d.name, phone: d.phone, consent: Boolean(d.consent),
      latitude: d.latitude, longitude: d.longitude, accuracy: d.accuracy,
      capturedAt: d.captured_at, receivedAt: d.received_at, battery: d.battery };
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tiles.openfreemap.org; font-src 'self' https://tiles.openfreemap.org; connect-src 'self' https://tiles.openfreemap.org; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, 'http://internal'), path = url.pathname;
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && path === '/api/admin/status') return json(res, 200, { configured: Boolean(adminRecord()) });
      if (req.method === 'POST' && path.startsWith('/api/admin/')) requireOrigin(req);
      if (req.method === 'POST' && path === '/api/admin/setup') {
        rateLimit(req, 'setup', 8, 15 * 60 * 1000);
        if (adminRecord()) bad('مدیر قبلاً تعریف شده است.', 409);
        const b = await body(req);
        if (!equal(b.setupToken || '', setupToken)) bad('کلید راه‌اندازی نادرست است.', 403);
        const { username, password } = credentials(b);
        const secret = base32(randomBytes(20)), challenge = randomToken();
        setupPending = { username, password: await hashPassword(password), secret,
          challenge: digest(challenge), expires: Date.now() + 10 * 60 * 1000 };
        return json(res, 200, { challenge, secret,
          otpauth: `otpauth://totp/${encodeURIComponent('Radyabi:' + username)}?secret=${secret}&issuer=Radyabi&algorithm=SHA1&digits=6&period=30` });
      }
      if (req.method === 'POST' && path === '/api/admin/setup/confirm') {
        rateLimit(req, 'setup-otp', 10, 15 * 60 * 1000);
        const b = await body(req);
        if (adminRecord() || !setupPending || setupPending.expires <= Date.now() || !equal(digest(b.challenge || ''), setupPending.challenge)) bad('راه‌اندازی منقضی شده است؛ دوباره شروع کنید.', 401);
        const step = verifyTotp(setupPending.secret, digits(b.code));
        if (step === null) bad('کد Ente Auth نادرست است.', 401);
        db.prepare('INSERT INTO admin(id,username,password,totp,last_step) VALUES(1,?,?,?,?)')
          .run(setupPending.username, setupPending.password, encrypt(setupPending.secret, key), step);
        setupPending = null;
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/admin/login') {
        rateLimit(req, 'login', 8, 15 * 60 * 1000);
        const b = await body(req), admin = adminRecord();
        const password = String(b.password || '');
        if (password.length > 256) bad('اطلاعات ورود نادرست است.', 401);
        const valid = await verifyPassword(password, admin?.password || dummyHash);
        if (!admin || !valid || !equal(String(b.username || ''), admin.username)) bad('نام کاربری یا رمز عبور نادرست است.', 401);
        for (const [k, v] of challenges) if (v.expires < Date.now()) challenges.delete(k);
        if (challenges.size >= 1000) bad('لطفاً کمی بعد تلاش کنید.', 429);
        const challenge = randomToken();
        challenges.set(digest(challenge), { expires: Date.now() + 5 * 60 * 1000, attempts: 0 });
        return json(res, 200, { challenge });
      }
      if (req.method === 'POST' && path === '/api/admin/verify') {
        rateLimit(req, 'login-otp', 20, 15 * 60 * 1000);
        const b = await body(req), challengeHash = digest(b.challenge || '');
        const challenge = challenges.get(challengeHash), admin = adminRecord();
        if (!challenge || !admin || challenge.expires <= Date.now() || ++challenge.attempts > 5) {
          challenges.delete(challengeHash); bad('ورود منقضی شده است؛ دوباره وارد شوید.', 401);
        }
        const step = verifyTotp(decrypt(admin.totp, key), digits(b.code), admin.last_step);
        if (step === null) bad('کد نادرست یا قبلاً استفاده شده است.', 401);
        db.prepare('UPDATE admin SET last_step=? WHERE id=1').run(step);
        challenges.delete(challengeHash);
        db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
        const token = randomToken();
        db.prepare('INSERT INTO sessions(hash,expires) VALUES(?,?)').run(digest(token), Date.now() + 8 * 60 * 60 * 1000);
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(token) });
      }
      if (req.method === 'POST' && path === '/api/admin/logout') {
        db.prepare('DELETE FROM sessions WHERE hash=?').run(session(req));
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
      }
      if (req.method === 'GET' && path === '/api/admin/people') {
        session(req);
        const query = String(url.searchParams.get('phone') || '').slice(0, 30);
        const normalized = query ? phone(query) : null;
        if (query && !normalized) return json(res, 200, { people: [] });
        const records = normalized ? db.prepare('SELECT * FROM devices WHERE phone=? ORDER BY created_at DESC LIMIT 1000').all(normalized)
          : db.prepare('SELECT * FROM devices ORDER BY created_at DESC LIMIT 1000').all();
        return json(res, 200, { people: records.map(profile) });
      }
      if (req.method === 'POST' && path === '/api/device/register') {
        rateLimit(req, 'register', 20, 60 * 60 * 1000);
        if (!adminRecord()) bad('سامانه هنوز راه‌اندازی نشده است.', 503);
        const b = await body(req), name = String(b.name || '').trim(), mobile = phone(b.phone);
        if (name.length < 2 || name.length > 80 || /[\u0000-\u001f]/.test(name)) bad('نام معتبر وارد کنید.');
        if (!mobile) bad('شماره موبایل معتبر وارد کنید.');
        if (b.consent !== true || b.disclosureVersion !== 1) bad('رضایت به ارسال موقعیت الزامی است.', 403);
        const id = randomToken(), token = randomToken(), now = Date.now();
        // A phone number is an unverified label, never an authentication credential.
        db.prepare('INSERT INTO devices(id,token_hash,name,phone,consent,disclosure_version,consent_at,created_at) VALUES(?,?,?,?,1,1,?,?)')
          .run(id, digest(token), name, mobile, now, now);
        return json(res, 201, { id, token, name, phone: mobile });
      }
      if (req.method === 'GET' && path === '/api/device/me') return json(res, 200, profile(device(req)));
      if (req.method === 'POST' && path === '/api/device/consent') {
        const d = device(req), b = await body(req);
        if (typeof b.consent !== 'boolean') bad('مقدار رضایت نامعتبر است.');
        if (b.consent && b.disclosureVersion !== 1) bad('رضایت باید دوباره تأیید شود.', 403);
        if (b.consent) db.prepare('UPDATE devices SET consent=1,consent_at=?,disclosure_version=1 WHERE id=?').run(Date.now(), d.id);
        else db.prepare('UPDATE devices SET consent=0,latitude=NULL,longitude=NULL,accuracy=NULL,captured_at=NULL,received_at=NULL,battery=NULL WHERE id=?').run(d.id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/device/location') {
        const d = device(req); rateLimit(req, 'location:' + d.id, 20, 60 * 1000);
        if (!d.consent) bad('ارسال موقعیت متوقف شده است.', 403);
        const b = await body(req), now = Date.now();
        if (!Number.isFinite(b.latitude) || b.latitude < -90 || b.latitude > 90 ||
            !Number.isFinite(b.longitude) || b.longitude < -180 || b.longitude > 180 ||
            !Number.isFinite(b.accuracy) || b.accuracy < 0 || b.accuracy > 50000 ||
            !Number.isSafeInteger(b.capturedAt) || b.capturedAt > now + 60000 || b.capturedAt < now - 48 * 60 * 60 * 1000) bad('اطلاعات موقعیت نامعتبر است.');
        const battery = Number.isInteger(b.battery) && b.battery >= 0 && b.battery <= 100 ? b.battery : null;
        if (d.captured_at && b.capturedAt < d.captured_at) return json(res, 200, { ok: true, ignored: true });
        db.prepare('UPDATE devices SET latitude=?,longitude=?,accuracy=?,captured_at=?,received_at=?,battery=? WHERE id=? AND consent=1')
          .run(b.latitude, b.longitude, b.accuracy, b.capturedAt, now, battery, d.id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && allowedAssets.has(path)) {
        const [name, type] = allowedAssets.get(path), file = resolve(here, 'public', name);
        if (!existsSync(file)) bad('فایل یافت نشد.', 404);
        const content = readFileSync(file);
        res.writeHead(200, { 'Content-Type': type }); return res.end(content);
      }
      bad('مسیر یافت نشد.', 404);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Request failed:', error.message);
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'خطای سامانه؛ دوباره تلاش کنید.' });
      else res.end();
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  server.on('close', () => db.close());
  return { server, setupToken, configured: Boolean(adminRecord()) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, setupToken, configured } = await makeServer();
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => {
    console.log(`ردیابی افراد: http://${host}:${port}`);
    if (!configured) console.log(`ADMIN SETUP TOKEN (keep private): ${setupToken}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
