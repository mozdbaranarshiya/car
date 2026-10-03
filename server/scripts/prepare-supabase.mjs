import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = resolve(dirname(fileURLToPath(import.meta.url)), '../../supabase/functions/.env');
const origin = process.env.TRACKER_WEB_ORIGIN || 'https://mozdbaranarshiya.github.io';
if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('TRACKER_WEB_ORIGIN must be an HTTPS origin');
if (existsSync(target)) {
  console.log('Existing private configuration preserved:', target);
} else {
  const content = `TRACKER_WEB_ORIGIN=${origin}\nTRACKER_SETUP_TOKEN=${randomBytes(32).toString('base64url')}\nTRACKER_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`;
  writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
  console.log('Private Supabase configuration created:', target);
}
