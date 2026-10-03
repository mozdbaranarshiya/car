import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore } from '../functions/_shared/store.mjs';
import { makeHandler } from '../functions/tracker/handler.mjs';
import { buildPages } from '../../server/scripts/build-pages.mjs';

test('server credentials go only to Supabase RPC; failures do not expose the response body', async () => {
  for (const key of ['legacy-server-jwt', 'sb_secret_server-only']) {
    let sent;
    const store = makeStore('https://test.supabase.co', key, async (url, options) => {
      sent = { url: url.href, ...options }; return Response.json(true);
    });
    assert.equal(await store('status'), true);
    assert.equal(sent.url, 'https://test.supabase.co/rest/v1/rpc/radyabi_store');
    assert.equal(sent.headers.apikey, key);
    assert.equal(sent.headers.Authorization, key.startsWith('sb_secret_') ? undefined : 'Bearer ' + key);
    assert.deepEqual(JSON.parse(sent.body), { operation: 'status', args: {} });
    assert.equal(sent.redirect, 'error');
  }
  const fail = makeStore('https://test.supabase.co', 'secret', async () => new Response('private database details', { status: 500 }));
  await assert.rejects(fail('status'), error => !error.message.includes('private database details'));
});
test('Pages rejects configuration containing credentials, insecure transport, or unrelated routes', () => {
  for (const apiBase of ['', 'http://test.supabase.co/functions/v1/tracker',
    'https://user:pass@test.supabase.co/functions/v1/tracker', 'https://test.supabase.co/functions/v1/tracker?secret=1',
    'https://test.supabase.co/rest/v1/devices']) assert.throws(() => buildPages({ apiBase }));
});
test('CORS, bounded input, and infrastructure failures fail closed', async () => {
  const handler = await makeHandler({ store: async () => { throw new Error('Database unavailable'); },
    publicOrigin: 'https://owner.github.io', setupToken: 's'.repeat(40), encryptionKey: 'ab'.repeat(32) });
  const call = (path, options = {}) => handler(new Request('https://project.supabase.co/functions/v1/tracker' + path, options));
  const cors = await call('/api/admin/login', { method: 'OPTIONS', headers: { Origin: 'https://owner.github.io' } });
  assert.equal(cors.status, 204);
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://owner.github.io');
  assert.equal(cors.headers.get('access-control-allow-credentials'), null);
  const blocked = await call('/api/admin/status', { headers: { Origin: 'https://evil.example' } });
  assert.equal(blocked.status, 403); assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  assert.equal((await call('/api/admin/status')).status, 403);
  const offline = await call('/api/admin/status', { headers: { Origin: 'https://owner.github.io' } });
  assert.equal(offline.status, 500); assert.ok(!(await offline.text()).includes('Database unavailable'));
  assert.equal(offline.headers.get('cache-control'), 'no-store');
  const inputHandler = await makeHandler({ store: async operation => operation === 'rate' ? true : null,
    publicOrigin: 'https://owner.github.io', setupToken: 's'.repeat(40), encryptionKey: 'ab'.repeat(32) });
  for (const [body, type, expected] of [['bad json', 'application/json', 400],
    ['[]', 'application/json', 400], ['{}', 'text/plain', 415], ['x'.repeat(17000), 'application/json', 413]]) {
    const response = await inputHandler(new Request('https://project.supabase.co/tracker/api/admin/setup', {
      method: 'POST', headers: { Origin: 'https://owner.github.io', 'Content-Type': type }, body
    }));
    assert.equal(response.status, expected);
  }
});
