import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

function key(modern: string, legacy: string) {
  const raw = Deno.env.get(modern);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.default) return String(parsed.default);
      const first = Object.values(parsed || {})[0];
      if (first) return String(first);
    } catch {}
  }
  const fallback = Deno.env.get(legacy);
  if (!fallback) throw new Error("SERVER_CONFIG");
  return fallback;
}

function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validPhone(value: string) {
  return /^\+?[0-9 ()-]{5,30}$/.test(value);
}

function validCoordinate(lat: number, lon: number) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function duration(mode: string) {
  if (mode === "2h") return { mode, hours: 2 };
  if (mode === "5h") return { mode, hours: 5 };
  if (mode === "10h") return { mode, hours: 10 };
  if (mode === "manual") return { mode, hours: null };
  throw new Error("INVALID_DURATION");
}

async function requireManager(req: Request, url: string, publishableKey: string, admin: any) {
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) throw new Error("UNAUTHORIZED");

  const caller = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });

  const { data: userData, error: userError } = await caller.auth.getUser(bearer);
  if (userError || !userData?.user) throw new Error("UNAUTHORIZED");

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("role,active,must_change_password")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile?.active || profile.role !== "manager" || profile.must_change_password) {
    throw new Error("MANAGER_ONLY");
  }

  const { data: aal, error: aalError } = await caller.auth.mfa.getAuthenticatorAssuranceLevel(bearer);
  if (aalError || aal?.currentLevel !== "aal2") throw new Error("MFA_REQUIRED");

  return userData.user;
}

async function expireOld(admin: any) {
  const now = new Date().toISOString();
  await admin
    .from("consent_location_sessions")
    .update({
      sharing_active: false,
      stopped_at: now,
      latitude: null,
      longitude: null,
      accuracy_m: null,
    })
    .eq("sharing_active", true)
    .not("expires_at", "is", null)
    .lt("expires_at", now);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    if (!url) throw new Error("SERVER_CONFIG");

    const secretKey = key("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
    const publishableKey = key("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
    const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const body = await req.json();
    const action = String(body?.action || "");

    if (action === "health") {
      return json({
        ok: true,
        service: "consent-location",
        mode: "current-location-only",
        durations: ["2h", "5h", "10h", "manual"]
      });
    }

    if (action === "start") {
      await expireOld(admin);

      const displayName = String(body.display_name || "").trim();
      const phone = String(body.phone || "").trim();
      const selected = duration(String(body.duration_mode || ""));

      if (displayName.length < 2 || displayName.length > 120 || !validPhone(phone)) {
        throw new Error("INVALID_PROFILE");
      }

      const { count } = await admin
        .from("consent_location_sessions")
        .select("id", { count: "exact", head: true })
        .eq("phone", phone)
        .eq("sharing_active", true);

      if ((count || 0) >= 3) throw new Error("TOO_MANY_ACTIVE_SESSIONS");

      const deviceToken = token();
      const deviceTokenHash = await sha256(deviceToken);
      const expiresAt = selected.hours === null
        ? null
        : new Date(Date.now() + selected.hours * 60 * 60 * 1000).toISOString();

      const { data, error } = await admin
        .from("consent_location_sessions")
        .insert({
          display_name: displayName,
          phone,
          device_token_hash: deviceTokenHash,
          sharing_active: true,
          consented_at: new Date().toISOString(),
          expires_at: expiresAt,
          duration_mode: selected.mode,
        })
        .select("id,expires_at,duration_mode")
        .single();

      if (error) throw new Error("START_FAILED");
      return json({
        ok: true,
        session_id: data.id,
        device_token: deviceToken,
        expires_at: data.expires_at,
        duration_mode: data.duration_mode
      });
    }

    if (action === "update") {
      const deviceToken = String(body.device_token || "");
      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);
      const accuracy = Number(body.accuracy_m);

      if (deviceToken.length < 20 || !validCoordinate(latitude, longitude)) throw new Error("INVALID_UPDATE");

      const deviceTokenHash = await sha256(deviceToken);
      const now = new Date().toISOString();

      const { data, error } = await admin
        .from("consent_location_sessions")
        .update({
          latitude,
          longitude,
          accuracy_m: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
          last_seen_at: now,
        })
        .eq("device_token_hash", deviceTokenHash)
        .eq("sharing_active", true)
        .select("id,expires_at,duration_mode")
        .maybeSingle();

      if (error) throw new Error("UPDATE_FAILED");
      if (!data) throw new Error("SESSION_INACTIVE");

      if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
        await admin
          .from("consent_location_sessions")
          .update({
            sharing_active: false,
            stopped_at: now,
            latitude: null,
            longitude: null,
            accuracy_m: null,
          })
          .eq("id", data.id);
        throw new Error("SESSION_INACTIVE");
      }

      return json({ ok: true, expires_at: data.expires_at, duration_mode: data.duration_mode });
    }

    if (action === "stop") {
      const deviceToken = String(body.device_token || "");
      if (deviceToken.length < 20) throw new Error("INVALID_TOKEN");
      const hash = await sha256(deviceToken);
      const now = new Date().toISOString();

      const { error } = await admin
        .from("consent_location_sessions")
        .update({
          sharing_active: false,
          stopped_at: now,
          latitude: null,
          longitude: null,
          accuracy_m: null,
        })
        .eq("device_token_hash", hash);

      if (error) throw new Error("STOP_FAILED");
      return json({ ok: true });
    }

    if (action === "admin_list") {
      await requireManager(req, url, publishableKey, admin);
      await expireOld(admin);

      const queryText = String(body.query || "").trim().slice(0, 50);
      let query = admin
        .from("consent_location_sessions")
        .select("id,display_name,phone,latitude,longitude,accuracy_m,last_seen_at,consented_at,expires_at,duration_mode")
        .eq("sharing_active", true)
        .not("latitude", "is", null)
        .not("longitude", "is", null)
        .order("last_seen_at", { ascending: false })
        .limit(200);

      if (queryText) query = query.ilike("phone", `%${queryText.replace(/[%_]/g, "")}%`);

      const { data, error } = await query;
      if (error) throw new Error("LIST_FAILED");
      return json({ ok: true, people: data || [] });
    }

    throw new Error("UNKNOWN_ACTION");
  } catch (error) {
    const code = error instanceof Error ? error.message : "SERVER_ERROR";
    const known = new Set([
      "SERVER_CONFIG","UNAUTHORIZED","MANAGER_ONLY","MFA_REQUIRED","INVALID_PROFILE","INVALID_DURATION",
      "TOO_MANY_ACTIVE_SESSIONS","START_FAILED","INVALID_UPDATE","UPDATE_FAILED",
      "SESSION_INACTIVE","INVALID_TOKEN","STOP_FAILED","LIST_FAILED","UNKNOWN_ACTION"
    ]);
    return json({ ok: false, error: known.has(code) ? code : "SERVER_ERROR" }, 200);
  }
});