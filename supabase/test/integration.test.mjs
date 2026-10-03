import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './database.mjs';
import { makeHandler } from '../functions/tracker/handler.mjs';
import { totp, digest } from '../functions/_shared/auth.mjs';

test('Supabase API and PostgreSQL enforce privacy, consent, and two-factor sessions', async t => {
  const { pool, store, reset } = testDatabase(); await reset();
  const options = { store, publicOrigin: 'https://mozdbaranarshiya.github.io',
    setupToken: 'private-test-setup-token-1234567890123456', encryptionKey: 'ab'.repeat(32) };
  const handler = await makeHandler(options);
  let adminToken = '', secret, alice, bob, challenge;
  const call = async (path, data, { token, origin = options.publicOrigin, handle = handler, forwarded } = {}) => {
    const headers = { ...(origin ? { Origin: origin } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(forwarded ? { 'X-Forwarded-For': forwarded } : {}) };
    const response = await handle(new Request('https://qa.supabase.co/functions/v1/tracker' + path,
      { method: data ? 'POST' : 'GET', headers, body: data ? JSON.stringify(data) : undefined }));
    return { status: response.status, data: await response.json(), response };
  };
  try {
    await t.test('anonymous and authenticated database roles have no access to private data or RPC', async () => {
      const { rows } = await pool.query(`select
        has_schema_privilege('anon', 'radyabi_private', 'USAGE') as anon_schema,
        has_function_privilege('anon', 'public.radyabi_store(text,jsonb)', 'EXECUTE') as anon_rpc,
        has_function_privilege('authenticated', 'public.radyabi_store(text,jsonb)', 'EXECUTE') as user_rpc,
        has_function_privilege('service_role', 'public.radyabi_store(text,jsonb)', 'EXECUTE') as server_rpc`);
      assert.deepEqual(rows[0], { anon_schema: false, anon_rpc: false, user_rpc: false, server_rpc: true });
      const tables = await pool.query(`select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='radyabi_private' and c.relkind='r'`);
      assert.equal(tables.rows.length, 6); assert.ok(tables.rows.every(row => row.relrowsecurity));
      const client = await pool.connect();
      try {
        await client.query('set role anon');
        await assert.rejects(client.query("select public.radyabi_store('status')"), { code: '42501' });
      } finally { await client.query('reset role'); client.release(); }
      assert.equal((await call('/api/admin/people')).status, 401);
      assert.equal((await call('/api/device/register', { name: 'علی', phone: '09123456789', consent: true, disclosureVersion: 1 })).status, 503);
    });
    await t.test('setup is private, persistent across cold starts, and closes after Ente confirmation', async () => {
      const input = { username: 'manager', password: 'a-long-private-password', setupToken: options.setupToken };
      assert.equal((await call('/api/admin/setup', { ...input, setupToken: 'wrong' })).status, 403);
      assert.equal((await call('/api/admin/setup', input, { origin: 'https://evil.example' })).status, 403);
      const setup = await call('/api/admin/setup', input); assert.equal(setup.status, 200); secret = setup.data.secret;
      const coldHandler = await makeHandler(options);
      assert.equal((await call('/api/admin/setup/confirm', { challenge: setup.data.challenge, code: totp(secret) }, { handle: coldHandler })).status, 200);
      assert.equal((await call('/api/admin/status')).data.configured, true);
      assert.equal((await call('/api/admin/setup', input)).status, 409);
      const { rows } = await pool.query('select password, totp from radyabi_private.admin');
      assert.notEqual(rows[0].password, input.password); assert.notEqual(rows[0].totp, secret);
    });
    await t.test('password alone and device tokens cannot open the manager map', async () => {
      assert.equal((await call('/api/admin/login', { username: 'manager', password: 'wrong' })).status, 401);
      const login = await call('/api/admin/login', { username: 'manager', password: 'a-long-private-password' });
      challenge = login.data.challenge; assert.equal(login.status, 200); assert.equal(login.data.token, undefined);
      assert.equal((await call('/api/admin/people', null, { token: challenge })).status, 401);
      assert.equal((await call('/api/admin/verify', { challenge, code: totp(secret) })).status, 401);
    });
    await t.test('concurrent OTP verification creates one session and blocks replay across challenges', async () => {
      const second = await call('/api/admin/login', { username: 'manager', password: 'a-long-private-password' });
      const code = totp(secret, Math.floor(Date.now() / 30000) + 1);
      const result = await Promise.all([
        call('/api/admin/verify', { challenge, code }),
        call('/api/admin/verify', { challenge: second.data.challenge, code })
      ]);
      assert.deepEqual(result.map(value => value.status).sort(), [200, 401]);
      adminToken = result.find(value => value.status === 200).data.token;
      const successfulChallenge = result[0].status === 200 ? challenge : second.data.challenge;
      assert.equal((await call('/api/admin/verify', { challenge: successfulChallenge, code })).status, 401);
      const { rows } = await pool.query('select hash from radyabi_private.sessions');
      assert.equal(rows.length, 1); assert.equal(rows[0].hash, digest(adminToken));
    });
    await t.test('unverified phone numbers are labels; every install needs explicit consent and gets independent credentials', async () => {
      const input = { name: 'علی رضایی', phone: '+98 9123456789', disclosureVersion: 1 };
      assert.equal((await call('/api/device/register', { ...input, consent: false }, { origin: null })).status, 403);
      alice = (await call('/api/device/register', { ...input, consent: true }, { origin: null })).data;
      bob = (await call('/api/device/register', { ...input, name: 'مریم احمدی', consent: true }, { origin: null })).data;
      assert.notEqual(alice.token, bob.token); assert.notEqual(alice.id, bob.id);
      assert.equal(alice.phone, '09123456789');
      assert.equal((await call('/api/admin/people', null, { token: alice.token })).status, 401);
      assert.equal((await call('/api/device/me', null, { token: adminToken, origin: null })).status, 401);
    });
    const sample = { latitude: 35.6892, longitude: 51.389, accuracy: 8, capturedAt: Date.now(), battery: 70 };
    await t.test('location validates coordinates and binds authorization to the requesting device', async () => {
      assert.equal((await call('/api/device/location', { ...sample, hash: digest(bob.token) }, { token: alice.token, origin: null })).status, 200);
      assert.equal((await call('/api/device/me', null, { token: bob.token, origin: null })).data.latitude, null);
      assert.equal((await call('/api/device/me', null, { token: alice.token, origin: null })).data.latitude, sample.latitude);
      assert.equal((await call('/api/device/location', { ...sample, latitude: 100 }, { token: alice.token, origin: null })).status, 400);
      assert.equal((await call('/api/device/location', { ...sample, capturedAt: Date.now() + 100000 }, { token: alice.token, origin: null })).status, 400);
      const admin = await call('/api/admin/people?phone=۰۹۱۲۳۴۵۶۷۸۹', null, { token: adminToken });
      assert.equal(admin.status, 200); assert.equal(admin.data.people.length, 2);
      assert.equal(admin.data.people[0].token_hash, undefined);
    });
    await t.test('offline stale samples never replace a newer GPS fix', async () => {
      const old = await call('/api/device/location', { ...sample, latitude: 32, capturedAt: sample.capturedAt - 1000 }, { token: alice.token, origin: null });
      assert.equal(old.data.ignored, true);
      assert.equal((await call('/api/device/me', null, { token: alice.token, origin: null })).data.latitude, sample.latitude);
    });
    await t.test('revocation wins against concurrent uploads and requires renewed consent before resuming', async () => {
      await Promise.all([
        call('/api/device/location', { ...sample, capturedAt: Date.now() }, { token: alice.token, origin: null }),
        call('/api/device/consent', { consent: false }, { token: alice.token, origin: null })
      ]);
      const own = (await call('/api/device/me', null, { token: alice.token, origin: null })).data;
      assert.equal(own.consent, false); assert.equal(own.latitude, null); assert.equal(own.battery, null);
      assert.equal((await call('/api/device/location', sample, { token: alice.token, origin: null })).status, 403);
      assert.equal((await call('/api/device/consent', { consent: true }, { token: alice.token, origin: null })).status, 403);
      assert.equal((await call('/api/device/consent', { consent: true, disclosureVersion: 1 }, { token: alice.token, origin: null })).status, 200);
    });
    await t.test('expired and logged-out sessions cannot read location', async () => {
      const expiredHash = 'a'.repeat(64);
      await pool.query('insert into radyabi_private.sessions values($1,1)', [expiredHash]);
      assert.equal(await store('session', { hash: expiredHash }), false);
      assert.equal((await call('/api/admin/logout', {}, { token: adminToken, origin: 'https://evil.example' })).status, 403);
      assert.equal((await call('/api/admin/logout', {}, { token: adminToken })).status, 200);
      assert.equal((await call('/api/admin/people', null, { token: adminToken })).status, 401);
    });
    await t.test('persistent login limits survive new Edge Function instances and reject forged IP headers', async () => {
      await pool.query("delete from radyabi_private.limits where category='login'");
      const cold = await makeHandler(options);
      for (let i = 0; i < 8; i++) assert.equal((await call('/api/admin/login', { username: 'manager', password: 'wrong' }, { handle: i % 2 ? cold : handler, forwarded: '192.0.2.' + i })).status, 401);
      assert.equal((await call('/api/admin/login', { username: 'manager', password: 'wrong' }, { handle: cold })).status, 429);
    });
  } finally { await reset(); await pool.end(); }
});
