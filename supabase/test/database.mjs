import pg from 'pg';

export function testDatabase() {
  const connectionString = process.env.TRACKER_QA_DATABASE_URL;
  if (!connectionString || !['localhost', '127.0.0.1'].includes(new URL(connectionString).hostname))
    throw new Error('Tests require an isolated localhost TRACKER_QA_DATABASE_URL');
  const pool = new pg.Pool({ connectionString });
  const store = async (operation, args = {}) => {
    const { rows } = await pool.query('select public.radyabi_store($1, $2::jsonb) as value', [operation, JSON.stringify(args)]);
    return rows[0].value;
  };
  const reset = () => pool.query(`truncate radyabi_private.admin, radyabi_private.setup_pending,
    radyabi_private.challenges, radyabi_private.sessions, radyabi_private.limits, radyabi_private.devices`);
  return { pool, store, reset };
}
