import { makeStore } from '../_shared/store.mjs';
import { makeHandler } from './handler.mjs';

const serverKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default;
const handler = await makeHandler({
  store: makeStore(Deno.env.get('SUPABASE_URL'), serverKey),
  publicOrigin: Deno.env.get('TRACKER_WEB_ORIGIN'),
  setupToken: Deno.env.get('TRACKER_SETUP_TOKEN'),
  encryptionKey: Deno.env.get('TRACKER_ENCRYPTION_KEY')
});
Deno.serve(handler);
