'use strict';

const loginScreen = document.getElementById('login-screen');
const app = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const loginRole = document.getElementById('login-role');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const content = document.getElementById('content');
const pageTitle = document.getElementById('page-title');
const pageSubtitle = document.getElementById('page-subtitle');
const roleLabel = document.getElementById('role-label');
const nav = document.getElementById('nav');
const refreshBtn = document.getElementById('refresh-btn');
const logoutBtn = document.getElementById('logout-btn');
const liveState = document.getElementById('live-state');
const toastEl = document.getElementById('toast');
const modalEl = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');

let session = null;
let currentView = 'dashboard';
let eventSource = null;
let rendering = false;
let toastTimer = null;
let licenseQuery = '';
let licenseStatus = 'ALL';
let auditQuery = '';
let auditType = 'ALL';
let selectedLicenses = new Set();

const titles = {
  dashboard: ['Dashboard', 'Relay 전체 상태와 최근 이벤트를 확인합니다.'],
  servers: ['Servers', 'WinSockServer 연결과 상태를 관리합니다.'],
  clients: ['Clients', 'APK Client 연결, 라이선스와 배정을 확인합니다.'],
  licenses: ['Licenses', '라이선스 생성, 연장, 이전 및 상태를 관리합니다.'],
  audit: ['Audit Log', '최근 서버 이벤트와 관리 작업 기록입니다.'],
  backups: ['Backups', 'Relay 데이터베이스 백업과 복원을 관리합니다.'],
  system: ['System', '서비스, 유지보수 및 최소 버전 정책을 관리합니다.']
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtTime(value) {
  const n = Number(value || 0);
  if (!n) return '-';
  return new Date(n).toLocaleString('ko-KR', { hour12: false });
}

function fmtDuration(ms) {
  ms = Math.max(0, Number(ms || 0));
  const d = Math.floor(ms / 86400000);
  const h = Math.floor(ms / 3600000) % 24;
  const m = Math.floor(ms / 60000) % 60;
  if (d) return `${d}일 ${h}시간`;
  if (h) return `${h}시간 ${m}분`;
  return `${m}분`;
}

function fmtBytes(value) {
  let n = Number(value || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function badge(value) {
  const text = String(value || 'UNKNOWN').toUpperCase();
  let cls = text.toLowerCase();
  if (['GOOD', 'ONLINE', 'BOUND', 'AVAILABLE'].includes(text)) cls = 'good';
  else if (['SLOW', 'UNSTABLE', 'DRAINING', 'KICKED'].includes(text)) cls = 'warn';
  else if (['OFFLINE', 'DISABLED', 'EXPIRED', 'SUSPENDED'].includes(text)) cls = 'bad';
  else if (text === 'NONE') cls = 'none';
  return `<span class="badge ${esc(cls)}">${esc(text)}</span>`;
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3200);
}

async function api(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (session && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = session.csrf;
  const request = { method, headers, credentials: 'same-origin' };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, request);
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (response.status === 401) {
    showLogin();
    throw new Error('로그인이 만료되었습니다.');
  }
  if (!response.ok || data.ok === false) {
    const detail = data.detail ? ` (${data.detail})` : '';
    throw new Error(`${data.error || `HTTP_${response.status}`}${detail}`);
  }
  return data;
}

function showLogin() {
  session = null;
  if (eventSource) { eventSource.close(); eventSource = null; }
  app.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  loginPassword.value = '';
  liveState.classList.add('off');
}

function showApp() {
  loginScreen.classList.add('hidden');
  app.classList.remove('hidden');
  roleLabel.textContent = session.role.toUpperCase();
  startEvents();
  renderCurrent();
}

function startEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('ready', () => {
    liveState.textContent = 'LIVE';
    liveState.classList.remove('off');
  });
  eventSource.addEventListener('tick', () => {
    if (!document.hidden && !rendering) renderCurrent(true);
  });
  eventSource.addEventListener('session', () => showLogin());
  eventSource.onerror = () => {
    liveState.textContent = 'RECONNECT';
    liveState.classList.add('off');
  };
}

async function restoreSession() {
  try {
    const data = await api('/api/session');
    session = { role: data.role, csrf: data.csrf, expiresAt: data.expiresAt };
    showApp();
  } catch (_) {
    showLogin();
  }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  loginError.textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: { role: loginRole.value, password: loginPassword.value }
    });
    session = { role: data.role, csrf: data.csrf, expiresAt: data.expiresAt };
    loginPassword.value = '';
    showApp();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

logoutBtn.addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: {} }); } catch (_) {}
  showLogin();
});

refreshBtn.addEventListener('click', () => renderCurrent());

nav.addEventListener('click', event => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  currentView = button.dataset.view;
  nav.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === button));
  renderCurrent();
});

function roleIsAdmin() { return session && session.role === 'admin'; }
function roleCanOperate() { return session && (session.role === 'admin' || session.role === 'operator'); }

async function renderCurrent(silent = false) {
  if (!session || rendering) return;
  rendering = true;
  const meta = titles[currentView] || titles.dashboard;
  pageTitle.textContent = meta[0];
  pageSubtitle.textContent = meta[1];
  if (!silent) content.innerHTML = '<div class="empty">불러오는 중...</div>';
  try {
    if (currentView === 'dashboard') await renderDashboard();
    else if (currentView === 'servers') await renderServers();
    else if (currentView === 'clients') await renderClients();
    else if (currentView === 'licenses') await renderLicenses();
    else if (currentView === 'audit') await renderAudit();
    else if (currentView === 'backups') await renderBackups();
    else if (currentView === 'system') await renderSystem();
  } catch (error) {
    if (!silent) content.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    toast(error.message, true);
  } finally {
    rendering = false;
  }
}

async function renderDashboard() {
  const { dashboard: d } = await api('/api/dashboard');
  content.innerHTML = `
    <div class="cards">
      <div class="card"><div class="stat-label">SERVERS</div><div class="stat-value">${d.servers.online} / ${d.servers.total}</div><div class="stat-sub">Disabled ${d.servers.disabled} · Draining ${d.servers.draining}</div></div>
      <div class="card"><div class="stat-label">CLIENTS</div><div class="stat-value">${d.clients.online} / ${d.clients.total}</div><div class="stat-sub">Disabled ${d.clients.disabled}</div></div>
      <div class="card"><div class="stat-label">LICENSES</div><div class="stat-value">${d.licenses.bound}</div><div class="stat-sub">Available ${d.licenses.available} · Expired ${d.licenses.expired}</div></div>
      <div class="card"><div class="stat-label">ACK SUCCESS</div><div class="stat-value">${d.ack.successRate}%</div><div class="stat-sub">Pending ${d.ack.pending} · Timeout ${d.ack.timeout}</div></div>
      <div class="card"><div class="stat-label">SERVICE</div><div class="stat-value">${d.serviceEnabled ? 'ONLINE' : 'OFFLINE'}</div><div class="stat-sub">Maintenance ${d.maintenanceMode ? 'ON' : 'OFF'}</div></div>
      <div class="card"><div class="stat-label">UPTIME</div><div class="stat-value">${esc(fmtDuration(d.uptimeMs))}</div><div class="stat-sub">Connections ${d.totalConnections}</div></div>
      <div class="card"><div class="stat-label">ACK</div><div class="stat-value">${d.ack.ok}</div><div class="stat-sub">Error ${d.ack.error} · Retry ${d.ack.retries}</div></div>
      <div class="card"><div class="stat-label">VERSION</div><div class="stat-value">P${d.versions.protocol}</div><div class="stat-sub">Server ${esc(d.versions.server)} · Client ${esc(d.versions.client)}</div></div>
    </div>
    <div class="grid-2">
      <div class="section-card"><div class="section-head"><h3>최근 이벤트</h3><span class="small-note">최근 30건</span></div><div class="section-body"><div class="event-list">
        ${d.recentEvents.length ? d.recentEvents.map(e => `<div class="event"><span>${esc(fmtTime(e.time))}</span><span class="type">${esc(e.type)}</span><span>${esc(e.detail)}</span></div>`).join('') : '<div class="empty">이벤트 없음</div>'}
      </div></div></div>
      <div class="section-card"><div class="section-head"><h3>License 상태</h3></div><div class="section-body"><div class="kv">
        <div>Available</div><div>${d.licenses.available}</div><div>Bound</div><div>${d.licenses.bound}</div><div>Suspended</div><div>${d.licenses.suspended}</div><div>Expired</div><div>${d.licenses.expired}</div><div>Total</div><div>${d.licenses.total}</div>
      </div></div></div>
    </div>`;
}

async function renderServers() {
  const { servers } = await api('/api/servers');
  const actions = server => {
    const id = esc(server.id);
    const detail = `<button data-server-action="detail" data-id="${id}">상세</button>`;
    if (!roleIsAdmin()) return `<div class="actions">${detail}</div>`;

    const kick = server.online && server.status !== 'DISABLED' ? `<button class="warning" data-server-action="kick" data-id="${id}">Kick 60s</button>` : '';
    const drain = server.status === 'DRAINING'
      ? `<button data-server-action="drain-off" data-id="${id}">Drain OFF</button>`
      : server.status !== 'DISABLED' ? `<button data-server-action="drain-on" data-id="${id}">Drain ON</button>` : '';
    const enabled = server.status === 'DISABLED'
      ? `<button class="primary" data-server-action="enable" data-id="${id}">Enable</button>`
      : `<button class="danger" data-server-action="disable" data-id="${id}">Disable</button>`;
    return `<div class="actions">${detail}${kick}${drain}${enabled}</div>`;
  };

  content.innerHTML = `<div class="toolbar"><span class="small-note">Kick은 60초 임시 차단 · Drain은 신규 Client 배정만 중지 · Disable은 Enable 전까지 차단</span></div><div class="table-wrap"><table><thead><tr><th>SERVER-ID</th><th>Status</th><th>Health</th><th>Accept</th><th>Clients</th><th>RTT</th><th>Version</th><th>IP</th><th>Last Seen</th><th>Reconnect</th><th>Action</th></tr></thead><tbody>
    ${servers.map(s => `<tr><td class="code">${esc(s.id)}</td><td>${badge(s.status)}</td><td>${badge(s.health)}</td><td>${s.canAcceptClients ? badge('ONLINE') : badge('OFFLINE')}</td><td>${s.clients} / ${s.savedClients}</td><td>${s.rttMs >= 0 ? `${s.rttMs} ms` : '-'}</td><td>${esc(s.appVersion || '-')}</td><td>${esc(s.lastIP || '-')}</td><td>${esc(fmtTime(s.lastSeen))}</td><td>${s.reconnectCount}</td><td>${actions(s)}</td></tr>`).join('') || '<tr><td colspan="11" class="empty">Server 없음</td></tr>'}
  </tbody></table></div>`;
}

async function renderClients() {
  const { clients } = await api('/api/clients');
  const actions = client => {
    const id = esc(client.id);
    let html = `<button data-client-action="detail" data-id="${id}">상세</button>`;
    if (roleCanOperate() && client.online) html += `<button data-client-action="notice" data-id="${id}">Notice</button>`;
    if (roleIsAdmin()) {
      html += `<button data-client-action="move" data-id="${id}">Move</button>`;
      if (client.online && client.status !== 'DISABLED') html += `<button class="warning" data-client-action="kick" data-id="${id}">Kick 60s</button>`;
      html += client.status === 'DISABLED'
        ? `<button class="primary" data-client-action="enable" data-id="${id}">Enable</button>`
        : `<button class="danger" data-client-action="disable" data-id="${id}">Disable</button>`;
    }
    return `<div class="actions">${html}</div>`;
  };

  content.innerHTML = `<div class="toolbar"><span class="small-note">Kick은 60초 임시 차단 · Disable은 Enable 전까지 재접속 차단</span></div><div class="table-wrap"><table><thead><tr><th>CLIENT-ID</th><th>Status</th><th>Health</th><th>Server</th><th>License</th><th>Expires</th><th>RTT</th><th>Send</th><th>Last Seen</th><th>Action</th></tr></thead><tbody>
    ${clients.map(c => `<tr><td class="code">${esc(c.id)}</td><td>${badge(c.status)}</td><td>${badge(c.health)}</td><td class="code">${esc(c.serverId)}</td><td>${badge(c.licenseStatus)}</td><td>${esc(fmtTime(c.licenseExpiresAt))}</td><td>${c.rttMs >= 0 ? `${c.rttMs} ms` : '-'}</td><td>${c.sendCount}</td><td>${esc(fmtTime(c.lastSeenAt))}</td><td>${actions(c)}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">Client 없음</td></tr>'}
  </tbody></table></div>`;
}

async function renderLicenses() {
  const q = encodeURIComponent(licenseQuery);
  const s = encodeURIComponent(licenseStatus);
  const { licenses } = await api(`/api/licenses?query=${q}&status=${s}`);
  const operator = roleCanOperate();
  content.innerHTML = `
    <div class="toolbar">
      <input id="license-search" placeholder="Key / Client / Memo 검색" value="${esc(licenseQuery)}">
      <select id="license-status"><option>ALL</option><option>AVAILABLE</option><option>BOUND</option><option>SUSPENDED</option><option>EXPIRED</option></select>
      <button id="license-search-btn">검색</button>
      ${roleIsAdmin() ? '<button id="license-create-btn" class="primary">+ License 생성</button>' : ''}
      ${operator ? '<button id="license-bulk-btn">선택 작업</button>' : ''}
    </div>
    <div class="table-wrap"><table><thead><tr><th><input id="license-check-all" type="checkbox"></th><th>KEY</th><th>Status</th><th>Client</th><th>Expires</th><th>Memo</th><th>Auth</th><th>Send</th><th>Action</th></tr></thead><tbody>
      ${licenses.map(l => `<tr><td><input class="license-check" type="checkbox" data-key="${esc(l.key)}" ${selectedLicenses.has(l.key) ? 'checked' : ''}></td><td class="code">${esc(l.key)}</td><td>${badge(l.status)}</td><td class="code">${esc(l.boundClient || '-')}</td><td>${esc(fmtTime(l.expiresAt))}</td><td>${esc(l.memo || '-')}</td><td>${l.authCount}</td><td>${l.sendCount}</td><td><div class="actions">${operator ? `<button data-license-action="extend" data-key="${esc(l.key)}">연장</button><button data-license-action="unbind" data-key="${esc(l.key)}">Unbind</button><button data-license-action="suspend" data-key="${esc(l.key)}">Suspend</button><button data-license-action="resume" data-key="${esc(l.key)}">Resume</button><button data-license-action="transfer" data-key="${esc(l.key)}">Transfer</button>` : ''}${roleIsAdmin() ? `<button data-license-action="reissue" data-key="${esc(l.key)}">Reissue</button><button class="danger" data-license-action="delete" data-key="${esc(l.key)}">Delete</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="9" class="empty">License 없음</td></tr>'}
    </tbody></table></div>`;
  document.getElementById('license-status').value = licenseStatus;
}

async function renderAudit() {
  const { events } = await api(`/api/audit?query=${encodeURIComponent(auditQuery)}&type=${encodeURIComponent(auditType)}`);
  const types = [...new Set(events.map(x => x.type))].sort();
  content.innerHTML = `<div class="toolbar"><input id="audit-search" placeholder="이벤트 검색" value="${esc(auditQuery)}"><select id="audit-type"><option value="ALL">ALL</option>${types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select><button id="audit-search-btn">검색</button></div>
  <div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Detail</th></tr></thead><tbody>${events.map(e => `<tr><td>${esc(fmtTime(e.time))}</td><td class="code">${esc(e.type)}</td><td>${esc(e.detail)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Audit 없음</td></tr>'}</tbody></table></div>`;
  const typeEl = document.getElementById('audit-type');
  if ([...typeEl.options].some(o => o.value === auditType)) typeEl.value = auditType;
}

async function renderBackups() {
  const { backups } = await api('/api/backups');
  content.innerHTML = `<div class="toolbar">${roleIsAdmin() ? '<button id="backup-create-btn" class="primary">백업 생성</button>' : ''}<span class="small-note">Restore는 현재 Server/Client를 재접속시킵니다.</span></div>
  <div class="table-wrap"><table><thead><tr><th>File</th><th>Size</th><th>Created</th><th>Action</th></tr></thead><tbody>${backups.map(b => `<tr><td class="code">${esc(b.file)}</td><td>${esc(fmtBytes(b.size))}</td><td>${esc(fmtTime(b.mtimeMs))}</td><td>${roleIsAdmin() ? `<div class="actions"><button class="warning" data-backup-action="restore" data-file="${esc(b.file)}">Restore</button><button class="danger" data-backup-action="delete" data-file="${esc(b.file)}">Delete</button></div>` : '-'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Backup 없음</td></tr>'}</tbody></table></div>`;
}

async function renderSystem() {
  const { system: s } = await api('/api/system');
  const schedule = s.maintenanceSchedule;
  content.innerHTML = `<div class="panel-grid">
    <div class="section-card"><div class="section-head"><h3>Service</h3>${badge(s.serviceEnabled ? 'ONLINE' : 'OFFLINE')}</div><div class="section-body"><div class="kv"><div>Maintenance</div><div>${badge(s.maintenanceMode ? 'ON' : 'OFF')}</div><div>Web Admin</div><div>v${esc(s.webAdminVersion || '-')}</div><div>Legacy TCP Admin</div><div>${badge(s.legacyTcpAdminEnabled ? 'ONLINE' : 'DISABLED')}</div><div>Data Dir</div><div class="code">${esc(s.dataDir)}</div><div>Max Clients / Server</div><div>${s.maxClientsPerServer}</div><div>Rate Limit</div><div>${s.rateLimit}/sec</div></div>${roleIsAdmin() ? `<div class="toolbar"><button id="service-start-btn">Service Start</button><button id="service-stop-btn" class="danger">Service Stop</button><button id="maint-on-btn" class="warning">Maintenance ON</button><button id="maint-off-btn">Maintenance OFF</button></div>` : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>Version Policy</h3></div><div class="section-body"><div class="form-grid"><label>Protocol<input id="version-protocol" type="number" min="1" max="${s.currentProtocolVersion}" value="${s.minProtocolVersion}"></label><label>Server<input id="version-server" value="${esc(s.minServerVersion)}"></label><label>Client<input id="version-client" value="${esc(s.minClientVersion)}"></label><label>Current Protocol<input disabled value="${s.currentProtocolVersion}"></label></div>${roleIsAdmin() ? '<button id="version-apply-btn" class="warning">Version Policy 적용</button>' : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>Maintenance Schedule</h3></div><div class="section-body">${schedule ? `<div class="kv"><div>Start</div><div>${esc(fmtTime(schedule.startAt))}</div><div>End</div><div>${esc(fmtTime(schedule.endAt))}</div><div>Message</div><div>${esc(schedule.message)}</div></div>` : '<p class="muted">예약된 Maintenance가 없습니다.</p>'}${roleIsAdmin() ? '<div class="toolbar"><button id="schedule-create-btn">예약 설정</button><button id="schedule-clear-btn">예약 제거</button></div>' : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>Notice</h3></div><div class="section-body"><p class="muted">현재 온라인 Client 전체에 공지를 전송합니다.</p>${roleCanOperate() ? '<button id="notice-all-btn">전체 공지 보내기</button>' : ''}</div></div>
  </div>`;
}

function openModal(options) {
  return new Promise(resolve => {
    modalTitle.textContent = options.title || '확인';
    const fields = options.fields || [];
    modalBody.innerHTML = `${options.message ? `<p>${esc(options.message)}</p>` : ''}${options.html || ''}${fields.map(f => {
      if (f.type === 'textarea') return `<label>${esc(f.label)}<textarea data-modal-field="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea></label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select data-modal-field="${esc(f.name)}">${(f.options || []).map(o => `<option value="${esc(o.value ?? o)}">${esc(o.label ?? o)}</option>`).join('')}</select></label>`;
      return `<label>${esc(f.label)}<input data-modal-field="${esc(f.name)}" type="${esc(f.type || 'text')}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"></label>`;
    }).join('')}`;
    modalConfirm.textContent = options.confirmLabel || '확인';
    modalConfirm.className = options.danger ? 'danger' : 'primary';
    modalEl.classList.remove('hidden');
    modalEl.setAttribute('aria-hidden', 'false');

    const close = value => {
      modalEl.classList.add('hidden');
      modalEl.setAttribute('aria-hidden', 'true');
      modalConfirm.onclick = null;
      modalCancel.onclick = null;
      modalEl.querySelectorAll('[data-modal-close]').forEach(x => x.onclick = null);
      resolve(value);
    };
    modalCancel.onclick = () => close(null);
    modalEl.querySelectorAll('[data-modal-close]').forEach(x => x.onclick = () => close(null));
    modalConfirm.onclick = () => {
      const values = {};
      modalBody.querySelectorAll('[data-modal-field]').forEach(el => values[el.dataset.modalField] = el.value);
      close(values);
    };
    const first = modalBody.querySelector('input,textarea,select');
    if (first) setTimeout(() => first.focus(), 20);
  });
}

content.addEventListener('click', async event => {
  try {
    const serverBtn = event.target.closest('[data-server-action]');
    if (serverBtn) { await serverAction(serverBtn.dataset.serverAction, serverBtn.dataset.id); return; }
    const clientBtn = event.target.closest('[data-client-action]');
    if (clientBtn) { await clientAction(clientBtn.dataset.clientAction, clientBtn.dataset.id); return; }
    const licBtn = event.target.closest('[data-license-action]');
    if (licBtn) { await licenseAction(licBtn.dataset.licenseAction, licBtn.dataset.key); return; }
    const backupBtn = event.target.closest('[data-backup-action]');
    if (backupBtn) { await backupAction(backupBtn.dataset.backupAction, backupBtn.dataset.file); return; }

    if (event.target.id === 'license-search-btn') {
      licenseQuery = document.getElementById('license-search').value.trim();
      licenseStatus = document.getElementById('license-status').value;
      renderLicenses(); return;
    }
    if (event.target.id === 'license-create-btn') { await createLicense(); return; }
    if (event.target.id === 'license-bulk-btn') { await bulkLicense(); return; }
    if (event.target.id === 'license-check-all') {
      document.querySelectorAll('.license-check').forEach(x => { x.checked = event.target.checked; if (x.checked) selectedLicenses.add(x.dataset.key); else selectedLicenses.delete(x.dataset.key); });
      return;
    }
    if (event.target.classList.contains('license-check')) {
      if (event.target.checked) selectedLicenses.add(event.target.dataset.key); else selectedLicenses.delete(event.target.dataset.key);
      return;
    }
    if (event.target.id === 'audit-search-btn') {
      auditQuery = document.getElementById('audit-search').value.trim();
      auditType = document.getElementById('audit-type').value;
      renderAudit(); return;
    }
    if (event.target.id === 'backup-create-btn') {
      const r = await api('/api/backups/create', { method: 'POST', body: {} }); toast(`백업 생성: ${r.file}`); renderBackups(); return;
    }
    if (event.target.id === 'service-start-btn') { await api('/api/system/service/start', { method: 'POST', body: {} }); toast('Service ONLINE'); renderSystem(); return; }
    if (event.target.id === 'service-stop-btn') {
      const v = await openModal({ title: 'Service Stop', message: '현재 Client 인증을 해제하고 서비스를 중지합니다. 확인하려면 STOP을 입력하세요.', fields: [{ name: 'confirmText', label: '확인 문구' }], danger: true, confirmLabel: '중지' });
      if (!v) return; await api('/api/system/service/stop', { method: 'POST', body: v }); toast('Service OFFLINE'); renderSystem(); return;
    }
    if (event.target.id === 'maint-on-btn') { await api('/api/system/maintenance/on', { method: 'POST', body: {} }); toast('Maintenance ON'); renderSystem(); return; }
    if (event.target.id === 'maint-off-btn') { await api('/api/system/maintenance/off', { method: 'POST', body: {} }); toast('Maintenance OFF'); renderSystem(); return; }
    if (event.target.id === 'version-apply-btn') { await applyVersion(); return; }
    if (event.target.id === 'schedule-create-btn') { await createSchedule(); return; }
    if (event.target.id === 'schedule-clear-btn') { await api('/api/system/maintenance/clear', { method: 'POST', body: {} }); toast('Maintenance 예약 제거'); renderSystem(); return; }
    if (event.target.id === 'notice-all-btn') { await sendNoticeAll(); return; }
  } catch (error) { toast(error.message, true); }
});

async function serverAction(action, id) {
  const encodedId = encodeURIComponent(id);
  if (action === 'detail') {
    const { server } = await api(`/api/servers/${encodedId}`);
    const clients = server.clientsList.map(c => `<tr><td class="code">${esc(c.id)}</td><td>${badge(c.status)}</td><td>${badge(c.licenseStatus)}</td></tr>`).join('') || '<tr><td colspan="3">Client 없음</td></tr>';
    await openModal({ title: `Server ${id}`, html: `<div class="kv"><div>Device Key</div><div class="code">${esc(server.deviceKey)}</div><div>Status</div><div>${badge(server.status)}</div><div>Health</div><div>${badge(server.health)}</div><div>Accept Clients</div><div>${server.canAcceptClients ? badge('ONLINE') : badge('OFFLINE')}</div><div>Live / Saved Clients</div><div>${server.clients} / ${server.savedClients}</div><div>RTT</div><div>${server.rttMs >= 0 ? `${server.rttMs} ms` : '-'}</div><div>Kick Until</div><div>${esc(fmtTime(server.kickedUntil))}</div><div>IP</div><div>${esc(server.lastIP || '-')}</div><div>Protocol / Version</div><div>${server.protocolVersion || '-'} / ${esc(server.appVersion || '-')}</div><div>Reconnect</div><div>${server.reconnectCount}</div><div>Last Seen</div><div>${esc(fmtTime(server.lastSeen))}</div></div><div class="table-wrap"><table><thead><tr><th>Client</th><th>Status</th><th>License</th></tr></thead><tbody>${clients}</tbody></table></div>`, confirmLabel: '닫기' });
    return;
  }

  let body = {};
  if (action === 'kick') {
    const v = await openModal({ title: 'Server Kick', message: `${id} 연결을 끊고 60초 동안 재등록을 차단합니다.`, confirmLabel: 'Kick' });
    if (!v) return;
  } else if (action === 'drain-on') {
    const v = await openModal({ title: 'Drain ON', message: `${id}에 신규 Client 배정을 중지합니다. 기존 Client는 유지됩니다.`, confirmLabel: '적용' });
    if (!v) return;
  } else if (action === 'disable') {
    const v = await openModal({ title: 'Server Disable', message: `${id} 서버를 비활성화하고 현재 연결을 종료합니다. 계속하시겠습니까?`, danger: true, confirmLabel: 'Disable' });
    if (!v) return;
  }

  await api(`/api/servers/${encodedId}/${action}`, { method: 'POST', body });
  toast(`Server ${action}: ${id}`);
  await renderServers();
}

async function clientAction(action, id) {
  const encodedId = encodeURIComponent(id);
  if (action === 'detail') {
    const { client } = await api(`/api/clients/${encodedId}`);
    await openModal({ title: `Client ${id}`, html: `<div class="kv"><div>Device Key</div><div class="code">${esc(client.deviceKey)}</div><div>Status</div><div>${badge(client.status)}</div><div>Health</div><div>${badge(client.health)}</div><div>Server</div><div class="code">${esc(client.serverId)}</div><div>License</div><div class="code">${esc(client.licenseKey || '-')}</div><div>License Status</div><div>${badge(client.licenseStatus)}</div><div>Expires</div><div>${esc(fmtTime(client.licenseExpiresAt))}</div><div>Kick Until</div><div>${esc(fmtTime(client.kickedUntil))}</div><div>IP</div><div>${esc(client.lastIP || '-')}</div><div>Protocol / Version</div><div>${client.protocolVersion || '-'} / ${esc(client.appVersion || '-')}</div><div>RTT</div><div>${client.rttMs >= 0 ? `${client.rttMs} ms` : '-'}</div><div>Auth / Send / Reconnect</div><div>${client.authCount} / ${client.sendCount} / ${client.reconnectCount}</div><div>Last Auth</div><div>${esc(fmtTime(client.lastAuthAt))}</div><div>Last Seen</div><div>${esc(fmtTime(client.lastSeenAt))}</div></div>`, confirmLabel: '닫기' });
    return;
  }

  if (action === 'notice') {
    const v = await openModal({ title: 'Client Notice', message: id, fields: [{ name: 'message', label: '공지', type: 'textarea' }], confirmLabel: '전송' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/notice`, { method: 'POST', body: v });
    toast('공지 전송 완료');
    return;
  }

  if (action === 'move') {
    const [{ client }, { servers }] = await Promise.all([api(`/api/clients/${encodedId}`), api('/api/servers')]);
    const eligible = servers.filter(s => s.id !== client.serverId && s.canAcceptClients);
    if (!eligible.length) {
      toast('이동 가능한 ONLINE Server가 없습니다.', true);
      return;
    }
    const v = await openModal({ title: 'Client Move', message: `${id}
ONLINE이며 Drain/Disable/Kick 상태가 아닌 Server만 표시됩니다.`, fields: [{ name: 'serverId', label: '새 Server', type: 'select', options: eligible.map(s => ({ value: s.id, label: `${s.id} · ${s.health} · ${s.clients}/${s.savedClients}` })) }], confirmLabel: '이동' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/move`, { method: 'POST', body: v });
    toast('Client 이동 완료');
    await renderClients();
    return;
  }

  let body = {};
  if (action === 'kick') {
    const v = await openModal({ title: 'Client Kick', message: `${id} 연결을 끊고 60초 동안 재접속을 차단합니다.`, confirmLabel: 'Kick' });
    if (!v) return;
  } else if (action === 'disable') {
    const v = await openModal({ title: 'Client Disable', message: `${id} Client를 비활성화하고 현재 연결을 종료합니다. 계속하시겠습니까?`, danger: true, confirmLabel: 'Disable' });
    if (!v) return;
  }

  await api(`/api/clients/${encodedId}/${action}`, { method: 'POST', body });
  toast(`Client ${action}: ${id}`);
  await renderClients();
}

async function createLicense() {
  const v = await openModal({ title: 'License 생성', fields: [{ name: 'days', label: '기간(일)', type: 'number', value: '30' }, { name: 'memo', label: 'Memo' }], confirmLabel: '생성' });
  if (!v) return;
  const r = await api('/api/licenses', { method: 'POST', body: { days: Number(v.days), memo: v.memo } });
  await openModal({ title: 'License 생성 완료', html: `<div class="kv"><div>Key</div><div class="code">${esc(r.key)}</div><div>Expires</div><div>${esc(fmtTime(r.expiresAt))}</div></div>`, confirmLabel: '닫기' });
  renderLicenses();
}

async function licenseAction(action, key) {
  let body = {};
  if (action === 'extend') {
    const v = await openModal({ title: 'License 연장', message: key, fields: [{ name: 'days', label: '추가 일수', type: 'number', value: '30' }], confirmLabel: '연장' }); if (!v) return; body.days = Number(v.days);
  } else if (action === 'transfer') {
    const v = await openModal({ title: 'License Transfer', message: key, fields: [{ name: 'clientId', label: '대상 CLIENT-ID' }], confirmLabel: '이전' }); if (!v) return; body = v;
  } else if (action === 'delete') {
    const v = await openModal({ title: 'License Delete', message: `${key}\n삭제하려면 DELETE를 입력하세요.`, fields: [{ name: 'confirmText', label: '확인 문구' }], danger: true, confirmLabel: '삭제' }); if (!v) return; body = v;
  } else {
    const v = await openModal({ title: `License ${action}`, message: `${key}\n계속하시겠습니까?`, danger: action === 'reissue', confirmLabel: '실행' }); if (!v) return;
  }
  const r = await api(`/api/licenses/${encodeURIComponent(key)}/${action}`, { method: 'POST', body });
  if (action === 'reissue') await openModal({ title: 'Reissue 완료', html: `<div class="kv"><div>Old</div><div class="code">${esc(r.oldKey)}</div><div>New</div><div class="code">${esc(r.newKey)}</div></div>`, confirmLabel: '닫기' });
  else toast(`License ${action} 완료`);
  renderLicenses();
}

async function bulkLicense() {
  const keys = [...selectedLicenses];
  if (!keys.length) { toast('선택된 License가 없습니다.', true); return; }
  const options = [{ value: 'extend', label: 'Extend' }, { value: 'unbind', label: 'Unbind' }, { value: 'suspend', label: 'Suspend' }, { value: 'resume', label: 'Resume' }];
  if (roleIsAdmin()) options.push({ value: 'delete', label: 'Delete' });
  const v = await openModal({ title: `선택 License ${keys.length}개`, fields: [{ name: 'action', label: '작업', type: 'select', options }, { name: 'days', label: '연장 일수(Extend만)', type: 'number', value: '30' }, { name: 'confirmText', label: 'Delete일 때 DELETE 입력' }], confirmLabel: '실행' });
  if (!v) return;
  const r = await api('/api/licenses/bulk', { method: 'POST', body: { action: v.action, keys, days: Number(v.days), confirmText: v.confirmText } });
  toast(`${r.success}/${r.total} 처리 완료`); selectedLicenses.clear(); renderLicenses();
}

async function backupAction(action, file) {
  const word = action === 'restore' ? 'RESTORE' : 'DELETE';
  const v = await openModal({ title: `Backup ${action}`, message: `${file}\n계속하려면 ${word}를 입력하세요.`, fields: [{ name: 'confirmText', label: '확인 문구' }], danger: true, confirmLabel: '실행' });
  if (!v) return;
  await api(`/api/backups/${encodeURIComponent(file)}/${action}`, { method: 'POST', body: v });
  toast(`Backup ${action} 완료`); renderBackups();
}

async function applyVersion() {
  const protocol = Number(document.getElementById('version-protocol').value);
  const serverVersion = document.getElementById('version-server').value.trim();
  const clientVersion = document.getElementById('version-client').value.trim();
  const v = await openModal({ title: 'Version Policy 적용', message: '기준 미달 Server/Client 연결이 종료될 수 있습니다. VERSION을 입력하세요.', fields: [{ name: 'confirmText', label: '확인 문구' }], danger: true, confirmLabel: '적용' });
  if (!v) return;
  await api('/api/system/version', { method: 'POST', body: { protocol, serverVersion, clientVersion, confirmText: v.confirmText } });
  toast('Version Policy 적용 완료'); renderSystem();
}

async function createSchedule() {
  const now = new Date(Date.now() + 3600000);
  const later = new Date(Date.now() + 7200000);
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const v = await openModal({ title: 'Maintenance 예약', fields: [{ name: 'start', label: '시작', type: 'datetime-local', value: local(now) }, { name: 'end', label: '종료', type: 'datetime-local', value: local(later) }, { name: 'message', label: '공지 메시지', value: 'Scheduled maintenance' }], confirmLabel: '예약' });
  if (!v) return;
  await api('/api/system/maintenance/schedule', { method: 'POST', body: { startAt: new Date(v.start).getTime(), endAt: new Date(v.end).getTime(), message: v.message } });
  toast('Maintenance 예약 완료'); renderSystem();
}

async function sendNoticeAll() {
  const v = await openModal({ title: '전체 Notice', fields: [{ name: 'message', label: '공지', type: 'textarea' }], confirmLabel: '전송' });
  if (!v) return;
  const r = await api('/api/system/notice', { method: 'POST', body: v });
  toast(`${r.count}개 Client에 전송 완료`);
}

restoreSession();
