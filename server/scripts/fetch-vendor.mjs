import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../public/vendor/', import.meta.url);
const files = [
  ['maplibre-gl.js', 'https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js', 'b5a34e6930ff937dbbb9eec8892cffb80ba473cce88ae5ca8c4654432f5f0ebc'],
  ['maplibre-gl.css', 'https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css', '792ac997dcf6ae6f643eb4e2dee4630c85e7056526bd8fb85ffe83c67d6c41b4'],
  ['rtl-text-plugin.js', 'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/dist/mapbox-gl-rtl-text.js', 'd1c69035295613baaf83fe23fd9266b0eaed7e5e472e9632b0b5438afc3f589e']
];
await mkdir(root, { recursive: true });
for (const [name, url, checksum] of files) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Download failed: ${name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error(`Checksum mismatch: ${name}`);
  await writeFile(new URL(name, root), bytes);
  console.log(`Verified: ${name}`);
}
