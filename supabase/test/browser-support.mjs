import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testDatabase } from './database.mjs';
import { makeHandler } from '../functions/tracker/handler.mjs';
import { buildPages } from '../../server/scripts/build-pages.mjs';

export async function makeSupabaseBrowserFixture() {
  const { pool, store, reset } = testDatabase(); await reset();
  const output = mkdtempSync(join(tmpdir(), 'tracker-pages-browser-'));
  let handler;
  const backend = createServer(async (req, res) => {
    try {
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method, headers: req.headers,
        ...(req.method === 'GET' || req.method === 'OPTIONS' ? {} : { body: Readable.toWeb(req), duplex: 'half' })
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { console.error(error); res.writeHead(500); res.end(); }
  });
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const web = createServer((req, res) => {
    const path = new URL(req.url, 'http://local').pathname;
    const allowed = new Set(['/car/', '/car/app.js', '/car/config.js', '/car/app.css', '/car/favicon.svg',
      '/car/vendor/maplibre-gl.js', '/car/vendor/maplibre-gl.css', '/car/vendor/rtl-text-plugin.js']);
    if (!allowed.has(path)) { res.writeHead(404); return res.end(); }
    const name = path === '/car/' ? 'index.html' : path.slice('/car/'.length);
    const extension = name.slice(name.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': contentTypes[extension], 'Cache-Control': 'no-store' });
    res.end(readFileSync(resolve(output, name)));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const webOrigin = `http://127.0.0.1:${web.address().port}`;
  const apiOrigin = `http://127.0.0.1:${backend.address().port}/functions/v1/tracker`;
  const setupToken = 'browser-test-only-supabase-1234567890';
  handler = await makeHandler({ store, publicOrigin: webOrigin, setupToken, encryptionKey: randomBytes(32).toString('hex'), development: true });
  buildPages({ apiBase: apiOrigin, output, development: true });
  return { origin: webOrigin + '/car/', apiOrigin, setupToken, dispose: async () => {
    await Promise.all([new Promise(resolve => backend.close(resolve)), new Promise(resolve => web.close(resolve))]);
    await reset(); await pool.end(); rmSync(output, { recursive: true, force: true });
  } };
}
