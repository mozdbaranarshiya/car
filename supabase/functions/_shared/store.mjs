export function makeStore(projectUrl, serverKey, fetcher = fetch) {
  if (!projectUrl || !serverKey) throw new Error('Missing Supabase server configuration');
  const endpoint = new URL('/rest/v1/rpc/radyabi_store', projectUrl);
  return async (operation, args = {}) => {
    const response = await fetcher(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/json', apikey: serverKey,
        // Legacy service-role keys are JWTs; new sb_secret_ keys use apikey only.
        ...(serverKey.startsWith('sb_secret_') ? {} : { Authorization: 'Bearer ' + serverKey }) },
      body: JSON.stringify({ operation, args })
    });
    if (!response.ok) throw new Error('Supabase database request failed: ' + response.status);
    return response.json();
  };
}
