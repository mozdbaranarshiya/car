import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.95.0';

const SUPABASE_URL = 'https://efibfevyiepkwpnobaro.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_zbEGYX6DGhjFRQf6FWiIWQ_IdYj84nW';
const API_URL = `${SUPABASE_URL}/functions/v1/consent-location`;
const supabase = createClient(SUPABASE_URL, PUBLISHABLE_KEY);

const $ = id => document.getElementById(id);
const authMessage = $('authMessage');
let factorId = null;
let map = null;
let markers = [];
let refreshTimer = null;

function message(text, good = false) {
  authMessage.textContent = text || '';
  authMessage.style.color = good ? '#16844a' : '#9d2636';
}

function setStep(step) {
  $('passwordStep').hidden = step !== 'password';
  $('enrollStep').hidden = step !== 'enroll';
  $('mfaStep').hidden = step !== 'mfa';
}

async function api(action, payload = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': PUBLISHABLE_KEY,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify({ action, ...payload }),
    cache: 'no-store'
  });
  return response.json();
}

async function afterPasswordLogin() {
  const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError) throw aalError;
  if (aal.currentLevel === 'aal2') return openDashboard();

  const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError) throw factorsError;
  const verified = (factors?.totp || []).find(f => f.status === 'verified');
  if (verified) {
    factorId = verified.id;
    setStep('mfa');
    message('رمز عبور تأیید شد. کد Ente Auth را وارد کنید.', true);
    $('mfaCode').focus();
    return;
  }

  const { data: enrollment, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Ente Auth - Location Share' });
  if (enrollError) throw enrollError;
  factorId = enrollment.id;
  $('totpQr').src = enrollment.totp.qr_code;
  $('totpSecret').textContent = enrollment.totp.secret;
  setStep('enroll');
  message('ابتدا عامل دوم را در Ente Auth ثبت کنید.', true);
}

$('loginBtn').addEventListener('click', async () => {
  message('');
  const username = $('username').value.trim();
  const password = $('password').value;
  if (!username || !password) return message('نام کاربری و رمز عبور را وارد کنید.');
  const email = username.includes('@') ? username : `${username}@school.local`;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return message('نام کاربری یا رمز عبور نادرست است.');
  try { await afterPasswordLogin(); } catch (e) { message(e?.message || 'ورود کامل نشد.'); }
});

async function verifyFactor(code) {
  if (!factorId) throw new Error('عامل TOTP پیدا نشد.');
  if (!/^\d{6}$/.test(code)) throw new Error('کد ۶ رقمی را وارد کنید.');
  const { data: challenge, error: cError } = await supabase.auth.mfa.challenge({ factorId });
  if (cError) throw cError;
  const { error: vError } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
  if (vError) throw vError;
  await openDashboard();
}

$('mfaBtn').addEventListener('click', async () => {
  try { await verifyFactor($('mfaCode').value.trim()); } catch (e) { message('کد تأیید نشد: ' + (e?.message || 'خطا')); }
});
$('enrollVerifyBtn').addEventListener('click', async () => {
  try { await verifyFactor($('enrollCode').value.trim()); } catch (e) { message('فعال‌سازی انجام نشد: ' + (e?.message || 'خطا')); }
});

function ensureMap() {
  if (map) return;
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [51.389, 35.6892],
    zoom: 5
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-left');
}

async function openDashboard() {
  const test = await api('admin_list', { query: '' });
  if (!test.ok) {
    if (test.error === 'MANAGER_ONLY') throw new Error('این حساب دسترسی مدیر ندارد.');
    if (test.error === 'MFA_REQUIRED') throw new Error('تأیید دومرحله‌ای کامل نشده است.');
    throw new Error('دسترسی پنل تأیید نشد.');
  }
  $('authCard').hidden = true;
  $('dashboard').hidden = false;
  ensureMap();
  setTimeout(() => map.resize(), 0);
  render(test.people || []);
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => document.hidden || load(), 15000);
}

async function load() {
  const result = await api('admin_list', { query: $('search').value.trim() });
  if (!result.ok) {
    $('count').textContent = 'خطا در دریافت اطلاعات: ' + result.error;
    if (result.error === 'UNAUTHORIZED' || result.error === 'MFA_REQUIRED') location.reload();
    return;
  }
  render(result.people || []);
}

function render(people) {
  ensureMap();
  markers.forEach(marker => marker.remove());
  markers = [];
  const box = $('people');
  box.textContent = '';
  $('count').textContent = `${people.length.toLocaleString('fa-IR')} نفر در حال اشتراک`;
  $('updatedAt').textContent = 'آخرین دریافت پنل: ' + new Date().toLocaleString('fa-IR');

  const bounds = new maplibregl.LngLatBounds();
  for (const person of people) {
    const lat = Number(person.latitude), lon = Number(person.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const seen = person.last_seen_at ? new Date(person.last_seen_at) : null;
    const ageSec = seen ? Math.max(0, (Date.now() - seen.getTime()) / 1000) : Infinity;

    const popupNode = document.createElement('div');
    const popupName = document.createElement('strong');
    popupName.textContent = person.display_name;
    const popupPhone = document.createElement('div');
    popupPhone.textContent = person.phone;
    popupNode.append(popupName, popupPhone);

    const marker = new maplibregl.Marker()
      .setLngLat([lon, lat])
      .setPopup(new maplibregl.Popup({ offset: 20 }).setDOMContent(popupNode))
      .addTo(map);
    markers.push(marker);
    bounds.extend([lon, lat]);

    const card = document.createElement('div');
    card.className = 'person';
    const name = document.createElement('strong');
    name.textContent = person.display_name;
    const phone = document.createElement('div');
    phone.textContent = person.phone;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const freshness = document.createElement('span');
    freshness.className = ageSec <= 60 ? 'live' : 'stale';
    freshness.textContent = ageSec <= 60 ? 'به‌روز' : 'قدیمی‌تر از یک دقیقه';
    meta.append(freshness, document.createTextNode(` | آخرین موقعیت: ${seen ? seen.toLocaleString('fa-IR') : '—'} | دقت: ${person.accuracy_m == null ? '—' : Math.round(person.accuracy_m) + ' متر'}`));
    card.append(name, phone, meta);
    card.addEventListener('click', () => { map.flyTo({ center: [lon, lat], zoom: 15 }); marker.togglePopup(); });
    box.append(card);
  }

  if (people.length && !bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
}

$('refreshBtn').addEventListener('click', load);
let searchDelay;
$('search').addEventListener('input', () => { clearTimeout(searchDelay); searchDelay = setTimeout(load, 350); });
$('logoutBtn').addEventListener('click', async () => { clearInterval(refreshTimer); await supabase.auth.signOut(); location.reload(); });

(async () => {
  const { data } = await supabase.auth.getSession();
  if (data?.session) {
    try { await afterPasswordLogin(); } catch { await supabase.auth.signOut(); setStep('password'); }
  }
})();
