import { cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function buildPages({ apiBase = process.env.TRACKER_API_BASE, output = resolve(root, 'dist-pages'), development = false } = {}) {
  if (!apiBase) throw new Error('Set TRACKER_API_BASE to the public Supabase tracker function URL');
  const endpoint = new URL(apiBase);
  if ((!development && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !/^\/functions\/v1\/tracker\/?$/.test(endpoint.pathname)) throw new Error('Invalid Supabase tracker URL');
  apiBase = endpoint.href.replace(/\/$/, '');
  rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
  const assets = ['index.html', 'app.js', 'app.css', 'favicon.svg', 'vendor'];
  for (const asset of assets) cpSync(resolve(root, 'server/public', asset), resolve(output, asset), { recursive: true });
  writeFileSync(resolve(output, 'config.js'), "'use strict';\nwindow.TRACKER_CONFIG = Object.freeze(" + JSON.stringify({ apiBase }) + ');\n');
  // Pages cannot set response headers, so its HTML applies the available CSP
  // directives in a meta element. The API supplies CORS and no-store headers.
  const policy = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tiles.openfreemap.org; font-src 'self' https://tiles.openfreemap.org; connect-src 'self' ${endpoint.origin} https://tiles.openfreemap.org; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'`;
  const html = readFileSync(resolve(output, 'index.html'), 'utf8').replace('<title>',
    `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">\n  <title>`);
  writeFileSync(resolve(output, 'index.html'), html);
  writeFileSync(resolve(output, '.nojekyll'), '');
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log('Pages assets prepared:', buildPages());
