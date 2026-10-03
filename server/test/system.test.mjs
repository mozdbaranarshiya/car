import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServer } from '../src.mjs';
import { base32, totp, verifyTotp, phone } from '../auth.mjs';

test('TOTP agrees with RFC 6238 SHA-1 vectors and rejects replay', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  assert.equal(totp(secret, 1), '287082');
  assert.equal(totp(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(verifyTotp(secret, '287082', -1, 59000), 1);
  assert.equal(verifyTotp(secret, '287082', 1, 59000), null);
  assert.equal(verifyTotp(secret, 'broken', -1, 59000), null);
});
test('Iranian phone normalization supports Persian digits and +98', () => {
  assert.equal(phone('۰۹۱۲ ۳۴۵ ۶۷۸۹'), '09123456789');
  assert.equal(phone('+98 9123456789'), '09123456789');
  assert.equal(phone('00989123456789'), '09123456789');
  assert.equal(phone('912'), null);
});
test('authentication, authorization, location ordering, and revocation', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tracker-test-'));
  const { server } = await makeServer({ dataDir, setupToken: 'private-setup-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function call(path, data, { token, admin = false, requestOrigin = origin } = {}) {
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers.Origin = requestOrigin; }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (admin) headers.Cookie = cookie;
    const response = await fetch(origin + path, { method: data ? 'POST' : 'GET', headers, body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, data: await response.json(), response };
  }
  try {
    await t.test('private map cannot be read before authentication', async () => {
      assert.equal((await call('/api/admin/people')).status, 401);
      assert.equal((await call('/api/admin/status')).data.configured, false);
    });
    let secret, setupChallenge;
    await t.test('setup needs private token and correct browser origin', async () => {
      const input = { setupToken: 'bad', username: 'manager', password: 'a-long-private-password' };
      assert.equal((await call('/api/admin/setup', input)).status, 403);
      input.setupToken = 'private-setup-token';
      assert.equal((await call('/api/admin/setup', input, { requestOrigin: 'https://evil.example' })).status, 403);
      const setup = await call('/api/admin/setup', input);
      assert.equal(setup.status, 200); secret = setup.data.secret; setupChallenge = setup.data.challenge;
      assert.equal((await call('/api/admin/setup/confirm', { challenge: setupChallenge, code: totp(secret) })).status, 200);
      assert.equal((await call('/api/admin/status')).data.configured, true);
      assert.equal((await call('/api/admin/setup', input)).status, 409);
    });
    await t.test('password alone never creates a session; OTP replay is rejected', async () => {
      assert.equal((await call('/api/admin/login', { username: 'manager', password: 'wrong' })).status, 401);
      const login = await call('/api/admin/login', { username: 'manager', password: 'a-long-private-password' });
      assert.equal(login.status, 200);
      assert.equal(login.response.headers.get('set-cookie'), null);
      assert.equal((await call('/api/admin/people')).status, 401);
      const nextCode = totp(secret, Math.floor(Date.now()/30000) + 1);
      const verify = await call('/api/admin/verify', { challenge: login.data.challenge, code: nextCode });
      assert.equal(verify.status, 200); cookie = verify.response.headers.get('set-cookie').split(';')[0];
      assert.match(verify.response.headers.get('set-cookie'), /HttpOnly.*SameSite=Strict/);
      assert.equal((await call('/api/admin/verify', { challenge: login.data.challenge, code: nextCode })).status, 401);
      const another = await call('/api/admin/login', { username: 'manager', password: 'a-long-private-password' });
      assert.equal((await call('/api/admin/verify', { challenge: another.data.challenge, code: nextCode })).status, 401);
    });
    let alice, bob;
    await t.test('registration requires affirmative consent and uses device credentials', async () => {
      const input = { name: 'علی رضایی', phone: '09123456789', disclosureVersion: 1 };
      assert.equal((await call('/api/device/register', { ...input, consent: false })).status, 403);
      alice = (await call('/api/device/register', { ...input, consent: true })).data;
      bob = (await call('/api/device/register', { ...input, name: 'مریم احمدی', consent: true })).data;
      assert.notEqual(alice.token, bob.token);
      assert.notEqual(alice.id, bob.id);
      assert.equal((await call('/api/device/me')).status, 401);
      assert.equal((await call('/api/device/me', null, { token: bob.token })).data.id, bob.id);
    });
    const sample = { latitude: 35.6892, longitude: 51.3890, accuracy: 12, capturedAt: Date.now(), battery: 80 };
    await t.test('valid samples are visible to the device and authenticated admin only', async () => {
      assert.equal((await call('/api/device/location', sample, { token: alice.token })).status, 200);
      assert.equal((await call('/api/device/location', { ...sample, latitude: 100 }, { token: alice.token })).status, 400);
      assert.equal((await call('/api/device/location', { ...sample, capturedAt: Date.now()+100000 }, { token: alice.token })).status, 400);
      assert.equal((await call('/api/device/me', null, { token: bob.token })).data.latitude, null);
      const own = (await call('/api/device/me', null, { token: alice.token })).data;
      assert.equal(own.latitude, sample.latitude);
      assert.equal(own.token, undefined);
      const admin = await call('/api/admin/people?phone=%2B989123456789', null, { admin: true });
      assert.equal(admin.status, 200); assert.equal(admin.data.people.length, 2);
      assert.equal(admin.data.people[0].token_hash, undefined);
    });
    await t.test('late offline samples cannot replace a newer fix', async () => {
      const response = await call('/api/device/location', { ...sample, latitude: 32, capturedAt: sample.capturedAt-1000 }, { token: alice.token });
      assert.equal(response.data.ignored, true);
      assert.equal((await call('/api/device/me', null, { token: alice.token })).data.latitude, sample.latitude);
    });
    await t.test('revocation clears manager-visible location and prevents further uploads', async () => {
      assert.equal((await call('/api/device/consent', { consent: false }, { token: alice.token })).status, 200);
      assert.equal((await call('/api/device/me', null, { token: alice.token })).data.latitude, null);
      assert.equal((await call('/api/device/location', sample, { token: alice.token })).status, 403);
      assert.equal((await call('/api/device/consent', { consent: true }, { token: alice.token })).status, 403);
      assert.equal((await call('/api/device/consent', { consent: true, disclosureVersion: 1 }, { token: alice.token })).status, 200);
      assert.equal((await call('/api/device/location', sample, { token: alice.token })).status, 200);
    });
    await t.test('logout invalidates server session and cross-origin logout is blocked', async () => {
      assert.equal((await call('/api/admin/logout', {}, { admin: true, requestOrigin: 'https://evil.example' })).status, 403);
      assert.equal((await call('/api/admin/logout', {}, { admin: true })).status, 200);
      assert.equal((await call('/api/admin/people', null, { admin: true })).status, 401);
    });
  } finally {
    await new Promise(resolve => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true });
  }
});
