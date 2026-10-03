const { chromium } = require(process.env.QA_PLAYWRIGHT_PACKAGE || 'playwright');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const { makeServer } = await import('../src.mjs');
  const { totp } = await import('../auth.mjs');
  const dataDir = mkdtempSync(join(tmpdir(), 'tracker-browser-'));
  const { server } = await makeServer({ dataDir, setupToken: 'browser-test-only' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync('qa-artifacts', { recursive: true });
  async function post(path, payload, token) {
    const response = await fetch(origin + path, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {})
    }, body: JSON.stringify(payload) });
    assert.ok(response.ok, 'Device fixture request failed'); return response.json();
  }
  try {
    await page.goto(origin);
    await page.locator('#setup-form').waitFor({ state: 'visible' });
    await page.fill('#setup-token', 'browser-test-only');
    await page.fill('#new-username', 'browseradmin');
    await page.fill('#new-password', 'browser-test-password');
    await page.locator('#setup-form button[type=submit]').click();
    await page.locator('#setup-confirm-form').waitFor({ state: 'visible' });
    const secret = await page.inputValue('#totp-secret');
    await page.fill('#setup-otp', totp(secret));
    await page.locator('#setup-confirm-form button[type=submit]').click();
    await page.locator('#login-form').waitFor({ state: 'visible' });
    await page.screenshot({ path: 'qa-artifacts/login-desktop.png', fullPage: true });
    const fixtures = [
      { name: 'علی رضایی', phone: '09123456789', latitude: 35.6892, longitude: 51.3890 },
      { name: 'مریم احمدی', phone: '09351234567', latitude: 35.7000, longitude: 51.4100 },
      { name: 'نام <img src=x onerror=alert(1)>', phone: '09123456789', latitude: 35.6800, longitude: 51.3700 }
    ];
    for (const fixture of fixtures) {
      const device = await post('/api/device/register', { name: fixture.name, phone: fixture.phone, consent: true, disclosureVersion: 1 });
      await post('/api/device/location', { latitude: fixture.latitude, longitude: fixture.longitude, accuracy: 8, capturedAt: Date.now(), battery: 70 }, device.token);
    }
    await page.fill('#username', 'browseradmin');
    await page.fill('#password', 'browser-test-password');
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('#otp-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#dashboard').isVisible(), false);
    await page.fill('#otp', totp(secret, Math.floor(Date.now()/30000)+1));
    await page.locator('#otp-form button[type=submit]').click();
    await page.locator('#dashboard').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('.person').length === 3);
    assert.equal(await page.locator('.person img').count(), 0, 'User names must be rendered as text');
    await page.locator('.maplibregl-canvas').waitFor({ state: 'visible' });
    await page.waitForFunction(() => typeof map !== 'undefined' && map && map.isStyleLoaded() && map.areTilesLoaded(), null, { timeout: 60000 });
    await page.screenshot({ path: 'qa-artifacts/dashboard-desktop.png', fullPage: true });
    await page.fill('#search-phone', '۰۹۱۲۳۴۵۶۷۸۹');
    await page.locator('#search-form button').click();
    await page.waitForFunction(() => document.querySelectorAll('.person').length === 2);
    await page.locator('.person').first().click();
    await page.locator('#person-detail').waitFor({ state: 'visible' });
    assert.match(await page.locator('#person-detail').textContent(), /دقت/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => map.isStyleLoaded() && map.areTilesLoaded(), null, { timeout: 60000 });
    await page.screenshot({ path: 'qa-artifacts/dashboard-mobile.png', fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile panel must fit the viewport');
    await page.click('#show-all');
    await page.waitForFunction(() => document.querySelectorAll('.person').length === 3);
    await page.click('#logout');
    await page.locator('#login-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#dashboard').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Browser QA passed: setup, password + TOTP, live API data, safe names, phone search, mobile layout, logout.');
  } catch (error) {
    await page.screenshot({ path: 'qa-artifacts/failure.png', fullPage: true });
    console.error('Panel map message:', await page.locator('#map-message').textContent());
    throw error;
  } finally {
    await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
