import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { randomToken, digest, equal, hashPassword, verifyPassword, base32, verifyTotp,
  encrypt, decrypt, digits, phone } from '../_shared/auth.mjs';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message, status = 400) => { throw new HttpError(status, message); };

export async function makeHandler({ store, publicOrigin, setupToken, encryptionKey, development = false }) {
  if (!publicOrigin || new URL(publicOrigin).origin !== publicOrigin ||
      (!development && !publicOrigin.startsWith('https://'))) throw new Error('TRACKER_WEB_ORIGIN must be an HTTPS origin');
  if (!setupToken || setupToken.length < 32) throw new Error('TRACKER_SETUP_TOKEN must have at least 32 characters');
  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey || '')) throw new Error('TRACKER_ENCRYPTION_KEY must contain 64 hex digits');
  const key = Buffer.from(encryptionKey, 'hex');
  const dummyHash = await hashPassword(randomToken());

  async function body(req) {
    if (!(req.headers.get('content-type') || '').startsWith('application/json')) bad('قالب درخواست نامعتبر است.', 415);
    if (Number(req.headers.get('content-length')) > 16384) bad('درخواست بیش از حد بزرگ است.', 413);
    const reader = req.body?.getReader();
    if (!reader) bad('درخواست نامعتبر است.');
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 16384) { await reader.cancel(); bad('درخواست بیش از حد بزرگ است.', 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || Array.isArray(value) || typeof value !== 'object') bad('درخواست نامعتبر است.');
      return value;
    } catch (error) { if (error instanceof HttpError) throw error; bad('درخواست نامعتبر است.'); }
    finally { reader.releaseLock(); }
  }
  const tokenHash = req => {
    const auth = req.headers.get('authorization') || '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) bad('دسترسی مجاز نیست.', 401);
    return digest(auth.slice(7));
  };
  async function rate(category, maximum, interval) {
    // Stored in Postgres, shared across all Edge Function instances. Login/setup
    // limits are global for the single manager; no client IP header is trusted.
    if (!await store('rate', { category, maximum, interval })) bad('تعداد تلاش‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.', 429);
  }
  async function device(req) {
    const hash = tokenHash(req), value = await store('device', { hash });
    if (!value) bad('دسترسی مجاز نیست.', 401);
    return { hash, value };
  }
  async function session(req) {
    const hash = tokenHash(req);
    if (!await store('session', { hash })) bad('لطفاً وارد شوید.', 401);
    return hash;
  }
  function credentials(input) {
    const username = String(input.username || '').trim(), password = String(input.password || '');
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) bad('نام کاربری باید ۳ تا ۶۴ حرف یا عدد انگلیسی باشد.');
    if (password.length < 12 || password.length > 256) bad('رمز عبور باید بین ۱۲ تا ۲۵۶ نویسه باشد.');
    return { username, password };
  }
  return async req => {
    const origin = req.headers.get('origin');
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
    if (origin === publicOrigin) Object.assign(headers, {
      'Access-Control-Allow-Origin': publicOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Max-Age': '600'
    });
    const json = (status, value) => new Response(JSON.stringify(value), { status, headers });
    try {
      if (origin && origin !== publicOrigin) bad('مبدأ درخواست مجاز نیست.', 403);
      if (req.method === 'OPTIONS') {
        if (origin !== publicOrigin) bad('مبدأ درخواست مجاز نیست.', 403);
        return new Response(null, { status: 204, headers });
      }
      const url = new URL(req.url);
      // The hosted gateway and local Deno router include the function prefix.
      const path = url.pathname.replace(/^\/(?:functions\/v1\/)?tracker(?=\/)/, '');
      if (path.startsWith('/api/admin/') && origin !== publicOrigin) bad('مبدأ درخواست مجاز نیست.', 403);
      if (req.method === 'GET' && path === '/api/health') return json(200, { ok: true });
      if (req.method === 'GET' && path === '/api/admin/status') return json(200, { configured: await store('status') });
      if (req.method === 'POST' && path === '/api/admin/setup') {
        await rate('setup', 8, 15 * 60 * 1000);
        if (await store('status')) bad('مدیر قبلاً تعریف شده است.', 409);
        const b = await body(req);
        if (!equal(b.setupToken || '', setupToken)) bad('کلید راه‌اندازی نادرست است.', 403);
        const { username, password } = credentials(b);
        const secret = base32(randomBytes(20)), challenge = randomToken();
        if (!await store('setup-start', { username, password: await hashPassword(password),
          secret: encrypt(secret, key), hash: digest(challenge) })) bad('مدیر قبلاً تعریف شده است.', 409);
        return json(200, { challenge, secret,
          otpauth: `otpauth://totp/${encodeURIComponent('Radyabi:' + username)}?secret=${secret}&issuer=Radyabi&algorithm=SHA1&digits=6&period=30` });
      }
      if (req.method === 'POST' && path === '/api/admin/setup/confirm') {
        await rate('setup-otp', 10, 15 * 60 * 1000);
        const b = await body(req), hash = digest(b.challenge || '');
        const pending = await store('setup-pending', { hash });
        if (!pending) bad('راه‌اندازی منقضی شده است؛ دوباره شروع کنید.', 401);
        const step = verifyTotp(decrypt(pending.secret, key), digits(b.code));
        if (step === null) bad('کد Ente Auth نادرست است.', 401);
        if (!await store('setup-confirm', { hash, step })) bad('راه‌اندازی منقضی شده است؛ دوباره شروع کنید.', 401);
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/admin/login') {
        await rate('login', 8, 15 * 60 * 1000);
        const b = await body(req), admin = await store('admin'), password = String(b.password || '');
        if (password.length > 256) bad('نام کاربری یا رمز عبور نادرست است.', 401);
        const valid = await verifyPassword(password, admin?.password || dummyHash);
        if (!admin || !valid || !equal(String(b.username || ''), admin.username)) bad('نام کاربری یا رمز عبور نادرست است.', 401);
        const challenge = randomToken();
        if (!await store('challenge-create', { hash: digest(challenge) })) bad('لطفاً کمی بعد تلاش کنید.', 429);
        return json(200, { challenge });
      }
      if (req.method === 'POST' && path === '/api/admin/verify') {
        await rate('login-otp', 20, 15 * 60 * 1000);
        const b = await body(req), hash = digest(b.challenge || '');
        if (!await store('challenge-attempt', { hash })) bad('ورود منقضی شده است؛ دوباره وارد شوید.', 401);
        const admin = await store('admin');
        if (!admin) bad('ورود منقضی شده است؛ دوباره وارد شوید.', 401);
        const step = verifyTotp(decrypt(admin.totp, key), digits(b.code), admin.last_step);
        if (step === null) bad('کد نادرست یا قبلاً استفاده شده است.', 401);
        const token = randomToken();
        // The RPC locks the manager and challenge together. Concurrent requests
        // cannot consume one challenge or one TOTP step more than once.
        if (!await store('verify', { hash, step, sessionHash: digest(token) })) bad('کد نادرست یا قبلاً استفاده شده است.', 401);
        return json(200, { ok: true, token });
      }
      if (req.method === 'POST' && path === '/api/admin/logout') {
        await store('logout', { hash: await session(req) }); return json(200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/admin/people') {
        const hash = await session(req), query = String(url.searchParams.get('phone') || '').slice(0, 30);
        const mobile = query ? phone(query) : null;
        if (query && !mobile) return json(200, { people: [] });
        const result = await store('people', { hash, phone: mobile });
        if (result === null) bad('لطفاً وارد شوید.', 401);
        return json(200, { people: result });
      }
      if (req.method === 'POST' && path === '/api/device/register') {
        await rate('register', 20, 60 * 60 * 1000);
        if (!await store('status')) bad('سامانه هنوز راه‌اندازی نشده است.', 503);
        const b = await body(req), name = String(b.name || '').trim(), mobile = phone(b.phone);
        if (name.length < 2 || name.length > 80 || /[\u0000-\u001f]/.test(name)) bad('نام معتبر وارد کنید.');
        if (!mobile) bad('شماره موبایل معتبر وارد کنید.');
        if (b.consent !== true || b.disclosureVersion !== 1) bad('رضایت به ارسال موقعیت الزامی است.', 403);
        const id = randomToken(), token = randomToken();
        await store('register', { id, hash: digest(token), name, phone: mobile });
        return json(201, { id, token, name, phone: mobile });
      }
      if (req.method === 'GET' && path === '/api/device/me') return json(200, (await device(req)).value);
      if (req.method === 'POST' && path === '/api/device/consent') {
        const { hash } = await device(req), b = await body(req);
        if (typeof b.consent !== 'boolean') bad('مقدار رضایت نامعتبر است.');
        if (b.consent && b.disclosureVersion !== 1) bad('رضایت باید دوباره تأیید شود.', 403);
        if (!await store('consent', { hash, consent: b.consent })) bad('دسترسی مجاز نیست.', 401);
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/device/location') {
        const { hash, value: d } = await device(req);
        await rate('location:' + d.id, 20, 60 * 1000);
        const b = await body(req), now = Date.now();
        if (!Number.isFinite(b.latitude) || b.latitude < -90 || b.latitude > 90 ||
            !Number.isFinite(b.longitude) || b.longitude < -180 || b.longitude > 180 ||
            !Number.isFinite(b.accuracy) || b.accuracy < 0 || b.accuracy > 50000 ||
            !Number.isSafeInteger(b.capturedAt) || b.capturedAt > now + 60000 || b.capturedAt < now - 48 * 60 * 60 * 1000) bad('اطلاعات موقعیت نامعتبر است.');
        const battery = Number.isInteger(b.battery) && b.battery >= 0 && b.battery <= 100 ? b.battery : null;
        const result = await store('location', { hash, latitude: b.latitude, longitude: b.longitude,
          accuracy: b.accuracy, capturedAt: b.capturedAt, battery });
        if (result === 'unauthorized') bad('دسترسی مجاز نیست.', 401);
        if (result === 'revoked') bad('ارسال موقعیت متوقف شده است.', 403);
        return json(200, { ok: true, ...(result === 'ignored' ? { ignored: true } : {}) });
      }
      throw new HttpError(404, 'مسیر یافت نشد.');
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Tracker request failed:', error.message);
      return json(error.status || 500, { error: error.status ? error.message : 'خطای سامانه؛ دوباره تلاش کنید.' });
    }
  };
}
