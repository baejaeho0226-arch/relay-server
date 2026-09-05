'use strict';
// Deployment and cache recovery regression tests; Node built-ins only.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const bundle = require('../web/uiBundle');
const root = path.resolve(__dirname, '..');
const origin = 'https://relay.test';
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

function testBundle() {
  assert.equal(bundle.Check().ready, true);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ui-bundle-'));
  try {
    for (const name of bundle.FILES) fs.copyFileSync(path.join(root, 'public', name), path.join(temp, name));
    assert.equal(bundle.Check(temp).ready, true);
    fs.writeFileSync(path.join(temp, 'index.html'), source('public/index.html').replace(/\r?\n/g, '\r\n'));
    assert.equal(bundle.Check(temp).ready, true, 'Windows line endings are compatible');
    fs.writeFileSync(path.join(temp, 'admin.js'), source('public/admin.js').replace("'fix8'", "'biometric1'"));
    assert.deepEqual(bundle.Check(temp).issues, ['public/admin.js']);
    fs.unlinkSync(path.join(temp, 'admin-pages-support.js'));
    assert.deepEqual(bundle.Check(temp).issues, ['public/admin.js', 'public/admin-pages-support.js']);
    // Corrupt manifests must fail closed, without touching the release files.
    for (const text of ['null', 'true', '[]', '{', '{}']) {
      const mod = { exports: {} };
      vm.runInNewContext(source('web/uiBundle.js'), {
        module: mod, __dirname: path.join(root, 'web'),
        require(name) {
          if (name !== 'fs') return require(name);
          return { ...fs, readFileSync(file, ...args) {
            return file === bundle.ManifestPath ? text : fs.readFileSync(file, ...args);
          }};
        }
      });
      assert.equal(mod.exports.Check().ready, false, `Invalid manifest: ${text}`);
    }
    let status, body, headers;
    bundle.Unavailable({ writeHead(s, h) { status = s; headers = h; }, end(b) { body = b; } });
    assert.equal(status, 503);
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.ok(body.includes('/ui-refresh'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function testRefresh(ready) {
  let click, redirected = '', updates = 0;
  const removed = [], button = { disabled: false, addEventListener(_, fn) { click = fn; } };
  const status = { textContent: '' };
  const caches = { keys: async () => ['relay-admin-shell-old', 'another-app-cache'], delete: async name => removed.push(name) };
  const registration = { active: { scriptURL: `${origin}/service-worker.js` }, async update() { updates++; }, unregister() { throw new Error('Must preserve Push registration'); } };
  const context = {
    document: { getElementById: id => id === 'ui-refresh-button' ? button : status },
    window: { caches }, caches, URL, Date, encodeURIComponent,
    location: { origin, replace: url => { redirected = url; } },
    navigator: { serviceWorker: { getRegistrations: async () => [registration, { active: { scriptURL: `${origin}/other-worker.js` }, update() { throw new Error('Unrelated worker'); } }] } },
    fetch: async (_, options) => {
      assert.equal(options.cache, 'no-store');
      assert.equal(options.credentials, 'same-origin');
      return { ok: true, json: async () => ({ ready, uiRevision: 'fix8', issues: ['public/admin.js'] }) };
    }
  };
  vm.runInNewContext(source('public/ui-refresh.js'), context);
  await click();
  if (ready) {
    assert.deepEqual(removed, ['relay-admin-shell-old']);
    assert.equal(updates, 1);
    assert.match(redirected, /^\/\?ui-refresh=fix8-/);
  } else {
    assert.deepEqual(removed, []);
    assert.equal(updates, 0);
    assert.equal(redirected, '');
    assert.equal(button.disabled, false);
    assert.match(status.textContent, /public\/admin.js/);
  }
}

async function testWorker() {
  const handlers = {}, removed = [], puts = [], reads = [], network = [];
  let failNetwork = false, responseStatus = 200;
  const cache = {
    addAll: async requests => { for (const r of requests) assert.equal(r.cache, 'no-store'); },
    put: async (key, response) => { puts.push(typeof key === 'string' ? key : key.url); assert.equal(response.status, 200); },
    match: async key => { reads.push(key); return key === '/index.html' ? new Response('<html>cached shell</html>') : undefined; }
  };
  // Browsers accept relative URLs in Request and expose mode=navigate for navigation.
  class BrowserRequest {
    constructor(input, options = {}) {
      this.url = new URL(typeof input === 'string' ? input : input.url, origin).href;
      this.method = options.method || input.method || 'GET';
      this.mode = options.mode || input.mode || 'cors';
      this.cache = options.cache || input.cache || 'default';
    }
  }
  const worker = {
    location: { origin }, addEventListener: (name, handler) => { handlers[name] = handler; },
    skipWaiting: async () => {}, clients: { claim: async () => {} }
  };
  vm.runInNewContext(source('public/service-worker.js'), {
    self: worker, URL, Request: BrowserRequest, Response,
    caches: { open: async () => cache, keys: async () => ['relay-admin-shell-old', 'relay-admin-shell-v3.5.3-fix8', 'another-app-cache'], delete: async name => { removed.push(name); } },
    fetch: async request => {
      network.push(request);
      if (failNetwork) throw new Error('OFFLINE');
      return new Response('network', { status: responseStatus });
    }
  });
  for (const type of ['install', 'activate']) {
    let work;
    handlers[type]({ waitUntil: p => { work = p; } });
    await work;
  }
  assert.deepEqual(removed, ['relay-admin-shell-old']);
  async function request(url, mode) {
    let response;
    const work = [];
    handlers.fetch({ request: new BrowserRequest(url, { mode }), respondWith: p => { response = p; }, waitUntil: p => work.push(p) });
    const result = await response;
    await Promise.all(work);
    return result;
  }
  await request('/admin.js?v=3.5.3-fix8');
  assert.equal(puts.length, 1);
  responseStatus = 503;
  assert.equal((await request('/')).status, 503);
  assert.equal(puts.length, 1, 'Error response must not enter cache');
  failNetwork = true;
  assert.equal((await request('/admin-missing.js')).status, 503);
  assert.ok((await (await request('/', 'navigate')).text()).includes('cached shell'));
  const count = reads.length;
  await assert.rejects(request('/api/support'), /OFFLINE/);
  await assert.rejects(request('/ui-version.json'), /OFFLINE/);
  await assert.rejects(request('/ui-refresh'), /OFFLINE/);
  assert.equal(reads.length, count, 'API/recovery must never fall back to cached data');
  assert.ok(network.every(r => r.cache === 'no-store'));
}

(async () => {
  testBundle();
  await testRefresh(false);
  await testRefresh(true);
  await testWorker();
  console.log('WEB UI CACHE PASS: mixed/missing files, CRLF, invalid manifest, recovery, scoped cache clearing, preserved Push registration, network-only API, offline shell and missing JS');
})().catch(error => { console.error(error); process.exitCode = 1; });
