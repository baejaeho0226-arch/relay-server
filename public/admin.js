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
const notificationBadge = document.getElementById('notification-badge');
const installPwaBtn = document.getElementById('install-pwa-btn');

let session = null;
let currentView = 'dashboard';
let eventSource = null;
let rendering = false;
let toastTimer = null;
let licenseQuery = '';
let licenseStatus = 'ALL';
let licenseExpiry = 'ALL';
let auditQuery = '';
let auditType = 'ALL';
let activityQuery = '';
let selectedLicenses = new Set();
let liveConsoleEvents = [];
let consolePaused = false;
let traceQuery = '';
let traceRows = new Map();
let failoverRows = new Map();
let failoverServers = [];
let recoveryQuery = '';
let statsRange = '1H';
let paletteTimer = null;
let terminalLines = [];
let terminalHistory = [];
let terminalHistoryIndex = -1;
let deferredInstallPrompt = null;

const titles = {
  dashboard: ['Dashboard', 'Relay 전체 상태와 최근 이벤트를 확인합니다.'],
  console: ['Live Console', 'Relay 이벤트가 실시간으로 스트리밍됩니다.'],
  trace: ['Request Trace', 'Request ID 기준으로 전달/Retry/ACK 처리 과정을 추적합니다.'],
  monitor: ['Health Monitor', 'Server / Client RTT와 연결 상태를 3초 단위로 감시합니다.'],
  terminal: ['Command Terminal', '허용된 Relay 관리 명령만 실행합니다. OS Shell은 연결되지 않습니다.'],
  distribution: ['Distribution', 'Server별 Live / Binding Client 분포와 Drain 진행률을 확인합니다.'],
  failover: ['Emergency Failover', '기존 Primary 바인딩을 보존한 채 opt-in Client만 장애 시 임시 Server로 재배치합니다.'],
  recovery: ['Request Recovery', 'Offline Queue, Request Replay, Dead Letter Queue를 관리합니다.'],
  notifications: ['Notifications', '중요 운영 경고와 시스템 이벤트를 확인합니다.'],
  servers: ['Servers', 'WinSockServer 연결과 상태를 관리합니다.'],
  clients: ['Clients', 'APK Client 연결, 라이선스와 배정을 확인합니다.'],
  licenses: ['Licenses', '라이선스 생성, 연장, 이전 및 상태를 관리합니다.'],
  releases: ['Releases / Updates', 'Auto Update, Release Channel, Canary Rollout을 관리합니다.'],
  features: ['Feature Flags', '전역 기능과 Server / Client별 Override를 관리합니다.'],
  confighistory: ['Config History', 'Runtime Config와 Feature Flag 변경 이력 및 Rollback을 관리합니다.'],
  enrollment: ['Device Enrollment', '새 Server / Client의 최초 등록 승인 정책을 관리합니다.'],
  protocol: ['Protocol / Security', 'Protocol v3 준비도, Device HMAC, Event Sequence 상태를 확인합니다.'],
  security: ['Security Center', 'HMAC 검증, Enrollment, Device Secret 수명과 인증 이상을 한 화면에서 확인합니다.'],
  audit: ['Audit Log', '최근 서버 이벤트와 관리 작업 기록입니다.'],
  activity: ['Admin Activity', 'Web Admin에서 수행된 관리 작업과 결과를 추적합니다.'],
  sessions: ['Sessions', '현재 Web Admin 로그인 세션을 확인하고 종료합니다.'],
  backups: ['Backups', 'Relay 데이터베이스 백업과 복원을 관리합니다.'],
  health: ['System Health', 'Node / DB / Backup / Audit / Relay 상태를 진단합니다.'],
  loadlab: ['Load Simulator', '별도 프로세스에서 Relay 연결/프로토콜 부하 테스트 명령을 생성합니다.'],
  storage: ['Storage Migration', 'JSON 안정판을 유지한 채 SQLite 전환 준비 상태와 Migration Bundle을 관리합니다.'],
  system: ['System', '서비스, 유지보수 및 최소 버전 정책을 관리합니다.'],
  danger: ['Danger Zone', '복구 영향이 큰 작업만 별도로 실행합니다.']
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
  else if (['SLOW', 'UNSTABLE', 'DRAINING', 'KICKED', 'FLAPPING', 'WARNING'].includes(text)) cls = 'warn';
  else if (['OFFLINE', 'DISABLED', 'EXPIRED', 'SUSPENDED', 'CRITICAL'].includes(text)) cls = 'bad';
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
  document.querySelectorAll('[data-admin-only]').forEach(el => el.classList.toggle('hidden', session.role !== 'admin'));
  startEvents();
  updateNotificationBadge();
  renderCurrent();
}

function pushLiveEvent(event) {
  if (!event || !event.type) return;
  liveConsoleEvents.push(event);
  if (liveConsoleEvents.length > 500) liveConsoleEvents.shift();
  if (consolePaused || currentView !== 'console') return;
  const list = document.getElementById('live-console-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'console-line';
  row.innerHTML = `<span class="console-time">${esc(fmtTime(event.time))}</span><span class="console-type">${esc(event.type)}</span><span class="console-detail">${esc(event.detail)}</span>`;
  list.appendChild(row);
  while (list.children.length > 300) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}

function startEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('ready', () => {
    liveState.textContent = 'LIVE';
    liveState.classList.remove('off');
  });
  eventSource.addEventListener('relay-event', event => {
    try { pushLiveEvent(JSON.parse(event.data)); } catch (_) {}
  });
  eventSource.addEventListener('notification', event => {
    try {
      const item = JSON.parse(event.data);
      updateNotificationBadge();
      if (item.severity === 'CRITICAL') toast(`[${item.type}] ${item.title}`, true);
      if (currentView === 'notifications' && !rendering) renderNotifications(true);
    } catch (_) {}
  });
  eventSource.addEventListener('tick', () => {
    if (document.hidden || rendering) return;
    if (['dashboard', 'monitor', 'distribution', 'failover', 'recovery', 'servers', 'clients', 'notifications', 'sessions', 'health', 'system', 'features', 'confighistory', 'enrollment', 'releases', 'security', 'protocol', 'loadlab', 'storage', 'danger'].includes(currentView)) renderCurrent(true);
    updateNotificationBadge();
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
    else if (currentView === 'console') await renderConsole();
    else if (currentView === 'trace') await renderTrace();
    else if (currentView === 'monitor') await renderMonitor();
    else if (currentView === 'terminal') await renderTerminal();
    else if (currentView === 'distribution') await renderDistribution();
    else if (currentView === 'failover') await renderFailover();
    else if (currentView === 'recovery') await renderRecovery();
    else if (currentView === 'notifications') await renderNotifications();
    else if (currentView === 'servers') await renderServers();
    else if (currentView === 'clients') await renderClients();
    else if (currentView === 'licenses') await renderLicenses();
    else if (currentView === 'releases') await renderReleases();
    else if (currentView === 'features') await renderFeatureFlags();
    else if (currentView === 'confighistory') await renderConfigHistory();
    else if (currentView === 'enrollment') await renderEnrollment();
    else if (currentView === 'protocol') await renderProtocolSecurity();
    else if (currentView === 'security') await renderSecurityCenter();
    else if (currentView === 'audit') await renderAudit();
    else if (currentView === 'activity') await renderActivity();
    else if (currentView === 'sessions') await renderSessions();
    else if (currentView === 'backups') await renderBackups();
    else if (currentView === 'health') await renderSystemHealth();
    else if (currentView === 'loadlab') await renderLoadSimulator();
    else if (currentView === 'storage') await renderStorageMigration();
    else if (currentView === 'system') await renderSystem();
    else if (currentView === 'danger') await renderDangerZone();
  } catch (error) {
    if (!silent) content.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    toast(error.message, true);
  } finally {
    rendering = false;
  }
}


function switchView(view) {
  currentView = view;
  nav.querySelectorAll('button[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === view));
}

function svgLineChart(rows, series) {
  const width = 760, height = 190, padX = 34, padY = 20;
  const all = [];
  for (const row of rows) for (const item of series) all.push(Number(row[item.key] || 0));
  const max = Math.max(1, ...all);
  const innerW = width - padX * 2, innerH = height - padY * 2;
  const points = (key) => rows.map((row, i) => {
    const x = padX + (rows.length <= 1 ? 0 : i / (rows.length - 1) * innerW);
    const y = padY + innerH - (Number(row[key] || 0) / max * innerH);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const grid = [0,.25,.5,.75,1].map(v => { const y=(padY+innerH-innerH*v).toFixed(1); return `<line x1="${padX}" y1="${y}" x2="${width-padX}" y2="${y}" class="chart-grid"/><text x="4" y="${Number(y)+3}" class="chart-axis">${Math.round(max*v)}</text>`; }).join('');
  const lines = series.map((item, i) => `<polyline points="${points(item.key)}" class="chart-line chart-line-${i}"/>`).join('');
  return `<svg class="ops-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${grid}${lines}</svg><div class="chart-legend">${series.map((x,i)=>`<span class="legend-${i}">${esc(x.label)}</span>`).join('')}</div>`;
}

function renderStatsPanel(stats) {
  const rows = stats.buckets || [];
  return `<div class="section-card stats-panel"><div class="section-head"><h3>Traffic Statistics</h3><div class="actions"><button data-stats-range="1H" class="${statsRange==='1H'?'primary':''}">1H</button><button data-stats-range="6H" class="${statsRange==='6H'?'primary':''}">6H</button><button data-stats-range="24H" class="${statsRange==='24H'?'primary':''}">24H</button><button data-stats-range="7D" class="${statsRange==='7D'?'primary':''}">7D</button></div></div><div class="stats-grid"><div class="chart-box"><div class="chart-title">CONNECTION / SEND</div>${svgLineChart(rows,[{key:'connections',label:'Connections'},{key:'sends',label:'SEND'}])}</div><div class="chart-box"><div class="chart-title">ACK RESULT</div>${svgLineChart(rows,[{key:'ackOk',label:'ACK OK'},{key:'ackError',label:'ACK ERROR'},{key:'ackTimeout',label:'TIMEOUT'}])}</div></div><div class="stats-summary"><span>Connections <strong>${stats.totals.connections}</strong></span><span>SEND <strong>${stats.totals.sends}</strong></span><span>ACK OK <strong>${stats.totals.ackOk}</strong></span><span>Error <strong>${stats.totals.ackError}</strong></span><span>Timeout <strong>${stats.totals.ackTimeout}</strong></span><span>Success <strong>${stats.totals.ackSuccessRate}%</strong></span></div></div>`;
}

async function renderDashboard() {
  const [{ dashboard: d }, { statistics: stats }] = await Promise.all([api('/api/dashboard'), api(`/api/statistics?range=${encodeURIComponent(statsRange)}`)]);
  content.innerHTML = `
    <div class="cards">
      <div class="card"><div class="stat-label">SERVERS</div><div class="stat-value">${d.servers.online} / ${d.servers.total}</div><div class="stat-sub">Disabled ${d.servers.disabled} · Draining ${d.servers.draining}</div></div>
      <div class="card"><div class="stat-label">CLIENTS</div><div class="stat-value">${d.clients.online} / ${d.clients.total}</div><div class="stat-sub">Disabled ${d.clients.disabled}</div></div>
      <div class="card"><div class="stat-label">LICENSES</div><div class="stat-value">${d.licenses.bound}</div><div class="stat-sub">Available ${d.licenses.available} · Expired ${d.licenses.expired}</div></div>
      <div class="card"><div class="stat-label">ACK SUCCESS</div><div class="stat-value">${d.ack.successRate}%</div><div class="stat-sub">Pending ${d.ack.pending} · Timeout ${d.ack.timeout}</div></div>
      <div class="card"><div class="stat-label">ALERTS</div><div class="stat-value">${d.notifications.unread}</div><div class="stat-sub">Critical ${d.notifications.critical} · Warning ${d.notifications.warning}</div></div>
      <div class="card"><div class="stat-label">SERVICE</div><div class="stat-value">${d.serviceEnabled ? 'ONLINE' : 'OFFLINE'}</div><div class="stat-sub">Maintenance ${d.maintenanceMode ? 'ON' : 'OFF'}</div></div>
      <div class="card"><div class="stat-label">UPTIME</div><div class="stat-value">${esc(fmtDuration(d.uptimeMs))}</div><div class="stat-sub">Connections ${d.totalConnections}</div></div>
      <div class="card"><div class="stat-label">VERSION</div><div class="stat-value">P${d.versions.protocol}</div><div class="stat-sub">Server ${esc(d.versions.server)} · Client ${esc(d.versions.client)}</div></div>
      <div class="card"><div class="stat-label">RECOVERY</div><div class="stat-value">${d.recovery.queued} / ${d.recovery.deadLetters}</div><div class="stat-sub">Queue / Active DLQ · Replay ${d.recovery.replayed}</div></div>
    </div>
    ${renderStatsPanel(stats)}
    <div class="section-card"><div class="section-head"><h3>Server Distribution</h3><button data-open-view="distribution">OPEN DISTRIBUTION</button></div><div class="section-body"><p class="muted">Server별 Live/Binding Client 부하와 Graceful Drain 진행률을 확인합니다.</p></div></div>
    <div class="section-card"><div class="section-head"><h3>License Expiry Radar</h3><span class="small-note">CLICK TO FILTER</span></div><div class="section-body"><div class="expiry-grid">
      <button class="expiry-card critical" data-license-expiry="EXPIRED"><span>EXPIRED</span><strong>${d.licenseExpiry.expired}</strong></button>
      <button class="expiry-card critical" data-license-expiry="1D"><span>≤ 24 HOURS</span><strong>${d.licenseExpiry.within1d}</strong></button>
      <button class="expiry-card warning" data-license-expiry="3D"><span>≤ 3 DAYS</span><strong>${d.licenseExpiry.within3d}</strong></button>
      <button class="expiry-card warning" data-license-expiry="7D"><span>≤ 7 DAYS</span><strong>${d.licenseExpiry.within7d}</strong></button>
      <button class="expiry-card" data-license-expiry="30D"><span>≤ 30 DAYS</span><strong>${d.licenseExpiry.within30d}</strong></button>
    </div></div></div>
    <div class="grid-2">
      <div class="section-card"><div class="section-head"><h3>최근 이벤트</h3><span class="small-note">최근 30건</span></div><div class="section-body"><div class="event-list">
        ${d.recentEvents.length ? d.recentEvents.map(e => `<div class="event"><span>${esc(fmtTime(e.time))}</span><span class="type">${esc(e.type)}</span><span>${esc(e.detail)}</span></div>`).join('') : '<div class="empty">이벤트 없음</div>'}
      </div></div></div>
      <div class="section-card"><div class="section-head"><h3>License 상태</h3></div><div class="section-body"><div class="kv">
        <div>Available</div><div>${d.licenses.available}</div><div>Bound</div><div>${d.licenses.bound}</div><div>Suspended</div><div>${d.licenses.suspended}</div><div>Expired</div><div>${d.licenses.expired}</div><div>Total</div><div>${d.licenses.total}</div>
      </div></div></div>
    </div>`;
}

async function renderConsole() {
  if (!liveConsoleEvents.length) {
    const { events } = await api('/api/audit');
    liveConsoleEvents = events.slice(-300);
  }
  content.innerHTML = `<div class="terminal-panel"><div class="terminal-head"><span>LIVE_EVENT_STREAM</span><div class="actions"><button id="console-pause-btn">${consolePaused ? 'Resume' : 'Pause'}</button><button id="console-clear-btn">Clear</button></div></div><div id="live-console-list" class="live-console">${liveConsoleEvents.slice(-300).map(e => `<div class="console-line"><span class="console-time">${esc(fmtTime(e.time))}</span><span class="console-type">${esc(e.type)}</span><span class="console-detail">${esc(e.detail)}</span></div>`).join('') || '<div class="empty">이벤트 없음</div>'}</div></div>`;
  const list = document.getElementById('live-console-list');
  if (list) list.scrollTop = list.scrollHeight;
}

async function renderTrace() {
  const { traces } = await api(`/api/request-traces?query=${encodeURIComponent(traceQuery)}`);
  traceRows = new Map(traces.map(t => [t.key, t]));
  content.innerHTML = `<div class="toolbar"><input id="trace-search" placeholder="Request ID / Client / Server / Number" value="${esc(traceQuery)}"><button id="trace-search-btn">Trace</button><span class="small-note">최근 10분 / Replay는 반드시 새 Request ID 사용</span></div><div class="table-wrap"><table><thead><tr><th>Request ID</th><th>Source</th><th>Client</th><th>Server</th><th>Number</th><th>Status</th><th>Retry</th><th>Duration</th><th>Forwarded</th><th>Action</th></tr></thead><tbody>${traces.map(t => `<tr><td class="code">${esc(t.requestId)}</td><td>${esc(t.source||'CLIENT')}</td><td class="code">${esc(t.clientId)}</td><td class="code">${esc(t.serverId)}</td><td class="code">${esc(t.number)}</td><td>${badge(t.status)}</td><td>${t.retries}</td><td>${t.completedAt ? `${t.durationMs} ms` : '-'}</td><td>${esc(fmtTime(t.forwardedAt))}</td><td><div class="actions"><button data-trace-detail="${esc(t.key)}">상세</button>${roleIsAdmin()&&['ERROR','TIMEOUT','DLQ'].includes(String(t.status||'').toUpperCase())?`<button class="warning" data-trace-replay="${esc(t.key)}">REPLAY</button>`:''}</div></td></tr>`).join('') || '<tr><td colspan="10" class="empty">Trace 없음</td></tr>'}</tbody></table></div>`;
}

async function renderMonitor() {
  const [{ servers }, { clients }] = await Promise.all([api('/api/servers'), api('/api/clients')]);
  const serverGood = servers.filter(x => x.health === 'GOOD').length;
  const clientGood = clients.filter(x => x.health === 'GOOD').length;
  const problemServers = servers.filter(x => !['GOOD', 'OFFLINE'].includes(x.health)).length;
  const problemClients = clients.filter(x => !['GOOD', 'OFFLINE'].includes(x.health)).length;
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">SERVER GOOD</div><div class="stat-value">${serverGood}</div><div class="stat-sub">Problems ${problemServers}</div></div><div class="card"><div class="stat-label">CLIENT GOOD</div><div class="stat-value">${clientGood}</div><div class="stat-sub">Problems ${problemClients}</div></div><div class="card"><div class="stat-label">SERVER ONLINE</div><div class="stat-value">${servers.filter(x => x.online).length}</div><div class="stat-sub">Total ${servers.length}</div></div><div class="card"><div class="stat-label">CLIENT ONLINE</div><div class="stat-value">${clients.filter(x => x.online).length}</div><div class="stat-sub">Total ${clients.length}</div></div></div><div class="section-card monitor-section"><div class="section-head"><h3>Server Health</h3><span class="small-note">AUTO REFRESH // 3 SEC</span></div><div class="table-wrap"><table><thead><tr><th>Alias</th><th>SERVER-ID</th><th>Status</th><th>Health</th><th>RTT</th><th>ACK</th><th>Clients</th><th>Reconnect</th><th>Last Seen</th></tr></thead><tbody>${servers.map(x => `<tr><td>${esc(x.alias || '-')}</td><td class="code">${esc(x.id)}</td><td>${badge(x.status)}</td><td>${badge(x.health)}</td><td>${x.rttMs >= 0 ? `${x.rttMs} ms` : '-'}</td><td>${x.ack.successRate}% <span class="muted">(${x.ack.ok}/${x.ack.error}/${x.ack.timeout})</span></td><td>${x.clients} / ${x.savedClients}</td><td>${x.reconnectCount}</td><td>${esc(fmtTime(x.lastSeen))}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Server 없음</td></tr>'}</tbody></table></div></div><div class="section-card monitor-section"><div class="section-head"><h3>Client Health</h3><span class="small-note">AUTO REFRESH // 3 SEC</span></div><div class="table-wrap"><table><thead><tr><th>Alias</th><th>CLIENT-ID</th><th>Status</th><th>Health</th><th>RTT</th><th>ACK</th><th>Server</th><th>Send</th><th>Reconnect</th></tr></thead><tbody>${clients.map(x => `<tr><td>${esc(x.alias || '-')}</td><td class="code">${esc(x.id)}</td><td>${badge(x.status)}</td><td>${badge(x.health)}</td><td>${x.rttMs >= 0 ? `${x.rttMs} ms` : '-'}</td><td>${x.ack.successRate}% <span class="muted">(${x.ack.ok}/${x.ack.error}/${x.ack.timeout})</span></td><td class="code">${esc(x.serverAlias || x.serverId)}</td><td>${x.sendCount}</td><td>${x.reconnectCount}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Client 없음</td></tr>'}</tbody></table></div></div>`;
}


function terminalWrite(kind, text) {
  terminalLines.push({ time: Date.now(), kind: String(kind || 'out'), text: String(text || '') });
  if (terminalLines.length > 500) terminalLines = terminalLines.slice(-500);
}

function terminalTokenize(line) {
  const out = [];
  String(line || '').replace(/"([^"]*)"|'([^']*)'|([^\s]+)/g, (_, a, b, c) => { out.push(a ?? b ?? c ?? ''); return ''; });
  return out;
}

function terminalObjectLines(items, formatter, limit = 30) {
  const rows = (items || []).slice(0, limit).map(formatter);
  if ((items || []).length > limit) rows.push(`... ${(items || []).length - limit} more`);
  return rows.join('\n') || '(empty)';
}

async function executeTerminalCommand(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) return;
  terminalHistory.push(line);
  if (terminalHistory.length > 100) terminalHistory.shift();
  terminalHistoryIndex = terminalHistory.length;
  terminalWrite('cmd', `relay-admin > ${line}`);
  const a = terminalTokenize(line);
  const cmd = String(a[0] || '').toLowerCase();
  const sub = String(a[1] || '').toLowerCase();
  try {
    if (cmd === 'clear') { terminalLines = []; return; }
    if (cmd === 'help' || cmd === '?') {
      terminalWrite('ok', [
        'SAFE COMMAND SET // no OS shell',
        'status', 'server list', 'server show <id>', 'server kick|disable|enable <id>', 'server drain on|off <id>',
        'client list', 'client show <id>', 'client kick|disable|enable <id>', 'client move <clientId> <serverId>',
        'license find <query>', 'maintenance status|on|off', 'backup list|create', 'version status',
        'notice all <message>', 'open <dashboard|servers|clients|licenses|backups|health|system|danger>', 'search <query>', 'clear'
      ].join('\n'));
      return;
    }
    if (cmd === 'status') {
      const { dashboard: d } = await api('/api/dashboard');
      terminalWrite('ok', `SERVICE=${d.serviceEnabled ? 'ONLINE' : 'OFFLINE'} MAINT=${d.maintenanceMode ? 'ON' : 'OFF'} SERVERS=${d.servers.online}/${d.servers.total} CLIENTS=${d.clients.online}/${d.clients.total} ACK=${d.ack.successRate}% PENDING=${d.ack.pending}`);
      return;
    }
    if (cmd === 'server' && sub === 'list') {
      const { servers } = await api('/api/servers');
      terminalWrite('ok', terminalObjectLines(servers, s => `${s.alias || '-'} ${s.id} ${s.status}/${s.health} CLIENTS=${s.clients}/${s.savedClients}${s.drain && s.drain.active ? ` DRAIN=${s.drain.progress}%` : ''}`)); return;
    }
    if (cmd === 'server' && sub === 'show' && a[2]) {
      const { server: s } = await api(`/api/servers/${encodeURIComponent(a[2])}`);
      terminalWrite('ok', JSON.stringify({ id:s.id, alias:s.alias, status:s.status, health:s.health, clients:s.clients, savedClients:s.savedClients, rttMs:s.rttMs, drain:s.drain }, null, 2)); return;
    }
    if (cmd === 'server' && ['kick','disable','enable'].includes(sub) && a[2]) { await serverAction(sub, a[2]); terminalWrite('ok', `SERVER ${sub.toUpperCase()} OK ${a[2]}`); return; }
    if (cmd === 'server' && sub === 'drain' && ['on','off'].includes(String(a[2]||'').toLowerCase()) && a[3]) { await serverAction(`drain-${String(a[2]).toLowerCase()}`, a[3]); terminalWrite('ok', `SERVER DRAIN ${String(a[2]).toUpperCase()} OK ${a[3]}`); return; }
    if (cmd === 'client' && sub === 'list') {
      const { clients } = await api('/api/clients');
      terminalWrite('ok', terminalObjectLines(clients, c => `${c.alias || '-'} ${c.id} ${c.status}/${c.health} SERVER=${c.serverAlias || c.serverId} LICENSE=${c.licenseStatus}`)); return;
    }
    if (cmd === 'client' && sub === 'show' && a[2]) {
      const { client: c } = await api(`/api/clients/${encodeURIComponent(a[2])}`);
      terminalWrite('ok', JSON.stringify({ id:c.id, alias:c.alias, status:c.status, health:c.health, serverId:c.serverId, licenseStatus:c.licenseStatus, rttMs:c.rttMs }, null, 2)); return;
    }
    if (cmd === 'client' && ['kick','disable','enable'].includes(sub) && a[2]) { await clientAction(sub, a[2]); terminalWrite('ok', `CLIENT ${sub.toUpperCase()} OK ${a[2]}`); return; }
    if (cmd === 'client' && sub === 'move' && a[2] && a[3]) { await api(`/api/clients/${encodeURIComponent(a[2])}/move`, { method:'POST', body:{ serverId:a[3] } }); terminalWrite('ok', `CLIENT MOVE OK ${a[2]} -> ${a[3]}`); return; }
    if (cmd === 'license' && sub === 'find') {
      const q = a.slice(2).join(' '); const { licenses } = await api(`/api/licenses?query=${encodeURIComponent(q)}&status=ALL&expiry=ALL`);
      terminalWrite('ok', terminalObjectLines(licenses, x => `${x.key} ${x.status} CLIENT=${x.boundClient || '-'} TAGS=${(x.tags||[]).join(',') || '-'}`)); return;
    }
    if (cmd === 'maintenance' && sub === 'status') { const { system:s }=await api('/api/system'); terminalWrite('ok', `MAINTENANCE=${s.maintenanceMode?'ON':'OFF'} SERVICE=${s.serviceEnabled?'ONLINE':'OFFLINE'} SCHEDULE=${s.maintenanceSchedule?`${fmtTime(s.maintenanceSchedule.startAt)} -> ${fmtTime(s.maintenanceSchedule.endAt)}`:'NONE'}`); return; }
    if (cmd === 'maintenance' && ['on','off'].includes(sub)) { await api(`/api/system/maintenance/${sub}`, {method:'POST',body:{}}); terminalWrite('ok', `MAINTENANCE ${sub.toUpperCase()} OK`); return; }
    if (cmd === 'backup' && sub === 'list') { const {backups}=await api('/api/backups'); terminalWrite('ok', terminalObjectLines(backups, b=>`${b.file} ${fmtBytes(b.size)} ${fmtTime(b.mtimeMs)}`)); return; }
    if (cmd === 'backup' && sub === 'create') { const r=await api('/api/backups/create',{method:'POST',body:{}}); terminalWrite('ok', `BACKUP CREATED ${r.file}`); return; }
    if (cmd === 'version' && sub === 'status') { const {system:s}=await api('/api/system'); terminalWrite('ok', `PROTOCOL=${s.minProtocolVersion}/${s.currentProtocolVersion} SERVER>=${s.minServerVersion} CLIENT>=${s.minClientVersion} WEB=${s.webAdminVersion}`); return; }
    if (cmd === 'notice' && sub === 'all' && a.length >= 3) { const message=a.slice(2).join(' '); const r=await api('/api/system/notice',{method:'POST',body:{message}}); terminalWrite('ok', `NOTICE SENT ${r.count}`); return; }
    if (cmd === 'open' && a[1]) { const view=String(a[1]).toLowerCase(); if (!titles[view]) throw new Error('UNKNOWN_VIEW'); if (view==='danger'&&!roleIsAdmin()) throw new Error('FORBIDDEN'); switchView(view); await renderCurrent(); return; }
    if (cmd === 'search' && a.length >= 2) { openPalette(); const q=a.slice(1).join(' '); const input=document.getElementById('palette-input'); if(input){input.value=q; await runPaletteSearch(q);} return; }
    throw new Error('UNKNOWN_COMMAND // type help');
  } catch (error) {
    terminalWrite('error', error.message || String(error));
  }
}

async function renderTerminal() {
  if (!terminalLines.length) terminalWrite('ok', 'RELAY SAFE COMMAND TERMINAL // type help // OS SHELL DISABLED');
  content.innerHTML = `<div class="terminal-panel command-terminal"><div class="terminal-head"><span>RELAY_COMMAND_CHANNEL // ALLOWLIST ONLY</span><div class="actions"><button id="terminal-help-btn">Help</button><button id="terminal-clear-btn">Clear</button></div></div><div id="command-terminal-output" class="command-terminal-output">${terminalLines.map(x=>`<div class="terminal-output-line ${esc(x.kind)}"><span>${esc(fmtTime(x.time))}</span><pre>${esc(x.text)}</pre></div>`).join('')}</div><form id="command-terminal-form" class="command-terminal-form"><span>relay-admin &gt;</span><input id="command-terminal-input" autocomplete="off" spellcheck="false" placeholder="help"><button class="primary" type="submit">EXEC</button></form><div class="terminal-safety">ALLOWLIST COMMANDS ONLY // NO PROCESS EXEC // NO SHELL // API PERMISSIONS STILL ENFORCED</div></div>`;
  const output=document.getElementById('command-terminal-output'); if(output) output.scrollTop=output.scrollHeight;
  const input=document.getElementById('command-terminal-input'); if(input) setTimeout(()=>input.focus(),10);
}

function distributionBar(value, max, cls='live') {
  const pct = Math.max(0, Math.min(100, max > 0 ? (Number(value||0)/max)*100 : 0));
  return `<div class="distribution-meter"><i class="${esc(cls)}" style="width:${pct.toFixed(1)}%"></i></div><span class="distribution-pct">${pct.toFixed(1)}%</span>`;
}

async function renderDistribution() {
  const [{ servers }, { system }] = await Promise.all([api('/api/servers'), api('/api/system')]);
  const max = Number(system.maxClientsPerServer || 1);
  const sorted = [...servers].sort((a,b)=>b.savedClients-a.savedClients || b.clients-a.clients);
  const totalLive=sorted.reduce((n,x)=>n+x.clients,0), totalSaved=sorted.reduce((n,x)=>n+x.savedClients,0);
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">TOTAL LIVE</div><div class="stat-value">${totalLive}</div><div class="stat-sub">Active Client sockets</div></div><div class="card"><div class="stat-label">TOTAL BINDINGS</div><div class="stat-value">${totalSaved}</div><div class="stat-sub">Persistent Client → Server</div></div><div class="card"><div class="stat-label">CAPACITY</div><div class="stat-value">${sorted.length*max}</div><div class="stat-sub">${max} / Server</div></div><div class="card"><div class="stat-label">DRAINING</div><div class="stat-value">${sorted.filter(x=>x.drain&&x.drain.active).length}</div><div class="stat-sub">Ready ${sorted.filter(x=>x.drain&&x.drain.ready).length}</div></div></div><div class="section-card"><div class="section-head"><h3>Server Client Distribution</h3><span class="small-note">AUTO REFRESH // 3 SEC</span></div><div class="distribution-list">${sorted.map(s=>`<div class="distribution-row"><div class="distribution-id"><strong>${esc(s.alias||s.id)}</strong><small>${esc(s.id)}</small>${badge(s.status)} ${badge(s.health)}</div><div class="distribution-load"><label>LIVE <b>${s.clients}/${max}</b></label>${distributionBar(s.clients,max,'live')}<label>BINDINGS <b>${s.savedClients}/${max}</b></label>${distributionBar(s.savedClients,max,'saved')}</div><div class="distribution-drain">${s.drain&&s.drain.active?`<div class="drain-label">DRAIN // ${s.drain.ready?'<strong>READY FOR MAINTENANCE</strong>':`${s.drain.currentClients} ACTIVE`}</div><div class="drain-progress"><i style="width:${s.drain.progress}%"></i></div><div class="small-note">${s.drain.progress}% // start ${esc(fmtTime(s.drain.startedAt))} // initial ${s.drain.initialClients}</div>`:`<span class="small-note">ACCEPT CLIENTS: ${s.canAcceptClients?'YES':'NO'}</span>`}</div>${roleIsAdmin()?`<div class="actions">${s.drain&&s.drain.active?`<button data-server-action="drain-off" data-id="${esc(s.id)}">Drain OFF</button>`:`<button data-server-action="drain-on" data-id="${esc(s.id)}">Drain ON</button>`}</div>`:''}</div>`).join('')||'<div class="empty">Server 없음</div>'}</div></div>`;
}


async function renderFailover() {
  const [{ failover:f }, { servers }] = await Promise.all([api('/api/failover'), api('/api/servers')]);
  failoverServers = servers || [];
  failoverRows = new Map((f.clients||[]).map(x=>[x.clientId,x]));
  const p=f.policy||{}, sum=f.summary||{};
  const rows=(f.clients||[]).map(c=>{
    const stateLabel=c.failedOver?'FAILED_OVER':(c.enabled?'ARMED':'OFF');
    const action=roleIsAdmin()?`<div class="actions"><button data-binding-edit="${esc(c.clientId)}">Binding</button>${c.bindingConfigured?`<button data-binding-clear="${esc(c.clientId)}">Clear</button>`:''}<button data-failover-toggle="${esc(c.clientId)}" data-enabled="${c.enabled?'0':'1'}">${c.enabled?'Opt-out':'Opt-in'}</button>${c.failedOver?`<button class="warning" data-failover-return="${esc(c.clientId)}">Return Primary</button>`:''}</div>`:'-';
    return `<tr><td class="code">${esc(c.clientId)}</td><td>${badge(stateLabel)}</td><td>${c.bindingConfigured?badge('CONFIGURED'):badge('AUTO')}</td><td class="code">${esc(c.primaryServerId||'-')}</td><td class="code">${esc(c.backupServerId||'-')}</td><td class="code">${esc(c.currentServerId||'-')}</td><td>${badge(c.primaryStatus||'UNKNOWN')}</td><td>${badge(c.backupStatus||'NOT_CONFIGURED')}</td><td>${c.allowAutomaticFallback?'YES':'NO'}</td><td>${c.moveCount||0}</td><td>${esc(c.selectedBy||c.reason||'-')}</td><td>${esc(fmtTime(c.failedOverAt))}</td><td>${action}</td></tr>`;
  }).join('');
  content.innerHTML=`<div class="cards">
    <div class="card"><div class="stat-label">GLOBAL POLICY</div><div class="stat-value">${p.enabled?'ON':'OFF'}</div><div class="stat-sub">기본 OFF · opt-in only</div></div>
    <div class="card"><div class="stat-label">OPT-IN CLIENTS</div><div class="stat-value">${sum.optedIn||0}</div><div class="stat-sub">Total ${sum.totalClients||0}</div></div>
    <div class="card"><div class="stat-label">FAILED OVER</div><div class="stat-value">${sum.failedOver||0}</div><div class="stat-sub">temporary bindings</div></div>
    <div class="card"><div class="stat-label">PRIMARY DOWN</div><div class="stat-value">${sum.primaryUnavailable||0}</div><div class="stat-sub">armed / waiting grace</div></div>
    <div class="card"><div class="stat-label">EXPLICIT BINDINGS</div><div class="stat-value">${sum.configuredBindings||0}</div><div class="stat-sub">Primary + Backup policy</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>Emergency Failover Policy</h3><span class="small-note">Primary binding preserved // Drain does not trigger failover</span></div><div class="section-body">
    <div class="form-grid">
      <label>Global<select id="failover-policy-enabled"><option value="0" ${p.enabled?'':'selected'}>OFF</option><option value="1" ${p.enabled?'selected':''}>ON</option></select></label>
      <label>Auto Return<select id="failover-auto-return"><option value="1" ${p.autoReturn?'selected':''}>ON</option><option value="0" ${p.autoReturn?'':'selected'}>OFF</option></select></label>
      <label>Offline Grace (sec)<input id="failover-offline-grace" type="number" min="0" max="3600" value="${Number(p.offlineGraceSeconds||15)}"></label>
      <label>Return Grace (sec)<input id="failover-return-grace" type="number" min="0" max="3600" value="${Number(p.returnGraceSeconds||30)}"></label>
      <label>Max Moves / Cycle<input id="failover-max-moves" type="number" min="1" max="1000" value="${Number(p.maxMovesPerCycle||50)}"></label>
    </div>
    ${roleIsAdmin()?'<div class="toolbar"><button id="failover-policy-save" class="primary">SAVE POLICY</button><button id="failover-run-now">EVALUATE NOW</button></div>':''}
    <div class="warning-box">Emergency Failover는 기존 고정 SERVER-ID를 삭제하지 않습니다. Failover record에 Primary를 보존하고, 장애 시에만 임시 Binding으로 이동합니다. Maintenance 중에는 자동 이동을 멈춥니다.</div>
  </div></div>
  <div class="section-card"><div class="section-head"><h3>Primary / Backup Binding Matrix</h3><span class="small-note">명시적 Backup 우선 · 선택적으로 자동 대체</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Client</th><th>Mode</th><th>Binding</th><th>Primary</th><th>Backup</th><th>Current</th><th>Primary Status</th><th>Backup Status</th><th>Auto Fallback</th><th>Moves</th><th>Selection</th><th>Failed At</th><th>Action</th></tr></thead><tbody>${rows||'<tr><td colspan="13" class="empty">Client 없음</td></tr>'}</tbody></table></div></div></div>`;
}

async function renderRecovery() {
  const { recovery:r } = await api(`/api/request-recovery?query=${encodeURIComponent(recoveryQuery)}`);
  const p=r.policy||{}, s=r.summary||{};
  const clientRows=(r.clients||[]).map(x=>`<tr><td class="code">${esc(x.clientId)}</td><td class="code">${esc(x.serverId)}</td><td>${badge(x.enabled?'ON':'OFF')}</td><td>${x.queued}</td><td>${x.deadLetters}</td><td>${roleIsAdmin()?`<button data-queue-toggle="${esc(x.clientId)}" data-enabled="${x.enabled?'0':'1'}">${x.enabled?'Disable':'Enable'}</button>`:'-'}</td></tr>`).join('');
  const queueRows=(r.queue||[]).map(x=>`<tr><td class="code">${esc(x.queueId)}</td><td class="code">${esc(x.requestId)}</td><td class="code">${esc(x.clientId)}</td><td class="code">${esc(x.serverId||'-')}</td><td class="code">${esc(x.number)}</td><td>${x.attempts}</td><td>${esc(x.reason)}</td><td>${esc(fmtTime(x.queuedAt))}</td><td>${esc(fmtTime(x.expiresAt))}</td></tr>`).join('');
  const dlqRows=(r.deadLetters||[]).map(x=>`<tr><td class="code">${esc(x.deadLetterId)}</td><td>${badge(x.status)}</td><td class="code">${esc(x.originalRequestId)}</td><td class="code">${esc(x.clientId)}</td><td class="code">${esc(x.serverId||'-')}</td><td class="code">${esc(x.number)}</td><td>${esc(x.reason)}</td><td>${x.attempts}</td><td>${esc(fmtTime(x.failedAt))}</td><td>${x.status==='ACTIVE'&&roleIsAdmin()?`<div class="actions"><button class="warning" data-dlq-retry="${esc(x.deadLetterId)}">RETRY</button><button data-dlq-discard="${esc(x.deadLetterId)}">DISCARD</button></div>`:(x.lastReplayRequestId?`<span class="code">${esc(x.lastReplayRequestId)}</span>`:'-')}</td></tr>`).join('');
  content.innerHTML=`<div class="cards">
    <div class="card"><div class="stat-label">OFFLINE QUEUE</div><div class="stat-value">${p.enabled?'ON':'OFF'}</div><div class="stat-sub">opt-in clients ${s.enabledClients||0}</div></div>
    <div class="card"><div class="stat-label">QUEUED</div><div class="stat-value">${s.queued||0}</div><div class="stat-sub">ordered per Client</div></div>
    <div class="card"><div class="stat-label">ACTIVE DLQ</div><div class="stat-value">${s.activeDeadLetters||0}</div><div class="stat-sub">operator action required</div></div>
    <div class="card"><div class="stat-label">RESOLVED DLQ</div><div class="stat-value">${(s.replayedDeadLetters||0)+(s.discardedDeadLetters||0)}</div><div class="stat-sub">Replay ${s.replayedDeadLetters||0} · Discard ${s.discardedDeadLetters||0}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>Offline Queue Policy</h3><span class="small-note">기본 OFF · Client별 opt-in · FIFO</span></div><div class="section-body"><div class="form-grid">
    <label>Global<select id="queue-policy-enabled"><option value="0" ${p.enabled?'':'selected'}>OFF</option><option value="1" ${p.enabled?'selected':''}>ON</option></select></label>
    <label>Max / Client<input id="queue-policy-max" type="number" min="1" max="1000" value="${Number(p.maxItemsPerClient||100)}"></label>
    <label>TTL (sec)<input id="queue-policy-ttl" type="number" min="30" max="604800" value="${Number(p.ttlSeconds||3600)}"></label>
    <label>Delivery Attempts<input id="queue-policy-attempts" type="number" min="1" max="50" value="${Number(p.maxDeliveryAttempts||5)}"></label>
  </div>${roleIsAdmin()?'<div class="toolbar"><button id="queue-policy-save" class="primary">SAVE POLICY</button></div>':''}<div class="warning-box">Queue는 Client별 입력 순서를 보존합니다. 재전송에는 동일 Request ID를 사용해 WinSockServer RequestCache의 중복 처리 방지를 유지합니다.</div></div></div>
  <div class="section-card"><div class="section-head"><h3>Client Queue Opt-in</h3></div><div class="table-wrap"><table><thead><tr><th>Client</th><th>Current Server</th><th>Queue</th><th>Queued</th><th>Active DLQ</th><th>Action</th></tr></thead><tbody>${clientRows||'<tr><td colspan="6" class="empty">Client 없음</td></tr>'}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>Offline Queue</h3><span class="small-note">서버 복구 후 자동 전달</span></div><div class="table-wrap"><table><thead><tr><th>Queue ID</th><th>Request</th><th>Client</th><th>Target</th><th>Number</th><th>Attempts</th><th>Reason</th><th>Queued At</th><th>Expires</th></tr></thead><tbody>${queueRows||'<tr><td colspan="9" class="empty">Queued Request 없음</td></tr>'}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>Dead Letter Queue</h3><div class="actions"><input id="recovery-search" placeholder="DLQ / Request / Client / Reason" value="${esc(recoveryQuery)}"><button id="recovery-search-btn">SEARCH</button></div></div><div class="table-wrap"><table><thead><tr><th>DLQ ID</th><th>Status</th><th>Original Request</th><th>Client</th><th>Server</th><th>Number</th><th>Reason</th><th>Attempts</th><th>Failed At</th><th>Action / Replay</th></tr></thead><tbody>${dlqRows||'<tr><td colspan="10" class="empty">Dead Letter 없음</td></tr>'}</tbody></table></div></div>`;
}

async function renderDangerZone() {
  if (!roleIsAdmin()) { content.innerHTML='<div class="empty">FORBIDDEN</div>'; return; }
  const [{ system:s }, { backups }, { licenses }] = await Promise.all([api('/api/system'), api('/api/backups'), api('/api/licenses?status=ALL&expiry=ALL')]);
  content.innerHTML = `<div class="danger-banner"><strong>!! DANGER ZONE !!</strong><span>위험 작업은 영향 범위를 확인한 뒤 Web 모달에서 한 번 더 승인합니다. 별도 확인 문구 입력은 사용하지 않습니다.</span></div><div class="danger-grid">
    <div class="section-card danger-card"><div class="section-head"><h3>Service Stop</h3>${badge(s.serviceEnabled?'ONLINE':'OFFLINE')}</div><div class="section-body"><p class="muted">모든 Client 인증을 해제하고 Relay 서비스를 중지합니다.</p><button id="danger-service-stop" class="danger">STOP SERVICE</button></div></div>
    <div class="section-card danger-card"><div class="section-head"><h3>Backup Restore / Delete</h3><span class="small-note">${backups.length} FILES</span></div><div class="section-body"><label>Backup<select id="danger-backup-file">${backups.map(b=>`<option value="${esc(b.file)}">${esc(b.file)} // ${esc(fmtBytes(b.size))}</option>`).join('')}</select></label><div class="actions"><button id="danger-backup-restore" class="danger" ${backups.length?'':'disabled'}>RESTORE BACKUP</button><button id="danger-backup-delete" class="danger" ${backups.length?'':'disabled'}>DELETE BACKUP</button></div></div></div>
    <div class="section-card danger-card"><div class="section-head"><h3>Version Force Apply</h3><span class="small-note">CURRENT P${s.currentProtocolVersion}</span></div><div class="section-body"><div class="form-grid"><label>Protocol<input id="danger-version-protocol" type="number" min="1" max="${s.currentProtocolVersion}" value="${s.minProtocolVersion}"></label><label>Server<input id="danger-version-server" value="${esc(s.minServerVersion)}"></label><label>Client<input id="danger-version-client" value="${esc(s.minClientVersion)}"></label></div><button id="danger-version-apply" class="danger">APPLY VERSION POLICY</button></div></div>
    <div class="section-card danger-card"><div class="section-head"><h3>Bulk License Delete</h3><span class="small-note">${licenses.length} TOTAL</span></div><div class="section-body"><p class="muted">License Key를 줄바꿈/쉼표로 입력합니다. 최대 500개.</p><label>License Keys<textarea id="danger-license-keys" placeholder="KEY1\nKEY2"></textarea></label><button id="danger-license-delete" class="danger">DELETE LICENSES</button></div></div>
  </div><div class="section-card danger-card future-danger"><div class="section-head"><h3>Database Reset</h3>${badge('DISABLED')}</div><div class="section-body"><p class="muted">의도적으로 구현하지 않았습니다. DB 삭제/초기화는 Web Admin에서 제공하지 않습니다.</p></div></div>`;
}

async function updateNotificationBadge() {
  if (!session || !notificationBadge) return;
  try {
    const { summary } = await api('/api/notifications?limit=1');
    notificationBadge.textContent = summary.unread > 99 ? '99+' : String(summary.unread);
    notificationBadge.classList.toggle('hidden', summary.unread <= 0);
    notificationBadge.classList.toggle('critical', summary.critical > 0);
  } catch (_) {}
}

async function renderNotifications(silent = false) {
  const { summary, notifications } = await api('/api/notifications?limit=300');
  if (!silent) updateNotificationBadge();
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">UNREAD</div><div class="stat-value">${summary.unread}</div><div class="stat-sub">Total ${summary.total}</div></div><div class="card"><div class="stat-label">CRITICAL</div><div class="stat-value">${summary.critical}</div><div class="stat-sub">Immediate attention</div></div><div class="card"><div class="stat-label">WARNING</div><div class="stat-value">${summary.warning}</div><div class="stat-sub">Operational warnings</div></div></div>
  <div class="toolbar"><button id="notification-read-all-btn">모두 읽음</button>${roleIsAdmin() ? '<button id="notification-clear-btn" class="danger">전체 지우기</button>' : ''}<span class="small-note">ACK timeout / Server offline / Flapping / License expiry / DB recovery</span></div>
  <div class="notification-list">${notifications.map(n => `<div class="notification-item ${n.read ? 'read' : 'unread'} ${esc(n.severity.toLowerCase())}"><div class="notification-icon">${n.severity === 'CRITICAL' ? '!' : n.severity === 'WARNING' ? '▲' : '•'}</div><div class="notification-main"><div class="notification-title">${badge(n.severity)} <strong>${esc(n.title)}</strong> ${n.count > 1 ? `<span class="nav-count">×${n.count}</span>` : ''}</div><div class="notification-message">${esc(n.message)}</div><div class="small-note">${esc(n.type)} // ${esc(fmtTime(n.updatedAt || n.createdAt))}${n.entityId ? ` // ${esc(n.entityId)}` : ''}</div></div>${!n.read ? `<button data-notification-read="${esc(n.id)}">읽음</button>` : ''}</div>`).join('') || '<div class="empty">알림 없음</div>'}</div>`;
}

async function renderServers() {
  const { servers } = await api('/api/servers');
  const actions = server => {
    const id = esc(server.id);
    const detail = `<button data-server-action="detail" data-id="${id}">상세</button>`;
    const note = roleCanOperate() ? `<button data-server-action="note" data-id="${id}">Note</button>` : '';
    if (!roleIsAdmin()) return `<div class="actions">${detail}${note}</div>`;
    const alias = `<button data-server-action="alias" data-id="${id}">Alias</button>`;

    const kick = server.online && server.status !== 'DISABLED' ? `<button class="warning" data-server-action="kick" data-id="${id}">Kick 60s</button>` : '';
    const drain = server.status === 'DRAINING'
      ? `<button data-server-action="drain-off" data-id="${id}">Drain OFF</button>`
      : server.status !== 'DISABLED' ? `<button data-server-action="drain-on" data-id="${id}">Drain ON</button>` : '';
    const enabled = server.status === 'DISABLED'
      ? `<button class="primary" data-server-action="enable" data-id="${id}">Enable</button>`
      : `<button class="danger" data-server-action="disable" data-id="${id}">Disable</button>`;
    return `<div class="actions">${detail}${alias}${note}${kick}${drain}${enabled}</div>`;
  };

  content.innerHTML = `<div class="toolbar"><span class="small-note">Kick은 60초 임시 차단 · Drain은 신규 Client 배정만 중지 · Disable은 Enable 전까지 차단</span></div><div class="table-wrap"><table><thead><tr><th>Alias</th><th>SERVER-ID</th><th>Status</th><th>Health</th><th>Accept</th><th>Clients</th><th>Drain</th><th>RTT</th><th>Version</th><th>IP</th><th>Last Seen</th><th>Reconnect</th><th>Note</th><th>Action</th></tr></thead><tbody>
    ${servers.map(s => `<tr><td>${esc(s.alias || '-')}</td><td class="code">${esc(s.id)}</td><td>${badge(s.status)}</td><td>${badge(s.health)}</td><td>${s.canAcceptClients ? badge('ONLINE') : badge('OFFLINE')}</td><td>${s.clients} / ${s.savedClients}</td><td>${s.drain && s.drain.active ? `<div class="drain-inline"><strong>${s.drain.ready ? 'READY' : `${s.drain.progress}%`}</strong><span>${s.drain.currentClients} live</span></div>` : '-'}</td><td>${s.rttMs >= 0 ? `${s.rttMs} ms` : '-'}</td><td>${esc(s.appVersion || '-')}</td><td>${esc(s.lastIP || '-')}</td><td>${esc(fmtTime(s.lastSeen))}</td><td>${s.reconnectCount}</td><td class="note-cell" title="${esc(s.note || '')}">${esc(s.note || '-')}</td><td>${actions(s)}</td></tr>`).join('') || '<tr><td colspan="15" class="empty">Server 없음</td></tr>'}
  </tbody></table></div>`;
}

async function renderClients() {
  const { clients } = await api('/api/clients');
  const actions = client => {
    const id = esc(client.id);
    let html = `<button data-client-action="detail" data-id="${id}">상세</button>`;
    if (roleCanOperate() && client.online) html += `<button data-client-action="notice" data-id="${id}">Notice</button>`;
    if (roleCanOperate()) html += `<button data-client-action="note" data-id="${id}">Note</button>`;
    if (roleIsAdmin()) {
      html += `<button data-client-action="alias" data-id="${id}">Alias</button>`;
      html += `<button data-client-action="move" data-id="${id}">Move</button>`;
      if (client.online && client.status !== 'DISABLED') html += `<button class="warning" data-client-action="kick" data-id="${id}">Kick 60s</button>`;
      html += client.status === 'DISABLED'
        ? `<button class="primary" data-client-action="enable" data-id="${id}">Enable</button>`
        : `<button class="danger" data-client-action="disable" data-id="${id}">Disable</button>`;
    }
    return `<div class="actions">${html}</div>`;
  };

  content.innerHTML = `<div class="toolbar"><span class="small-note">Kick은 60초 임시 차단 · Disable은 Enable 전까지 재접속 차단</span></div><div class="table-wrap"><table><thead><tr><th>Alias</th><th>CLIENT-ID</th><th>Status</th><th>Health</th><th>Server</th><th>License</th><th>Expires</th><th>RTT</th><th>Send</th><th>Last Seen</th><th>Note</th><th>Action</th></tr></thead><tbody>
    ${clients.map(c => `<tr><td>${esc(c.alias || '-')}</td><td class="code">${esc(c.id)}</td><td>${badge(c.status)}</td><td>${badge(c.health)}</td><td class="code">${esc(c.serverAlias || c.serverId)}</td><td>${badge(c.licenseStatus)}</td><td>${esc(fmtTime(c.licenseExpiresAt))}</td><td>${c.rttMs >= 0 ? `${c.rttMs} ms` : '-'}</td><td>${c.sendCount}</td><td>${esc(fmtTime(c.lastSeenAt))}</td><td class="note-cell" title="${esc(c.note || '')}">${esc(c.note || '-')}</td><td>${actions(c)}</td></tr>`).join('') || '<tr><td colspan="12" class="empty">Client 없음</td></tr>'}
  </tbody></table></div>`;
}

async function renderLicenses() {
  const q = encodeURIComponent(licenseQuery);
  const s = encodeURIComponent(licenseStatus);
  const e = encodeURIComponent(licenseExpiry);
  const { licenses } = await api(`/api/licenses?query=${q}&status=${s}&expiry=${e}`);
  const operator = roleCanOperate();
  const tagsHtml = tags => (tags || []).length ? tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join('') : '<span class="muted">-</span>';
  content.innerHTML = `
    <div class="toolbar">
      <input id="license-search" placeholder="Key / Client / Memo / Tag 검색 · tag:VIP" value="${esc(licenseQuery)}">
      <select id="license-status"><option>ALL</option><option>AVAILABLE</option><option>BOUND</option><option>SUSPENDED</option><option>EXPIRED</option></select>
      <select id="license-expiry"><option value="ALL">ALL EXPIRY</option><option value="EXPIRED">EXPIRED</option><option value="1D">≤ 24H</option><option value="3D">≤ 3D</option><option value="7D">≤ 7D</option><option value="30D">≤ 30D</option></select>
      <button id="license-search-btn">검색</button>
      ${roleIsAdmin() ? '<button id="license-create-btn" class="primary">+ License 생성</button>' : ''}
      ${operator ? '<button id="license-bulk-btn">선택 작업</button>' : ''}
    </div>
    <div class="table-wrap"><table><thead><tr><th><input id="license-check-all" type="checkbox"></th><th>KEY</th><th>Status</th><th>Client</th><th>Expires</th><th>Tags</th><th>Memo</th><th>Auth</th><th>Send</th><th>Action</th></tr></thead><tbody>
      ${licenses.map(l => `<tr><td><input class="license-check" type="checkbox" data-key="${esc(l.key)}" ${selectedLicenses.has(l.key) ? 'checked' : ''}></td><td class="code">${esc(l.key)}</td><td>${badge(l.status)}</td><td class="code">${esc(l.boundClient || '-')}</td><td>${esc(fmtTime(l.expiresAt))}</td><td><div class="tag-list">${tagsHtml(l.tags)}</div></td><td>${esc(l.memo || '-')}</td><td>${l.authCount}</td><td>${l.sendCount}</td><td><div class="actions">${operator ? `<button data-license-action="tags" data-key="${esc(l.key)}">Tags</button><button data-license-action="extend" data-key="${esc(l.key)}">연장</button><button data-license-action="unbind" data-key="${esc(l.key)}">Unbind</button><button data-license-action="suspend" data-key="${esc(l.key)}">Suspend</button><button data-license-action="resume" data-key="${esc(l.key)}">Resume</button><button data-license-action="transfer" data-key="${esc(l.key)}">Transfer</button>` : ''}${roleCanOperate() ? `<button data-license-action="qr" data-key="${esc(l.key)}">QR</button>` : ''}${roleIsAdmin() ? `<button data-license-action="reissue" data-key="${esc(l.key)}">Reissue</button><button class="danger" data-license-action="delete" data-key="${esc(l.key)}">Delete</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="10" class="empty">License 없음</td></tr>'}
    </tbody></table></div>`;
  document.getElementById('license-status').value = licenseStatus;
  document.getElementById('license-expiry').value = licenseExpiry;
}


function flagSelect(name, value) {
  const v = value === true ? 'ON' : value === false ? 'OFF' : 'INHERIT';
  return `<select data-flag-name="${esc(name)}"><option value="INHERIT" ${v==='INHERIT'?'selected':''}>INHERIT</option><option value="ON" ${v==='ON'?'selected':''}>ON</option><option value="OFF" ${v==='OFF'?'selected':''}>OFF</option></select>`;
}


async function renderReleases() {
  const { releases:r } = await api('/api/releases');
  const relMap = new Map((r.releases || []).map(x => [`${x.type}:${x.channel}`, x]));
  const releaseRows = ['SERVER','CLIENT'].flatMap(type => ['STABLE','BETA','TEST'].map(channel => {
    const x=relMap.get(`${type}:${channel}`);
    return `<tr><td>${type}</td><td>${channel}</td><td>${x?esc(x.version):'-'}</td><td>${x?fmtBytes(x.size):'-'}</td><td>${x?`${x.rolloutPercent}%`:'-'}</td><td>${x?badge(x.enabled?'ONLINE':'OFFLINE'):'-'}</td><td>${x?`<code>${esc(String(x.sha256||'').slice(0,16))}...</code>`:'-'}</td><td>${x?`<div class="actions"><button data-release-rollout data-type="${type}" data-channel="${channel}">ROLLOUT</button><button data-release-toggle data-type="${type}" data-channel="${channel}" data-enabled="${x.enabled?'0':'1'}">${x.enabled?'PAUSE':'ENABLE'}</button><button data-release-push data-type="${type}" data-channel="${channel}">PUSH</button></div>`:'-'}</td></tr>`;
  })).join('');
  const assignments=(r.assignments||[]).map(d=>`<tr><td>${d.type}</td><td><code>${esc(d.id)}</code></td><td>${d.online?badge('ONLINE'):badge('OFFLINE')}</td><td>${esc(d.currentVersion||'-')}</td><td><select data-release-channel-select data-type="${d.type}" data-id="${d.id}">${['STABLE','BETA','TEST'].map(ch=>`<option value="${ch}" ${ch===d.channel?'selected':''}>${ch}</option>`).join('')}</select></td><td>${d.bucket}</td><td>${d.update&&d.update.available?badge('UPDATE'):esc(d.update&&d.update.reason||'-')}<div class="small-note code">${d.updateStatus?esc(`${d.updateStatus.version||''} ${d.updateStatus.status||''}`):''}</div></td><td><button data-release-device-push data-type="${d.type}" data-id="${d.id}">CHECK/PUSH</button></td></tr>`).join('');
  content.innerHTML=`
    <div class="section-card"><div class="section-head"><h3>Publish Release</h3><span class="small-note">Admin upload / SHA-256 / signed download URL</span></div><div class="section-body">
      <div class="form-grid release-upload-grid">
        <label>Target<select id="release-type"><option>SERVER</option><option>CLIENT</option></select></label>
        <label>Channel<select id="release-channel"><option>STABLE</option><option>BETA</option><option>TEST</option></select></label>
        <label>Version<input id="release-version" value="2.1.0" placeholder="2.1.0"></label>
        <label>Canary %<input id="release-rollout" type="number" min="0" max="100" value="100"></label>
        <label>Mandatory<select id="release-mandatory"><option value="0">NO</option><option value="1">YES</option></select></label>
        <label>Artifact<input id="release-file" type="file" accept=".zip,.exe,.apk"></label>
      </div>
      <label>Release Notes<input id="release-notes" placeholder="변경사항 / 주의사항"></label>
      <div class="actions"><button id="release-upload-btn" class="primary">UPLOAD & PUBLISH</button><span id="release-upload-status" class="muted"></span></div>
    </div></div>
    <div class="section-card"><div class="section-head"><h3>Release Matrix</h3></div><div class="table-wrap"><table><thead><tr><th>TYPE</th><th>CHANNEL</th><th>VERSION</th><th>SIZE</th><th>CANARY</th><th>STATE</th><th>SHA-256</th><th>ACTION</th></tr></thead><tbody>${releaseRows}</tbody></table></div></div>
    <div class="section-card"><div class="section-head"><h3>Device Release Channel</h3><span class="small-note">Deterministic Canary bucket 0-99</span></div><div class="table-wrap"><table><thead><tr><th>TYPE</th><th>ID</th><th>LINK</th><th>VERSION</th><th>CHANNEL</th><th>BUCKET</th><th>UPDATE</th><th>ACTION</th></tr></thead><tbody>${assignments||'<tr><td colspan="8">No devices</td></tr>'}</tbody></table></div></div>`;
}

async function uploadRelease() {
  const file=document.getElementById('release-file').files[0]; if(!file){toast('Release 파일을 선택하세요.',true);return;}
  const type=document.getElementById('release-type').value, channel=document.getElementById('release-channel').value, version=document.getElementById('release-version').value.trim();
  const rolloutPercent=Number(document.getElementById('release-rollout').value||100), mandatory=document.getElementById('release-mandatory').value;
  const notes=document.getElementById('release-notes').value.trim(); const status=document.getElementById('release-upload-status');
  const q=new URLSearchParams({type,channel,version,fileName:file.name,rolloutPercent:String(rolloutPercent),mandatory,notes});
  status.textContent=`UPLOADING ${fmtBytes(file.size)}...`;
  const response=await fetch(`/api/releases/upload?${q.toString()}`,{method:'POST',headers:{'X-CSRF-Token':session.csrf,'Content-Type':'application/octet-stream'},credentials:'same-origin',body:file});
  let data={}; try{data=await response.json();}catch(_){} if(!response.ok||data.ok===false)throw new Error(data.error||`HTTP_${response.status}`);
  toast(`${type}/${channel} ${version} published`); await renderReleases();
}

async function renderFeatureFlags() {
  if (!roleIsAdmin()) { content.innerHTML = '<div class="empty">FORBIDDEN</div>'; return; }
  const [{ defaults, global, serverOverrides, clientOverrides }, { devices }] = await Promise.all([api('/api/control/features'), api('/api/control/devices')]);
  const names = Object.keys(defaults || {});
  const globalRows = names.map(name => `<tr><td class="code">${esc(name)}</td><td>${badge(defaults[name] ? 'ON' : 'OFF')}</td><td><select data-global-flag="${esc(name)}"><option value="ON" ${global[name]?'selected':''}>ON</option><option value="OFF" ${!global[name]?'selected':''}>OFF</option></select></td></tr>`).join('');
  const deviceOptions = (devices || []).map(d => `<option value="${esc(d.type)}|${esc(d.id)}">${esc(d.type)} // ${esc(d.id)}${d.info && d.info.name ? ` // ${esc(d.info.name)}` : ''}${d.online ? ' // ONLINE' : ' // OFFLINE'}</option>`).join('');
  content.innerHTML = `<div class="panel-grid">
    <div class="section-card"><div class="section-head"><h3>Global Feature Flags</h3><span class="small-note">CONFIG SYNC // GLOBAL DEFAULT</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Flag</th><th>Default</th><th>Global</th></tr></thead><tbody>${globalRows}</tbody></table></div><div class="toolbar"><button id="feature-global-save" class="primary">SAVE GLOBAL FLAGS</button></div></div></div>
    <div class="section-card"><div class="section-head"><h3>Device Override</h3><span class="small-note">INHERIT = GLOBAL</span></div><div class="section-body"><label>Device<select id="feature-device-select"><option value="">SELECT DEVICE</option>${deviceOptions}</select></label><div id="feature-device-editor" class="empty">Server / Client를 선택하세요.</div></div></div>
  </div><div class="section-card"><div class="section-head"><h3>Flag Semantics</h3></div><div class="section-body"><div class="kv">${names.map(name=>`<div class="code">${esc(name)}</div><div>${badge(global[name]?'ON':'OFF')}</div>`).join('')}</div><p class="small-note">Runtime Config 저장과 Feature Flags 저장은 독립적입니다. Device Override는 해당 장비에만 적용되고 나머지는 Global 값을 상속합니다.</p></div></div>`;
  const select = document.getElementById('feature-device-select');
  if (select) select.onchange = () => renderFeatureDeviceEditor(names, serverOverrides || {}, clientOverrides || {});
}

function renderFeatureDeviceEditor(names, serverOverrides, clientOverrides) {
  const select = document.getElementById('feature-device-select');
  const editor = document.getElementById('feature-device-editor');
  if (!select || !editor || !select.value) { if (editor) editor.innerHTML='<div class="empty">Server / Client를 선택하세요.</div>'; return; }
  const [type,id] = select.value.split('|');
  const source = type === 'SERVER' ? serverOverrides : clientOverrides;
  const override = source[id] || {};
  editor.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Flag</th><th>Override</th></tr></thead><tbody>${names.map(name=>`<tr><td class="code">${esc(name)}</td><td>${flagSelect(name,Object.prototype.hasOwnProperty.call(override,name)?override[name]:null)}</td></tr>`).join('')}</tbody></table></div><div class="toolbar"><button id="feature-device-save" class="primary" data-type="${esc(type)}" data-id="${esc(id)}">SAVE OVERRIDE</button><button id="feature-device-clear" data-type="${esc(type)}" data-id="${esc(id)}">CLEAR OVERRIDE</button></div>`;
}


async function renderConfigHistory() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { current, history } = await api('/api/control/config-history?limit=100');
  const rows = (history || []).map(h => `<tr><td>${esc(fmtTime(h.at))}</td><td class="code">${esc(h.id)}</td><td>${esc(h.action)}</td><td>${esc(h.actor)}</td><td>${h.revision}</td><td>${esc(h.detail || '-')}</td><td>${h.action === 'ROLLBACK' ? '-' : `<button data-config-rollback="${esc(h.id)}">ROLLBACK</button>`}</td></tr>`).join('');
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">CURRENT REVISION</div><div class="stat-value">${current.revision}</div><div class="stat-sub">Runtime Config</div></div><div class="card"><div class="stat-label">HISTORY</div><div class="stat-value">${history.length}</div><div class="stat-sub">Max 100 snapshots</div></div></div><div class="section-card"><div class="section-head"><h3>Configuration Timeline</h3><span class="small-note">Rollback creates a NEW revision so connected devices always apply it.</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Time</th><th>ID</th><th>Action</th><th>Actor</th><th>Rev</th><th>Detail</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">History 없음</td></tr>'}</tbody></table></div></div></div>`;
}

async function renderEnrollment() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { enrollment:e } = await api('/api/enrollment');
  const rows=(e.records||[]).map(r=>`<tr><td>${badge(r.type)}</td><td class="code">${esc(r.deviceKey)}</td><td>${badge(r.status)}</td><td class="code">${esc(r.requestId)}</td><td>${esc(r.appVersion||'-')}</td><td>${r.protocolVersion||'-'}</td><td class="code">${esc(r.ip||'-')}</td><td>${esc(fmtTime(r.lastSeenAt))}</td><td class="code">${esc(r.assignedId||'-')}</td><td><div class="actions">${r.status==='PENDING'?`<button class="primary" data-enroll-decision="APPROVED" data-request-id="${esc(r.requestId)}">APPROVE</button><button class="danger" data-enroll-decision="REJECTED" data-request-id="${esc(r.requestId)}">REJECT</button>`:''}<button data-enroll-reset="${esc(r.requestId)}">RESET</button></div></td></tr>`).join('');
  content.innerHTML=`<div class="cards"><div class="card"><div class="stat-label">POLICY</div><div class="stat-value">${e.policy.enabled?'ON':'OFF'}</div><div class="stat-sub">Existing devices are grandfathered</div></div><div class="card"><div class="stat-label">PENDING</div><div class="stat-value">${e.pending}</div></div><div class="card"><div class="stat-label">APPROVED</div><div class="stat-value">${e.approved}</div></div><div class="card"><div class="stat-label">REJECTED</div><div class="stat-value">${e.rejected}</div></div></div><div class="section-card"><div class="section-head"><h3>New Device Approval</h3><div class="actions"><button id="enrollment-policy-btn" class="${e.policy.enabled?'warning':'primary'}">${e.policy.enabled?'DISABLE POLICY':'ENABLE POLICY'}</button></div></div><div class="section-body"><p class="muted">정책 ON 이후 처음 보는 Device Key만 PENDING 처리됩니다. 이미 등록된 Server / Client는 재접속에 영향 없습니다.</p><div class="table-wrap"><table><thead><tr><th>Type</th><th>Device Key</th><th>Status</th><th>Request</th><th>App</th><th>Proto</th><th>IP</th><th>Last Seen</th><th>Assigned ID</th><th>Action</th></tr></thead><tbody>${rows||'<tr><td colspan="10" class="empty">Enrollment 기록 없음</td></tr>'}</tbody></table></div></div></div>`;
}

async function renderSecurityCenter() {
  const [{ security:s }, networkResult] = await Promise.all([
    api('/api/security/dashboard'),
    api('/api/security/network')
  ]);
  const network = networkResult.summary || { total:0, changed:0, critical:0, warning:0, info:0 };
  const geo = networkResult.geo || {};
  const alerts=(s.alerts||[]).map(a=>`<div class="integrity-row">${badge(a.severity)}<span class="code">${esc(a.code)}</span><span>COUNT ${a.count}</span><span>${esc(a.message||'')}</span></div>`).join('');
  const rows=(s.devices||[]).map(d=>{
    const age=d.hasSecret?(d.secretAgeUnknown?'UNKNOWN':`${d.secretAgeDays}d`):'-';
    const hmac=!d.capable?badge('LEGACY'):(d.verified?badge('VERIFIED'):badge(d.online?'UNVERIFIED':'OFFLINE'));
    const secret=!d.hasSecret?badge('NONE'):(d.secretStale?badge('STALE'):badge('OK'));
    return `<tr><td>${badge(d.type)}</td><td class="code">${esc(d.id)}</td><td>${d.online?badge('ONLINE'):badge('OFFLINE')}</td><td>${hmac}</td><td>${d.enforced?badge('ENFORCED'):badge('OPTIONAL')}</td><td>${secret}</td><td>${esc(age)}</td><td>${esc(d.authStatus||'-')}</td><td>${d.verifiedAt?esc(fmtTime(d.verifiedAt)):'-'}</td><td>${d.rotationStatus?badge(d.rotationStatus):'-'}</td></tr>`;
  }).join('');
  const networkRows=(networkResult.devices||[]).map(n=>{
    const current=n.current||{}, trusted=n.trusted||{};
    const location=[current.country,current.region,current.city].filter(Boolean).join(' / ')||'-';
    const trustedLocation=[trusted.country,trusted.region,trusted.city].filter(Boolean).join(' / ')||'-';
    const action=roleIsAdmin()?`<button data-network-trust data-type="${esc(n.type)}" data-id="${esc(n.id)}" ${n.changed?'':'disabled'}>TRUST CURRENT</button>`:'-';
    return `<tr><td>${badge(n.type)}</td><td class="code">${esc(n.id)}</td><td>${badge(n.status||'TRUSTED')}</td><td>${n.severity?badge(n.severity):badge('OK')}</td><td class="code">${esc(current.ip||'-')}</td><td class="code">${esc(trusted.ip||'-')}</td><td>${esc(location)}</td><td>${esc(trustedLocation)}</td><td class="code">${esc(current.subnet||'-')}</td><td class="code">${esc(trusted.subnet||'-')}</td><td>${n.changeCount||0}</td><td>${esc(fmtTime(n.lastChangeAt))}</td><td>${action}</td></tr>`;
  }).join('');
  content.innerHTML=`<div class="cards">
    <div class="card"><div class="stat-label">SECURITY SCORE</div><div class="stat-value">${s.score}</div><div class="stat-sub">${esc(s.label)}</div></div>
    <div class="card"><div class="stat-label">HMAC VERIFIED</div><div class="stat-value">${s.verified} / ${s.onlineHmacCapable}</div><div class="stat-sub">Online HMAC-capable</div></div>
    <div class="card"><div class="stat-label">NETWORK CHANGED</div><div class="stat-value">${network.changed}</div><div class="stat-sub">Critical ${network.critical} · Warn ${network.warning}</div></div>
    <div class="card"><div class="stat-label">GEOIP</div><div class="stat-value">${geo.available?'READY':'FALLBACK'}</div><div class="stat-sub">${esc(geo.provider||'none')} · no external API</div></div>
    <div class="card"><div class="stat-label">SECRET AGE</div><div class="stat-value">${s.staleSecrets}</div><div class="stat-sub">90d+ · Unknown ${s.unknownSecretAge}</div></div>
    <div class="card"><div class="stat-label">LEGACY</div><div class="stat-value">${s.legacy}</div><div class="stat-sub">Active rotations ${s.activeRotations}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>Security Alerts</h3>${badge(s.label)}</div><div class="section-body">${alerts||'<div class="integrity-ok">[ SECURITY_HEALTHY ] No active security warnings.</div>'}</div></div>
  <div class="section-card"><div class="section-head"><h3>Trusted Network Baseline</h3><span class="small-note">Country=CRITICAL · Subnet=WARNING · IP=INFO · 자동 차단 없음</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>ID</th><th>Status</th><th>Severity</th><th>Current IP</th><th>Trusted IP</th><th>Current Location</th><th>Trusted Location</th><th>Current Subnet</th><th>Trusted Subnet</th><th>Changes</th><th>Last Change</th><th>Action</th></tr></thead><tbody>${networkRows||'<tr><td colspan="13" class="empty">Network profile 없음</td></tr>'}</tbody></table></div></div></div>
  <div class="section-card"><div class="section-head"><h3>Device Security Matrix</h3><span class="small-note">HMAC / ENROLLMENT / SECRET AGE / ROTATION</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>ID</th><th>Link</th><th>HMAC</th><th>Policy</th><th>Secret</th><th>Age</th><th>Auth State</th><th>Last Verified</th><th>Rotation</th></tr></thead><tbody>${rows||'<tr><td colspan="10" class="empty">Device 없음</td></tr>'}</tbody></table></div></div></div>`;
}

async function renderProtocolSecurity() {
  const [{ readiness }, { devices: security }, { devices: sequences }, { rotations }] = await Promise.all([
    api('/api/control/protocol-readiness'), api('/api/control/security'), api('/api/control/sequences'), api('/api/control/security/rotations')
  ]);
  const secMap = new Map((security || []).map(x => [`${x.type}:${x.id}`, x]));
  const seqMap = new Map((sequences || []).map(x => [`${x.type}:${x.id}`, x]));
  const rotationMap = new Map((rotations || []).map(x => [`${x.type}:${x.id}`, x]));
  const rows = (readiness.devices || []).map(r => {
    const key = `${r.type}:${r.id}`;
    const sec = secMap.get(key) || {};
    const seq = seqMap.get(key) || {};
    const st = seq.stats || {};
    const rot = rotationMap.get(key) || null;
    const actions = roleIsAdmin() && sec.online ? `<div class="actions"><button data-security-challenge data-type="${esc(r.type)}" data-id="${esc(r.id)}">Challenge</button><button class="warning" data-security-rotate data-type="${esc(r.type)}" data-id="${esc(r.id)}">Rotate Secret</button><button class="danger" data-security-reset data-type="${esc(r.type)}" data-id="${esc(r.id)}">Re-enroll</button></div>` : '-';
    return `<tr><td>${badge(r.type)}</td><td class="code">${esc(r.id)}</td><td>${r.ready ? badge('READY') : badge('BLOCKED')}</td><td>${esc((r.profile && `${r.profile.current} → ${r.profile.candidate}`) || '-')}</td><td>${sec.hasSecret ? badge('ENROLLED') : badge('NONE')}</td><td>${sec.verified ? badge('VERIFIED') : badge(sec.online ? 'UNVERIFIED' : 'OFFLINE')}</td><td>${sec.enforced ? badge('ENFORCED') : badge('OPTIONAL')}</td><td>${rot ? badge(rot.status) : badge('NONE')}</td><td>${seq.capable ? badge(seq.enabled ? 'ON' : 'OFF') : badge('LEGACY')}</td><td>${st.rxLast || 0}</td><td>${st.rxMissing || 0}</td><td>${st.rxDuplicates || 0}</td><td>${st.rxOutOfOrder || 0}</td><td>${esc((r.blockers || []).join(', ') || '-')}</td><td>${actions}</td></tr>`;
  }).join('');
  const verified = (security || []).filter(x => x.verified).length;
  const enrolled = (security || []).filter(x => x.hasSecret).length;
  const missing = (sequences || []).reduce((a,x)=>a+Number(x.stats&&x.stats.rxMissing||0),0);
  const anomalies = (sequences || []).reduce((a,x)=>a+Number(x.stats&&x.stats.rxDuplicates||0)+Number(x.stats&&x.stats.rxOutOfOrder||0),0);
  content.innerHTML = `<div class="cards">
    <div class="card"><div class="stat-label">V3 READY</div><div class="stat-value">${readiness.ready} / ${readiness.total}</div><div class="stat-sub">Candidate Protocol ${readiness.candidateProtocol}</div></div>
    <div class="card"><div class="stat-label">HMAC VERIFIED</div><div class="stat-value">${verified}</div><div class="stat-sub">Enrolled ${enrolled}</div></div>
    <div class="card"><div class="stat-label">SEQ MISSING</div><div class="stat-value">${missing}</div><div class="stat-sub">Detected gaps</div></div>
    <div class="card"><div class="stat-label">SEQ ANOMALY</div><div class="stat-value">${anomalies}</div><div class="stat-sub">Duplicate / Out-of-order</div></div>
  </div><div class="section-card"><div class="section-head"><h3>Protocol v3 Readiness / Device Security / Sequence</h3><span class="small-note">Protocol 2 remains active. This page only measures readiness.</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>ID</th><th>V3</th><th>Profile</th><th>Secret</th><th>HMAC</th><th>Policy</th><th>Rotation</th><th>SEQ</th><th>RX Last</th><th>Missing</th><th>Dup</th><th>OOO</th><th>Blockers</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="15" class="empty">Device 없음</td></tr>'}</tbody></table></div></div></div>`;
}

async function renderAudit() {
  const { events } = await api(`/api/audit?query=${encodeURIComponent(auditQuery)}&type=${encodeURIComponent(auditType)}`);
  const types = [...new Set(events.map(x => x.type))].sort();
  content.innerHTML = `<div class="toolbar"><input id="audit-search" placeholder="이벤트 검색" value="${esc(auditQuery)}"><select id="audit-type"><option value="ALL">ALL</option>${types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select><button id="audit-search-btn">검색</button></div>
  <div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Detail</th></tr></thead><tbody>${events.map(e => `<tr><td>${esc(fmtTime(e.time))}</td><td class="code">${esc(e.type)}</td><td>${esc(e.detail)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Audit 없음</td></tr>'}</tbody></table></div>`;
  const typeEl = document.getElementById('audit-type');
  if ([...typeEl.options].some(o => o.value === auditType)) typeEl.value = auditType;
}

async function renderActivity() {
  const { activities } = await api(`/api/admin-activity?query=${encodeURIComponent(activityQuery)}&limit=500`);
  content.innerHTML = `<div class="toolbar"><input id="activity-search" placeholder="Role / IP / API / Status 검색" value="${esc(activityQuery)}"><button id="activity-search-btn">검색</button><span class="small-note">비밀번호와 요청 본문은 기록하지 않습니다.</span></div>
  <div class="table-wrap"><table><thead><tr><th>Time</th><th>Role</th><th>IP</th><th>Method</th><th>API</th><th>Status</th><th>Action</th></tr></thead><tbody>${activities.map(a => `<tr><td>${esc(fmtTime(a.time))}</td><td>${badge(a.role)}</td><td class="code">${esc(a.ip || '-')}</td><td class="code">${esc(a.method)}</td><td class="code">${esc(a.path)}</td><td>${a.status >= 200 && a.status < 300 ? badge('OK') : badge('ERROR')} ${a.status}</td><td>${esc(a.action || '-')}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Activity 없음</td></tr>'}</tbody></table></div>`;
}

async function renderSessions() {
  const { sessions } = await api('/api/sessions');
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">ACTIVE SESSIONS</div><div class="stat-value">${sessions.length}</div><div class="stat-sub">Current session included</div></div><div class="card"><div class="stat-label">ADMIN</div><div class="stat-value">${sessions.filter(x => x.role === 'admin').length}</div><div class="stat-sub">Privileged sessions</div></div><div class="card"><div class="stat-label">OTHER ROLES</div><div class="stat-value">${sessions.filter(x => x.role !== 'admin').length}</div><div class="stat-sub">Operator / Viewer</div></div></div>
  <div class="toolbar"><button id="session-revoke-others-btn" class="warning">현재 세션 제외 전부 종료</button><button id="session-revoke-all-btn" class="danger">전체 세션 종료</button><span class="small-note">Session Token 원문은 화면/로그에 노출하지 않습니다.</span></div>
  <div class="table-wrap"><table><thead><tr><th>Session ID</th><th>Role</th><th>IP</th><th>Created</th><th>Last Active</th><th>Expires</th><th>Current</th><th>Action</th></tr></thead><tbody>${sessions.map(s => `<tr><td class="code">${esc(s.id)}</td><td>${badge(s.role)}</td><td class="code">${esc(s.ip || '-')}</td><td>${esc(fmtTime(s.createdAt))}</td><td>${esc(fmtTime(s.lastSeenAt))}</td><td>${esc(fmtTime(s.expiresAt))}</td><td>${s.current ? badge('CURRENT') : '-'}</td><td>${s.current ? '<span class="muted">현재 세션</span>' : `<button class="danger" data-session-revoke="${esc(s.id)}">Terminate</button>`}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Session 없음</td></tr>'}</tbody></table></div>`;
}

async function renderSystemHealth() {
  const [{ health: h }, { integrity }] = await Promise.all([api('/api/system/health'), api('/api/system/integrity')]);
  const o = h.overall;
  const db = h.database;
  const b = h.backup;
  const a = h.audit;
  const w = h.web;
  const n = h.node;
  const r = h.relay;
  content.innerHTML = `<div class="cards">
    <div class="card"><div class="stat-label">RELAY</div><div class="stat-value">${o.serviceEnabled ? 'ONLINE' : 'OFFLINE'}</div><div class="stat-sub">Uptime ${esc(fmtDuration(o.uptimeMs))}</div></div>
    <div class="card"><div class="stat-label">DATABASE</div><div class="stat-value">${db.exists && db.dataDirWritable && db.lastSaveOk ? 'OK' : 'CHECK'}</div><div class="stat-sub">${esc(fmtBytes(db.size))} · ${esc(fmtTime(db.lastSaveAt))}</div></div>
    <div class="card"><div class="stat-label">BACKUPS</div><div class="stat-value">${b.count}</div><div class="stat-sub">Latest ${esc(b.latest ? fmtTime(b.latest.mtimeMs) : '-')}</div></div>
    <div class="card"><div class="stat-label">WEB SESSIONS</div><div class="stat-value">${w.sessions.total}</div><div class="stat-sub">Admin ${w.sessions.roles.admin} · Operator ${w.sessions.roles.operator} · Viewer ${w.sessions.roles.viewer}</div></div>
    <div class="card"><div class="stat-label">DB INTEGRITY</div><div class="stat-value">${integrity.ok ? 'HEALTHY' : 'ERROR'}</div><div class="stat-sub">Errors ${integrity.errors.length} · Warnings ${integrity.warnings.length}</div></div>
  </div>
  <div class="panel-grid health-panels">
    <div class="section-card"><div class="section-head"><h3>Node Runtime</h3>${badge('ONLINE')}</div><div class="section-body"><div class="kv"><div>Node</div><div class="code">${esc(n.version)}</div><div>PID</div><div>${n.pid}</div><div>Platform</div><div>${esc(n.platform)} / ${esc(n.arch)}</div><div>Uptime</div><div>${esc(fmtDuration(n.uptimeMs))}</div><div>RSS</div><div>${esc(fmtBytes(n.rss))}</div><div>Heap</div><div>${esc(fmtBytes(n.heapUsed))} / ${esc(fmtBytes(n.heapTotal))}</div><div>CPU</div><div>${n.cpuCount} cores</div><div>Load 1/5/15m</div><div>${n.load1m} / ${n.load5m} / ${n.load15m}</div></div></div></div>
    <div class="section-card"><div class="section-head"><h3>Database</h3>${badge(db.exists && db.dataDirWritable && db.lastSaveOk ? 'GOOD' : 'WARNING')}</div><div class="section-body"><div class="kv"><div>File</div><div class="code">${esc(db.file)}</div><div>Exists</div><div>${badge(db.exists ? 'GOOD' : 'ERROR')}</div><div>Writable</div><div>${badge(db.dataDirWritable ? 'GOOD' : 'ERROR')}</div><div>Size</div><div>${esc(fmtBytes(db.size))}</div><div>Modified</div><div>${esc(fmtTime(db.mtimeMs))}</div><div>Last Save</div><div>${esc(fmtTime(db.lastSaveAt))}</div><div>Last Save Result</div><div>${badge(db.lastSaveOk ? 'GOOD' : 'ERROR')}</div></div></div></div>
    <div class="section-card"><div class="section-head"><h3>Backup / Audit</h3>${badge(b.writable && a.writable ? 'GOOD' : 'WARNING')}</div><div class="section-body"><div class="kv"><div>Backup Writable</div><div>${badge(b.writable ? 'GOOD' : 'ERROR')}</div><div>Backup Count</div><div>${b.count}</div><div>Latest Backup</div><div class="code">${esc(b.latest ? b.latest.file : '-')}</div><div>Latest Time</div><div>${esc(b.latest ? fmtTime(b.latest.mtimeMs) : '-')}</div><div>Audit Writable</div><div>${badge(a.writable ? 'GOOD' : 'ERROR')}</div><div>Audit Files</div><div>${a.count}</div><div>Latest Audit</div><div class="code">${esc(a.latest ? a.latest.file : '-')}</div></div></div></div>
    <div class="section-card"><div class="section-head"><h3>Relay Runtime</h3>${badge(o.serviceEnabled ? 'GOOD' : 'OFFLINE')}</div><div class="section-body"><div class="kv"><div>Servers</div><div>${r.serversOnline} online</div><div>Clients</div><div>${r.clientsOnline} online</div><div>Pending ACK</div><div>${r.pendingAcks}</div><div>Request Traces</div><div>${r.requestTraces}</div><div>Offline Queue</div><div>${r.offlineQueue||0}</div><div>Active DLQ</div><div>${r.activeDeadLetters||0}</div><div>Replayed</div><div>${r.replayedRequests||0}</div><div>Dequeued</div><div>${r.dequeuedRequests||0}</div><div>ACK OK</div><div>${r.ackOk}</div><div>ACK Error</div><div>${r.ackError}</div><div>ACK Timeout</div><div>${r.ackTimeout}</div><div>Retries</div><div>${r.ackRetries}</div><div>Connections</div><div>${r.connections}</div></div></div></div>
  </div><div class="section-card integrity-panel"><div class="section-head"><h3>Database Integrity</h3>${badge(integrity.ok ? 'GOOD' : 'ERROR')}</div><div class="section-body"><div class="stats-summary"><span>Servers <strong>${integrity.stats.servers || 0}</strong></span><span>Clients <strong>${integrity.stats.clients || 0}</strong></span><span>Licenses <strong>${integrity.stats.licenses || 0}</strong></span><span>Errors <strong>${integrity.errors.length}</strong></span><span>Warnings <strong>${integrity.warnings.length}</strong></span><button id="integrity-run-btn">RUN CHECK</button></div>${integrity.errors.length || integrity.warnings.length ? `<div class="integrity-list">${[...integrity.errors.map(x=>({...x,severity:'ERROR'})),...integrity.warnings.map(x=>({...x,severity:'WARNING'}))].map(x=>`<div class="integrity-row">${badge(x.severity)}<span class="code">${esc(x.code)}</span><span>${esc(x.message)}</span><span class="code">${esc(x.entity || '-')}</span></div>`).join('')}</div>` : '<div class="integrity-ok">[ DATABASE_HEALTHY ] No broken bindings or structural errors detected.</div>'}</div></div>`;
}

async function renderBackups() {
  const { backups } = await api('/api/backups');
  content.innerHTML = `<div class="toolbar">${roleIsAdmin() ? '<button id="backup-create-btn" class="primary">백업 생성</button>' : ''}<span class="small-note">Restore는 현재 Server/Client를 재접속시킵니다.</span></div>
  <div class="table-wrap"><table><thead><tr><th>File</th><th>Size</th><th>Created</th><th>Action</th></tr></thead><tbody>${backups.map(b => `<tr><td class="code">${esc(b.file)}</td><td>${esc(fmtBytes(b.size))}</td><td>${esc(fmtTime(b.mtimeMs))}</td><td><div class="actions"><button data-backup-action="verify" data-file="${esc(b.file)}">Verify</button>${roleIsAdmin() ? `<button data-open-view="danger" class="warning">Danger Zone</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Backup 없음</td></tr>'}</tbody></table></div>`;
}

async function renderLoadSimulator() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { simulator } = await api('/api/load-simulator');
  const p = simulator.presets || {};
  content.innerHTML = `<div class="section-card"><div class="section-head"><h3>External Load Simulator</h3>${badge('STAGING ONLY')}</div><div class="section-body">
    <p class="muted">운영 Relay 프로세스 내부에서 부하를 만들지 않습니다. 별도 PC/프로세스에서 <span class="code">tools/load-simulator.js</span>를 실행합니다.</p>
    <div class="warning-box">전용 Staging 배포에서 실행을 권장합니다. Simulator Client Identity는 테스트 DB에 남을 수 있습니다. FULL 모드는 임시 License를 생성하고 종료 시 자동 삭제합니다.</div>
    <div class="grid-2"><label>Relay Host<input id="load-relay-host" value="127.0.0.1"></label><label>Relay Port<input id="load-relay-port" type="number" value="3000"></label><label>Web Admin URL<input id="load-web-url" value="http://127.0.0.1:8080"></label><label>Mode<select id="load-mode"><option value="connect">CONNECT ONLY</option><option value="full">FULL LICENSE + SEND + ACK</option></select></label><label>Servers<input id="load-servers" type="number" min="1" max="500" value="${p.medium?.servers || 10}"></label><label>Clients<input id="load-clients" type="number" min="1" max="5000" value="${p.medium?.clients || 100}"></label><label>Requests / Client<input id="load-requests" type="number" min="0" max="100" value="${p.medium?.requestsPerClient || 1}"></label></div>
    <div class="actions"><button id="load-preset-smoke">SMOKE</button><button id="load-preset-medium">MEDIUM</button><button id="load-preset-heavy">HEAVY</button><button id="load-command-btn" class="primary">GENERATE COMMAND</button></div>
    <div class="terminal-box"><div class="small-note">COMMAND // FULL 모드에서는 마지막에 <span class="code">--admin-secret YOUR_SECRET</span>을 추가하거나 실행 환경에 ADMIN_SECRET을 설정하세요.</div><pre id="load-command-output" class="code-block">${esc(simulator.example || '')}</pre><button id="load-copy-btn">COPY</button></div>
  </div></div>`;
}

async function renderStorageMigration() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { migration: m } = await api('/api/storage/migration/status');
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">ACTIVE STORAGE</div><div class="stat-value">${esc(m.activeProvider)}</div><div class="stat-sub">현재 안정판 유지</div></div><div class="card"><div class="stat-label">TARGET</div><div class="stat-value">${esc(m.targetProvider)}</div><div class="stat-sub">Schema v${m.schemaVersion}</div></div><div class="card"><div class="stat-label">READINESS</div><div class="stat-value">${m.ready ? 'READY' : 'BLOCKED'}</div><div class="stat-sub">자동 Cutover 없음</div></div><div class="card"><div class="stat-label">LICENSE REV</div><div class="stat-value">${m.licenseRevision}</div><div class="stat-sub">Migration snapshot 기준</div></div></div>
    <div class="section-card"><div class="section-head"><h3>SQLite Migration Preparation</h3>${badge(m.ready ? 'GOOD' : 'WARNING')}</div><div class="section-body"><div class="kv"><div>Strategy</div><div class="code">${esc(m.strategy)}</div><div>Servers</div><div>${m.counts.servers}</div><div>Clients</div><div>${m.counts.clients}</div><div>Licenses</div><div>${m.counts.licenses}</div><div>Device Secrets</div><div>${m.counts.deviceSecrets}</div><div>Data Dir</div><div class="code">${esc(m.dataDir)}</div></div>
    <p class="muted">현재 Relay는 계속 JSON을 사용합니다. Export는 <span class="code">schema.sql + data.json + SHA256.txt</span>만 생성하며 DB를 전환하지 않습니다.</p>
    ${m.blockers?.length ? `<div class="warning-box">BLOCKERS: ${esc(m.blockers.join(', '))}</div>` : ''}
    <div class="actions"><button id="storage-schema-btn">VIEW SCHEMA</button><button id="storage-export-btn" class="primary" ${m.ready ? '' : 'disabled'}>CREATE MIGRATION BUNDLE</button></div><div id="storage-export-result" class="small-note"></div></div></div>`;
}

async function renderSystem() {
  const { system: s } = await api('/api/system');
  const schedule = s.maintenanceSchedule;
  content.innerHTML = `<div class="panel-grid">
    <div class="section-card"><div class="section-head"><h3>Service</h3>${badge(s.serviceEnabled ? 'ONLINE' : 'OFFLINE')}</div><div class="section-body"><div class="kv"><div>Maintenance</div><div>${badge(s.maintenanceMode ? 'ON' : 'OFF')}</div><div>Web Admin</div><div>v${esc(s.webAdminVersion || '-')}</div><div>Legacy TCP Admin</div><div>${badge(s.legacyTcpAdminEnabled ? 'ONLINE' : 'DISABLED')}</div><div>Data Dir</div><div class="code">${esc(s.dataDir)}</div><div>Max Clients / Server</div><div>${s.maxClientsPerServer}</div><div>Rate Limit</div><div>${s.rateLimit}/sec</div></div>${roleIsAdmin() ? `<div class="toolbar"><button id="service-start-btn">Service Start</button><button id="maint-on-btn" class="warning">Maintenance ON</button><button id="maint-off-btn">Maintenance OFF</button><button data-open-view="danger" class="danger">Danger Zone</button></div>` : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>Version Policy</h3></div><div class="section-body"><div class="form-grid"><label>Protocol<input id="version-protocol" type="number" min="1" max="${s.currentProtocolVersion}" value="${s.minProtocolVersion}"></label><label>Server<input id="version-server" value="${esc(s.minServerVersion)}"></label><label>Client<input id="version-client" value="${esc(s.minClientVersion)}"></label><label>Current Protocol<input disabled value="${s.currentProtocolVersion}"></label></div>${roleIsAdmin() ? '<button data-open-view="danger" class="warning">Danger Zone에서 변경</button>' : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>Maintenance Schedule / Auto Drain</h3>${s.maintenanceAutomation?.active ? badge(s.maintenanceAutomation.phase) : ''}</div><div class="section-body">${schedule ? `<div class="kv"><div>Start</div><div>${esc(fmtTime(schedule.startAt))}</div><div>End</div><div>${esc(fmtTime(schedule.endAt))}</div><div>Message</div><div>${esc(schedule.message)}</div><div>Auto Drain</div><div>${badge(schedule.autoDrain?'ON':'OFF')}</div><div>Drain Lead</div><div>${schedule.drainLeadMinutes||0} min</div><div>Force Start</div><div>${badge(schedule.forceStart?'ON':'OFF')}</div><div>Phase</div><div>${badge(s.maintenanceAutomation?.phase||'SCHEDULED')}</div><div>Live Clients</div><div>${s.maintenanceAutomation?.liveClients??0}</div><div>Auto-drained Servers</div><div>${s.maintenanceAutomation?.autoDrainedServers??0}</div></div>${s.maintenanceAutomation?.phase==='WAITING_FOR_DRAIN'?'<div class="warning-box">예약 시각이 지났지만 Client가 남아 있어 Maintenance 진입을 기다리고 있습니다. Drain은 Client를 강제 종료하지 않습니다.</div>':''}` : '<p class="muted">예약된 Maintenance가 없습니다.</p>'}${roleIsAdmin() ? '<div class="toolbar"><button id="schedule-create-btn">예약 설정</button><button id="schedule-clear-btn">예약 제거</button></div>' : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>Notice</h3></div><div class="section-body"><p class="muted">현재 온라인 Client 전체에 공지를 전송합니다.</p>${roleCanOperate() ? '<button id="notice-all-btn">전체 공지 보내기</button>' : ''}</div></div>
  </div>`;
}

function openModal(options) {
  return new Promise(resolve => {
    modalTitle.textContent = options.title || '확인';
    const fields = options.fields || [];
    modalBody.innerHTML = `${options.message ? `<p>${esc(options.message)}</p>` : ''}${options.html || ''}${fields.map(f => {
      if (f.type === 'textarea') return `<label>${esc(f.label)}<textarea data-modal-field="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea></label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select data-modal-field="${esc(f.name)}">${(f.options || []).map(o => `<option value="${esc(o.value ?? o)}" ${String(o.value ?? o)===String(f.value ?? '')?'selected':''}>${esc(o.label ?? o)}</option>`).join('')}</select></label>`;
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
    const openViewBtn = event.target.closest('[data-open-view]');
    if (openViewBtn) { switchView(openViewBtn.dataset.openView); await renderCurrent(); return; }
    if (event.target.id === 'terminal-help-btn') { await executeTerminalCommand('help'); await renderTerminal(); return; }
    if (event.target.id === 'terminal-clear-btn') { terminalLines = []; await renderTerminal(); return; }
    if (event.target.id === 'danger-service-stop') {
      const v=await openModal({title:'Service Stop',message:'모든 Client 인증을 해제하고 Relay 서비스를 중지합니다.',danger:true,confirmLabel:'STOP SERVICE'});
      if(!v)return; await api('/api/system/service/stop',{method:'POST',body:{}}); toast('Service OFFLINE'); await renderDangerZone(); return;
    }
    if (event.target.id === 'danger-backup-restore') {
      const file=document.getElementById('danger-backup-file').value; const v=await openModal({title:'Backup Restore',message:`${file} 로 DB를 복원합니다. 현재 연결이 재설정될 수 있습니다.`,danger:true,confirmLabel:'RESTORE'}); if(!v)return;
      const verify=await api(`/api/backups/${encodeURIComponent(file)}/verify`); if(!verify.verification.ok) throw new Error('BACKUP_VERIFY_FAILED');
      await api(`/api/backups/${encodeURIComponent(file)}/restore`,{method:'POST',body:{}}); toast('Backup Restore 완료'); await renderDangerZone(); return;
    }
    if (event.target.id === 'danger-backup-delete') {
      const file=document.getElementById('danger-backup-file').value; const v=await openModal({title:'Backup Delete',message:`${file} 백업 파일을 삭제합니다.`,danger:true,confirmLabel:'DELETE'}); if(!v)return;
      await api(`/api/backups/${encodeURIComponent(file)}/delete`,{method:'POST',body:{}}); toast('Backup Delete 완료'); await renderDangerZone(); return;
    }
    if (event.target.id === 'danger-version-apply') {
      const protocol=Number(document.getElementById('danger-version-protocol').value), serverVersion=document.getElementById('danger-version-server').value.trim(), clientVersion=document.getElementById('danger-version-client').value.trim();
      const v=await openModal({title:'Version Policy',message:`Protocol >= ${protocol} // Server >= ${serverVersion} // Client >= ${clientVersion} 로 적용합니다. 기준 미달 연결이 종료될 수 있습니다.`,danger:true,confirmLabel:'APPLY'}); if(!v)return;
      await api('/api/system/version',{method:'POST',body:{protocol,serverVersion,clientVersion}}); toast('Version Policy 적용 완료'); await renderDangerZone(); return;
    }
    if (event.target.id === 'danger-license-delete') {
      const keys=document.getElementById('danger-license-keys').value.split(/[\s,;]+/).map(x=>x.trim()).filter(Boolean).slice(0,500); if(!keys.length) throw new Error('NO_KEYS');
      const v=await openModal({title:'Bulk License Delete',message:`${keys.length}개 License를 삭제합니다.`,danger:true,confirmLabel:'DELETE'}); if(!v)return;
      const r=await api('/api/licenses/bulk',{method:'POST',body:{action:'delete',keys}}); toast(`${r.success}/${r.total} License 삭제`); await renderDangerZone(); return;
    }
    if (event.target.id && event.target.id.startsWith('load-preset-')) {
      const name=event.target.id.replace('load-preset-','').toLowerCase(); const presets={smoke:[2,10,1],medium:[10,100,1],heavy:[100,1000,1]}; const v=presets[name]; if(v){document.getElementById('load-servers').value=v[0];document.getElementById('load-clients').value=v[1];document.getElementById('load-requests').value=v[2];} return;
    }
    if (event.target.id === 'load-command-btn') {
      const body={relayHost:document.getElementById('load-relay-host').value,relayPort:Number(document.getElementById('load-relay-port').value),webUrl:document.getElementById('load-web-url').value,mode:document.getElementById('load-mode').value,servers:Number(document.getElementById('load-servers').value),clients:Number(document.getElementById('load-clients').value),requestsPerClient:Number(document.getElementById('load-requests').value)};
      const r=await api('/api/load-simulator/command',{method:'POST',body}); document.getElementById('load-command-output').textContent=r.command; return;
    }
    if (event.target.id === 'load-copy-btn') { const t=document.getElementById('load-command-output')?.textContent||''; if(navigator.clipboard) await navigator.clipboard.writeText(t); toast('Command copied'); return; }
    if (event.target.id === 'storage-schema-btn') { const r=await api('/api/storage/migration/schema'); await openModal({title:`SQLite Schema v${r.schema.version}`,html:`<pre class="code-block schema-preview">${esc(r.schema.sql)}</pre>`,confirmLabel:'닫기'}); return; }
    if (event.target.id === 'storage-export-btn') { const v=await openModal({title:'Create SQLite Migration Bundle',message:'현재 JSON DB는 그대로 유지하고 Migration용 schema/data/checksum 파일만 생성합니다.',confirmLabel:'EXPORT'}); if(!v)return; const r=await api('/api/storage/migration/export',{method:'POST',body:{}}); const out=document.getElementById('storage-export-result'); if(out)out.textContent=`${r.directory} // SHA256 ${r.checksum}`; toast('Migration Bundle 생성 완료'); return; }

    if (event.target.id === 'release-upload-btn') { await uploadRelease(); return; }
    const releaseRollout=event.target.closest('[data-release-rollout]');
    if(releaseRollout){
      const cur=await api('/api/releases'); const item=(cur.releases.releases||[]).find(x=>x.type===releaseRollout.dataset.type&&x.channel===releaseRollout.dataset.channel); const v=await openModal({title:'Canary Rollout',message:`${releaseRollout.dataset.type}/${releaseRollout.dataset.channel} 배포 비율`,fields:[{name:'percent',label:'Rollout %',type:'number',value:String(item?.rolloutPercent??100)}],confirmLabel:'APPLY'}); if(!v)return;
      await api('/api/releases/rollout',{method:'POST',body:{type:releaseRollout.dataset.type,channel:releaseRollout.dataset.channel,rolloutPercent:Number(v.percent)}}); toast('Canary rollout 적용'); await renderReleases(); return;
    }
    const releaseToggle=event.target.closest('[data-release-toggle]');
    if(releaseToggle){ await api('/api/releases/enabled',{method:'POST',body:{type:releaseToggle.dataset.type,channel:releaseToggle.dataset.channel,enabled:releaseToggle.dataset.enabled==='1'}}); toast('Release 상태 변경'); await renderReleases(); return; }
    const releasePush=event.target.closest('[data-release-push]');
    if(releasePush){ const r=await api('/api/releases/push',{method:'POST',body:{}}); toast(`Update check pushed: ${(r.results||[]).filter(x=>x.available).length}`); return; }
    const releaseDevicePush=event.target.closest('[data-release-device-push]');
    if(releaseDevicePush){ const r=await api('/api/releases/push',{method:'POST',body:{type:releaseDevicePush.dataset.type,id:releaseDevicePush.dataset.id}}); toast(r.result?.available?'UPDATE_AVAILABLE 전송':'대상 업데이트 없음'); return; }

    if (event.target.id === 'failover-policy-save') {
      const body={
        enabled:document.getElementById('failover-policy-enabled').value==='1',
        autoReturn:document.getElementById('failover-auto-return').value==='1',
        offlineGraceSeconds:Number(document.getElementById('failover-offline-grace').value),
        returnGraceSeconds:Number(document.getElementById('failover-return-grace').value),
        maxMovesPerCycle:Number(document.getElementById('failover-max-moves').value)
      };
      await api('/api/failover/policy',{method:'POST',body}); toast('Emergency Failover Policy 저장'); await renderFailover(); return;
    }
    if (event.target.id === 'failover-run-now') { const r=await api('/api/failover/run',{method:'POST',body:{}}); toast(`Failover moves ${r.result.moves||0} / returns ${r.result.returns||0}`); await renderFailover(); return; }
    const failoverToggle=event.target.closest('[data-failover-toggle]');
    if(failoverToggle){await api(`/api/failover/clients/${encodeURIComponent(failoverToggle.dataset.failoverToggle)}`,{method:'POST',body:{enabled:failoverToggle.dataset.enabled==='1'}});toast(`Client Failover ${failoverToggle.dataset.enabled==='1'?'ON':'OFF'}`);await renderFailover();return;}
    const failoverReturn=event.target.closest('[data-failover-return]');
    if(failoverReturn){const v=await openModal({title:'Return to Primary',message:`${failoverReturn.dataset.failoverReturn} Client를 원래 Primary Server로 복귀시킵니다. Primary가 준비되지 않았으면 실행되지 않습니다.`,confirmLabel:'RETURN'});if(!v)return;await api(`/api/failover/clients/${encodeURIComponent(failoverReturn.dataset.failoverReturn)}/return`,{method:'POST',body:{}});toast('Primary 복귀 완료');await renderFailover();return;}
    const bindingEdit=event.target.closest('[data-binding-edit]');
    if(bindingEdit){
      const c=failoverRows.get(bindingEdit.dataset.bindingEdit); if(!c)throw new Error('CLIENT_NOT_FOUND');
      const serverOptions=failoverServers.map(x=>({value:x.id,label:`${x.alias||x.id} // ${x.status}`}));
      const v=await openModal({title:'Primary / Backup Binding',message:'평상시에는 Primary만 사용하며 장애 시 지정 Backup을 우선합니다.',fields:[
        {name:'primary',label:'Primary Server',type:'select',value:c.primaryServerId,options:serverOptions},
        {name:'backup',label:'Backup Server',type:'select',value:c.backupServerId||'',options:[{value:'',label:'NONE'},...serverOptions]},
        {name:'fallback',label:'Backup 불가 시 자동 선택',type:'select',value:c.allowAutomaticFallback?'1':'0',options:[{value:'0',label:'OFF - 지정 Backup만 사용'},{value:'1',label:'ON - 다른 가용 Server 허용'}]}
      ],confirmLabel:'SAVE BINDING'}); if(!v)return;
      await api(`/api/failover/clients/${encodeURIComponent(c.clientId)}/binding`,{method:'POST',body:{primaryServerId:v.primary,backupServerId:v.backup,allowAutomaticFallback:v.fallback==='1'}});toast('Primary / Backup Binding 저장');await renderFailover();return;
    }
    const bindingClear=event.target.closest('[data-binding-clear]');
    if(bindingClear){const v=await openModal({title:'Clear Binding',message:'명시적 Primary / Backup 설정을 제거하고 현재 Server를 기본 바인딩으로 유지합니다.',confirmLabel:'CLEAR'});if(!v)return;await api(`/api/failover/clients/${encodeURIComponent(bindingClear.dataset.bindingClear)}/binding/clear`,{method:'POST',body:{}});toast('Binding 제거 완료');await renderFailover();return;}

    if(event.target.id==='queue-policy-save'){
      await api('/api/request-recovery/policy',{method:'POST',body:{enabled:document.getElementById('queue-policy-enabled').value==='1',maxItemsPerClient:Number(document.getElementById('queue-policy-max').value),ttlSeconds:Number(document.getElementById('queue-policy-ttl').value),maxDeliveryAttempts:Number(document.getElementById('queue-policy-attempts').value)}});toast('Offline Queue Policy 저장');await renderRecovery();return;
    }
    const queueToggle=event.target.closest('[data-queue-toggle]');
    if(queueToggle){await api(`/api/request-recovery/clients/${encodeURIComponent(queueToggle.dataset.queueToggle)}`,{method:'POST',body:{enabled:queueToggle.dataset.enabled==='1'}});toast(`Client Queue ${queueToggle.dataset.enabled==='1'?'ON':'OFF'}`);await renderRecovery();return;}
    const dlqRetry=event.target.closest('[data-dlq-retry]');
    if(dlqRetry){const v=await openModal({title:'Retry Dead Letter',message:'새 Request ID를 생성해 다시 전달합니다. 원본 Request ID는 추적 관계로만 보존됩니다.',confirmLabel:'RETRY'});if(!v)return;const r=await api(`/api/dead-letters/${encodeURIComponent(dlqRetry.dataset.dlqRetry)}/retry`,{method:'POST',body:{}});toast(`DLQ Replay ${r.deadLetter.lastReplayRequestId}`);await renderRecovery();return;}
    const dlqDiscard=event.target.closest('[data-dlq-discard]');
    if(dlqDiscard){const v=await openModal({title:'Discard Dead Letter',message:'이 요청을 폐기 상태로 전환합니다. Audit과 DLQ 이력은 유지됩니다.',danger:true,confirmLabel:'DISCARD'});if(!v)return;await api(`/api/dead-letters/${encodeURIComponent(dlqDiscard.dataset.dlqDiscard)}/discard`,{method:'POST',body:{}});toast('DLQ 폐기 완료');await renderRecovery();return;}
    if(event.target.id==='recovery-search-btn'){recoveryQuery=document.getElementById('recovery-search').value.trim();await renderRecovery();return;}

    const serverBtn = event.target.closest('[data-server-action]');
    if (serverBtn) { await serverAction(serverBtn.dataset.serverAction, serverBtn.dataset.id); return; }
    const clientBtn = event.target.closest('[data-client-action]');
    if (clientBtn) { await clientAction(clientBtn.dataset.clientAction, clientBtn.dataset.id); return; }
    const licBtn = event.target.closest('[data-license-action]');
    if (licBtn) { await licenseAction(licBtn.dataset.licenseAction, licBtn.dataset.key); return; }
    const backupBtn = event.target.closest('[data-backup-action]');
    if (backupBtn) { await backupAction(backupBtn.dataset.backupAction, backupBtn.dataset.file); return; }
    const statsBtn = event.target.closest('[data-stats-range]');
    if (statsBtn) { statsRange = statsBtn.dataset.statsRange || '1H'; await renderDashboard(); return; }
    if (event.target.id === 'integrity-run-btn') { await renderSystemHealth(); toast('Database Integrity 검사 완료'); return; }

    const expiryBtn = event.target.closest('[data-license-expiry]');
    if (expiryBtn) {
      licenseExpiry = expiryBtn.dataset.licenseExpiry || 'ALL';
      licenseStatus = licenseExpiry === 'EXPIRED' ? 'EXPIRED' : 'ALL';
      currentView = 'licenses';
      nav.querySelectorAll('button[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === 'licenses'));
      renderCurrent();
      return;
    }
    const notificationReadBtn = event.target.closest('[data-notification-read]');
    if (notificationReadBtn) {
      await api(`/api/notifications/${encodeURIComponent(notificationReadBtn.dataset.notificationRead)}/read`, { method: 'POST', body: { read: true } });
      await updateNotificationBadge();
      await renderNotifications();
      return;
    }

    if (event.target.id === 'activity-search-btn') { activityQuery = document.getElementById('activity-search').value.trim(); renderActivity(); return; }
    const sessionRevokeBtn = event.target.closest('[data-session-revoke]');
    if (sessionRevokeBtn) {
      const v = await openModal({ title: 'Session Terminate', message: `${sessionRevokeBtn.dataset.sessionRevoke} 세션을 강제 종료합니다.`, danger: true, confirmLabel: 'Terminate' });
      if (!v) return;
      await api(`/api/sessions/${encodeURIComponent(sessionRevokeBtn.dataset.sessionRevoke)}/revoke`, { method: 'POST', body: {} });
      toast('Session 종료 완료'); renderSessions(); return;
    }
    if (event.target.id === 'session-revoke-others-btn') {
      const v = await openModal({ title: 'Other Sessions', message: '현재 브라우저를 제외한 모든 Web Admin 세션을 종료합니다.', danger: true, confirmLabel: '종료' });
      if (!v) return;
      const r = await api('/api/sessions/revoke-others', { method: 'POST', body: {} }); toast(`${r.count}개 세션 종료`); renderSessions(); return;
    }
    if (event.target.id === 'session-revoke-all-btn') {
      const v = await openModal({ title: 'ALL Sessions', message: '현재 세션을 포함한 모든 Web Admin 세션을 종료합니다.', danger: true, confirmLabel: '전체 종료' });
      if (!v) return;
      await api('/api/sessions/revoke-all', { method: 'POST', body: {} }); showLogin(); return;
    }

    if (event.target.id === 'console-pause-btn') { consolePaused = !consolePaused; renderConsole(); return; }
    if (event.target.id === 'console-clear-btn') { liveConsoleEvents = []; renderConsole(); return; }
    if (event.target.id === 'trace-search-btn') { traceQuery = document.getElementById('trace-search').value.trim(); renderTrace(); return; }
    const traceBtn = event.target.closest('[data-trace-detail]');
    if (traceBtn) {
      const t = traceRows.get(traceBtn.dataset.traceDetail);
      if (t) await openModal({ title: `Trace ${t.requestId}`, html: `<div class="kv"><div>Status</div><div>${badge(t.status)}</div><div>Source</div><div>${esc(t.source||'CLIENT')}</div><div>Replay Of</div><div class="code">${esc(t.replayOf||'-')}</div><div>DLQ</div><div class="code">${esc(t.deadLetterId||'-')}</div><div>Client</div><div class="code">${esc(t.clientId)}</div><div>Server</div><div class="code">${esc(t.serverId)}</div><div>Number</div><div class="code">${esc(t.number)}</div><div>Queued</div><div>${esc(fmtTime(t.queuedAt))}</div><div>Forwarded</div><div>${esc(fmtTime(t.forwardedAt))}</div><div>ACK / Complete</div><div>${esc(fmtTime(t.completedAt))}</div><div>Duration</div><div>${t.completedAt ? `${t.durationMs} ms` : '-'}</div><div>Retries</div><div>${t.retries}</div><div>Reason</div><div>${esc(t.reason || '-')}</div></div>`, confirmLabel: '닫기' });
      return;
    }
    const traceReplay=event.target.closest('[data-trace-replay]');
    if(traceReplay){const t=traceRows.get(traceReplay.dataset.traceReplay);if(!t)throw new Error('TRACE_NOT_FOUND');const v=await openModal({title:'Replay Request',message:`${t.requestId} 요청을 새 Request ID로 다시 실행합니다.`,confirmLabel:'REPLAY'});if(!v)return;const r=await api('/api/request-traces/replay',{method:'POST',body:{key:t.key}});toast(`Replay ${r.requestId||r.item?.requestId}`);await renderTrace();return;}

    if (event.target.id === 'feature-global-save') {
      const flags = {};
      document.querySelectorAll('[data-global-flag]').forEach(el => flags[el.dataset.globalFlag] = el.value === 'ON');
      await api('/api/control/features/global', { method: 'POST', body: { flags } });
      toast('Global Feature Flags 저장'); await renderFeatureFlags(); return;
    }
    if (event.target.id === 'feature-device-save') {
      const btn=event.target, flags={};
      document.querySelectorAll('[data-flag-name]').forEach(el => { if(el.value==='ON') flags[el.dataset.flagName]=true; else if(el.value==='OFF') flags[el.dataset.flagName]=false; });
      await api('/api/control/features/device', { method:'POST', body:{ type:btn.dataset.type, id:btn.dataset.id, flags } });
      toast('Device Feature Override 저장'); await renderFeatureFlags(); return;
    }
    if (event.target.id === 'feature-device-clear') {
      const btn=event.target;
      await api('/api/control/features/device', { method:'POST', body:{ type:btn.dataset.type, id:btn.dataset.id, flags:{} } });
      toast('Device Feature Override 초기화'); await renderFeatureFlags(); return;
    }
    const securityChallenge = event.target.closest('[data-security-challenge]');
    if (securityChallenge) {
      await api('/api/control/security/challenge', { method:'POST', body:{ type:securityChallenge.dataset.type, id:securityChallenge.dataset.id } });
      toast('HMAC Challenge 전송'); setTimeout(()=>renderProtocolSecurity(),350); return;
    }
    const configRollback = event.target.closest('[data-config-rollback]');
    if (configRollback) {
      const v=await openModal({title:'Config Rollback',message:'선택한 설정 Snapshot을 새 revision으로 복원하고 온라인 기기에 즉시 Sync합니다.',danger:true,confirmLabel:'ROLLBACK'}); if(!v)return;
      const r=await api('/api/control/config-history/rollback',{method:'POST',body:{id:configRollback.dataset.configRollback}}); toast(`Rollback 완료 → revision ${r.currentRevision}`); await renderConfigHistory(); return;
    }
    if (event.target.id === 'enrollment-policy-btn') {
      const { enrollment:e }=await api('/api/enrollment'); const enabled=!e.policy.enabled;
      const v=await openModal({title:'Device Enrollment Policy',message:enabled?'새 Device Key를 승인 전 PENDING으로 전환합니다. 기존 등록 기기는 영향 없습니다.':'새 Device 자동 등록을 다시 허용합니다.',danger:enabled,confirmLabel:enabled?'ENABLE':'DISABLE'});if(!v)return;
      await api('/api/enrollment/policy',{method:'POST',body:{enabled}});toast(`Enrollment ${enabled?'ON':'OFF'}`);await renderEnrollment();return;
    }
    const enrollDecision=event.target.closest('[data-enroll-decision]');
    if(enrollDecision){await api('/api/enrollment/decision',{method:'POST',body:{requestId:enrollDecision.dataset.requestId,status:enrollDecision.dataset.enrollDecision}});toast(`Enrollment ${enrollDecision.dataset.enrollDecision}`);await renderEnrollment();return;}
    const enrollReset=event.target.closest('[data-enroll-reset]');
    if(enrollReset){await api('/api/enrollment/reset',{method:'POST',body:{requestId:enrollReset.dataset.enrollReset}});toast('Enrollment 기록 초기화');await renderEnrollment();return;}
    const securityRotate = event.target.closest('[data-security-rotate]');
    if (securityRotate) {
      const v=await openModal({title:'Zero-Downtime Secret Rotation',message:`${securityRotate.dataset.type} ${securityRotate.dataset.id}의 현재 Secret에서 새 Secret을 파생하고 2단계 Commit합니다. Secret 원문은 네트워크로 다시 보내지 않습니다.`,danger:true,confirmLabel:'ROTATE'});if(!v)return;
      const r=await api('/api/control/security/rotate',{method:'POST',body:{type:securityRotate.dataset.type,id:securityRotate.dataset.id}});toast(`Rotation ${r.rotation.rotationId} 시작`);setTimeout(()=>renderProtocolSecurity(),350);return;
    }
    const securityReset = event.target.closest('[data-security-reset]');
    if (securityReset) {
      const v=await openModal({title:'Re-enroll Device Secret',message:`${securityReset.dataset.type} ${securityReset.dataset.id}의 기존 Secret을 폐기하고 새 Secret을 다시 등록합니다. 연결 장애 복구용입니다.`,danger:true,confirmLabel:'RE-ENROLL'}); if(!v)return;
      await api('/api/control/security/reset', { method:'POST', body:{ type:securityReset.dataset.type, id:securityReset.dataset.id } });
      toast('Device Secret Re-enrollment 시작'); setTimeout(()=>renderProtocolSecurity(),350); return;
    }

    const networkTrust=event.target.closest('[data-network-trust]');
    if(networkTrust){
      const v=await openModal({title:'Trust Current Network',message:`${networkTrust.dataset.type} ${networkTrust.dataset.id}의 현재 IP / Subnet / Country를 새 기준점으로 승인합니다. 과거 Audit 기록은 유지됩니다.`,confirmLabel:'TRUST'}); if(!v)return;
      await api('/api/security/network/trust',{method:'POST',body:{type:networkTrust.dataset.type,id:networkTrust.dataset.id}});
      toast('Current network trusted'); await renderSecurityCenter(); return;
    }

    if (event.target.id === 'license-search-btn') {
      licenseQuery = document.getElementById('license-search').value.trim();
      licenseStatus = document.getElementById('license-status').value;
      licenseExpiry = document.getElementById('license-expiry').value;
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
    if (event.target.id === 'notification-read-all-btn') {
      await api('/api/notifications/read-all', { method: 'POST', body: {} });
      await updateNotificationBadge();
      await renderNotifications();
      return;
    }
    if (event.target.id === 'notification-clear-btn') {
      const v = await openModal({ title: 'Notification Clear', message: '현재 알림 목록을 모두 지웁니다. Audit Log는 삭제되지 않습니다.', danger: true, confirmLabel: '지우기' });
      if (!v) return;
      await api('/api/notifications/clear', { method: 'POST', body: {} });
      await updateNotificationBadge();
      await renderNotifications();
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
      const v = await openModal({ title: 'Service Stop', message: '현재 Client 인증을 해제하고 서비스를 중지합니다.', danger: true, confirmLabel: '중지' });
      if (!v) return; await api('/api/system/service/stop', { method: 'POST', body: {} }); toast('Service OFFLINE'); renderSystem(); return;
    }
    if (event.target.id === 'maint-on-btn') { await api('/api/system/maintenance/on', { method: 'POST', body: {} }); toast('Maintenance ON'); renderSystem(); return; }
    if (event.target.id === 'maint-off-btn') { await api('/api/system/maintenance/off', { method: 'POST', body: {} }); toast('Maintenance OFF'); renderSystem(); return; }
    if (event.target.id === 'version-apply-btn') { await applyVersion(); return; }
    if (event.target.id === 'schedule-create-btn') { await createSchedule(); return; }
    if (event.target.id === 'schedule-clear-btn') { await api('/api/system/maintenance/clear', { method: 'POST', body: {} }); toast('Maintenance 예약 제거'); renderSystem(); return; }
    if (event.target.id === 'notice-all-btn') { await sendNoticeAll(); return; }
  } catch (error) { toast(error.message, true); }
});


content.addEventListener('submit', async event => {
  if (event.target.id !== 'command-terminal-form') return;
  event.preventDefault();
  const input=document.getElementById('command-terminal-input');
  const line=input ? input.value : '';
  if(input) input.value='';
  await executeTerminalCommand(line);
  if(currentView==='terminal') await renderTerminal();
});

content.addEventListener('keydown', event => {
  if (event.target.id !== 'command-terminal-input') return;
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    terminalHistoryIndex=Math.max(0, terminalHistoryIndex-1);
    event.target.value=terminalHistory[terminalHistoryIndex] || '';
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    terminalHistoryIndex=Math.min(terminalHistory.length, terminalHistoryIndex+1);
    event.target.value=terminalHistoryIndex>=terminalHistory.length?'':(terminalHistory[terminalHistoryIndex]||'');
  }
});

async function serverAction(action, id) {
  const encodedId = encodeURIComponent(id);
  if (action === 'detail') {
    const { server } = await api(`/api/servers/${encodedId}`);
    const clients = server.clientsList.map(c => `<tr><td class="code">${esc(c.id)}</td><td>${badge(c.status)}</td><td>${badge(c.licenseStatus)}</td></tr>`).join('') || '<tr><td colspan="3">Client 없음</td></tr>';
    await openModal({ title: `Server ${id}`, html: `<div class="kv"><div>Alias</div><div>${esc(server.alias || '-')}</div><div>Note</div><div>${esc(server.note || '-')}</div><div>Device Key</div><div class="code">${esc(server.deviceKey)}</div><div>Status</div><div>${badge(server.status)}</div><div>Health</div><div>${badge(server.health)}</div><div>Accept Clients</div><div>${server.canAcceptClients ? badge('ONLINE') : badge('OFFLINE')}</div><div>Live / Saved Clients</div><div>${server.clients} / ${server.savedClients}</div><div>RTT</div><div>${server.rttMs >= 0 ? `${server.rttMs} ms` : '-'}</div><div>Kick Until</div><div>${esc(fmtTime(server.kickedUntil))}</div><div>IP</div><div>${esc(server.lastIP || '-')}</div><div>Protocol / Version</div><div>${server.protocolVersion || '-'} / ${esc(server.appVersion || '-')}</div><div>Reconnect</div><div>${server.reconnectCount}</div><div>Last Seen</div><div>${esc(fmtTime(server.lastSeen))}</div></div><div class="table-wrap"><table><thead><tr><th>Client</th><th>Status</th><th>License</th></tr></thead><tbody>${clients}</tbody></table></div>`, confirmLabel: '닫기' });
    return;
  }

  if (action === 'alias') {
    const { server } = await api(`/api/servers/${encodedId}`);
    const v = await openModal({ title: 'Server Alias', message: `${id} 표시용 별칭입니다. 실제 SERVER-ID는 변경되지 않습니다.`, fields: [{ name: 'alias', label: 'Alias', value: server.alias || '', placeholder: 'OFFICE-PC-01' }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/servers/${encodedId}/alias`, { method: 'POST', body: v });
    toast('Server Alias 저장');
    await renderServers();
    return;
  }

  if (action === 'note') {
    const { server } = await api(`/api/servers/${encodedId}`);
    const v = await openModal({ title: 'Server Note', message: `${id} 운영 메모입니다.`, fields: [{ name: 'note', label: 'Note', type: 'textarea', value: server.note || '', placeholder: '고객사 / 위치 / 장비 교체 이력 등' }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/servers/${encodedId}/note`, { method: 'POST', body: v });
    toast('Server Note 저장'); await renderServers(); return;
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
    await openModal({ title: `Client ${id}`, html: `<div class="kv"><div>Alias</div><div>${esc(client.alias || '-')}</div><div>Note</div><div>${esc(client.note || '-')}</div><div>Device Key</div><div class="code">${esc(client.deviceKey)}</div><div>Status</div><div>${badge(client.status)}</div><div>Health</div><div>${badge(client.health)}</div><div>Server</div><div class="code">${esc(client.serverAlias || client.serverId)}${client.serverAlias ? ` [${esc(client.serverId)}]` : ''}</div><div>License</div><div class="code">${esc(client.licenseKey || '-')}</div><div>License Status</div><div>${badge(client.licenseStatus)}</div><div>Expires</div><div>${esc(fmtTime(client.licenseExpiresAt))}</div><div>Kick Until</div><div>${esc(fmtTime(client.kickedUntil))}</div><div>IP</div><div>${esc(client.lastIP || '-')}</div><div>Protocol / Version</div><div>${client.protocolVersion || '-'} / ${esc(client.appVersion || '-')}</div><div>RTT</div><div>${client.rttMs >= 0 ? `${client.rttMs} ms` : '-'}</div><div>Auth / Send / Reconnect</div><div>${client.authCount} / ${client.sendCount} / ${client.reconnectCount}</div><div>Last Auth</div><div>${esc(fmtTime(client.lastAuthAt))}</div><div>Last Seen</div><div>${esc(fmtTime(client.lastSeenAt))}</div></div>`, confirmLabel: '닫기' });
    return;
  }

  if (action === 'alias') {
    const { client } = await api(`/api/clients/${encodedId}`);
    const v = await openModal({ title: 'Client Alias', message: `${id} 표시용 별칭입니다. 실제 CLIENT-ID는 변경되지 않습니다.`, fields: [{ name: 'alias', label: 'Alias', value: client.alias || '', placeholder: 'GALAXY-TEST' }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/alias`, { method: 'POST', body: v });
    toast('Client Alias 저장');
    await renderClients();
    return;
  }

  if (action === 'note') {
    const { client } = await api(`/api/clients/${encodedId}`);
    const v = await openModal({ title: 'Client Note', message: `${id} 운영 메모입니다.`, fields: [{ name: 'note', label: 'Note', type: 'textarea', value: client.note || '', placeholder: '사용자 / 장비 / 교체 이력 등' }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/note`, { method: 'POST', body: v });
    toast('Client Note 저장'); await renderClients(); return;
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
ONLINE이며 Drain/Disable/Kick 상태가 아닌 Server만 표시됩니다.`, fields: [{ name: 'serverId', label: '새 Server', type: 'select', options: eligible.map(s => ({ value: s.id, label: `${s.alias ? s.alias + ' · ' : ''}${s.id} · ${s.health} · ${s.clients}/${s.savedClients}` })) }], confirmLabel: '이동' });
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
  const v = await openModal({ title: 'License 생성', fields: [{ name: 'days', label: '기간(일)', type: 'number', value: '30' }, { name: 'memo', label: 'Memo' }, { name: 'tags', label: 'Tags', placeholder: 'VIP, CUSTOMER-A, TEST' }], confirmLabel: '생성' });
  if (!v) return;
  const tags = String(v.tags || '').split(',').map(x => x.trim()).filter(Boolean);
  const r = await api('/api/licenses', { method: 'POST', body: { days: Number(v.days), memo: v.memo, tags } });
  await openModal({ title: 'License 생성 완료', html: `<div class="kv"><div>Key</div><div class="code">${esc(r.key)}</div><div>Expires</div><div>${esc(fmtTime(r.expiresAt))}</div><div>Tags</div><div>${esc(tags.join(', ') || '-')}</div></div>`, confirmLabel: '닫기' });
  renderLicenses();
}

async function licenseAction(action, key) {
  let body = {};
  if (action === 'qr') {
    const r = await api(`/api/licenses/${encodeURIComponent(key)}/qr`);
    await openModal({ title: 'License QR', html: `<div class="license-qr-wrap"><div class="license-qr">${r.svg}</div><div class="kv"><div>License</div><div class="code">${esc(r.key)}</div><div>Deep Link</div><div class="code qr-payload">${esc(r.payload)}</div></div><p class="small-note">QR 내용은 Relay 서버 내부에서 생성됩니다. 외부 QR 서비스로 License Key를 전송하지 않습니다.</p></div>`, confirmLabel: '닫기' });
    return;
  }
  if (action === 'tags') {
    const { licenses } = await api(`/api/licenses?query=${encodeURIComponent(key)}&status=ALL&expiry=ALL`);
    const current = licenses.find(x => x.key === key);
    const v = await openModal({ title: 'License Tags', message: key, fields: [{ name: 'tags', label: 'Tags', value: current ? (current.tags || []).join(', ') : '', placeholder: 'VIP, CUSTOMER-A, TEST' }], confirmLabel: '저장' });
    if (!v) return;
    const tags = String(v.tags || '').split(',').map(x => x.trim()).filter(Boolean);
    await api(`/api/licenses/${encodeURIComponent(key)}/tags`, { method: 'POST', body: { tags } });
    toast('License Tags 저장');
    renderLicenses();
    return;
  }
  if (action === 'extend') {
    const v = await openModal({ title: 'License 연장', message: key, fields: [{ name: 'days', label: '추가 일수', type: 'number', value: '30' }], confirmLabel: '연장' }); if (!v) return; body.days = Number(v.days);
  } else if (action === 'transfer') {
    const v = await openModal({ title: 'License Transfer', message: key, fields: [{ name: 'clientId', label: '대상 CLIENT-ID' }], confirmLabel: '이전' }); if (!v) return; body = v;
  } else if (action === 'delete') {
    const v = await openModal({ title: 'License Delete', message: `${key}\n이 License를 삭제합니다. 삭제 후에는 복구할 수 없습니다.`, danger: true, confirmLabel: '삭제' }); if (!v) return;
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
  const v = await openModal({ title: `선택 License ${keys.length}개`, fields: [{ name: 'action', label: '작업', type: 'select', options }, { name: 'days', label: '연장 일수(Extend만)', type: 'number', value: '30' }], confirmLabel: '계속' });
  if (!v) return;
  if (v.action === 'delete') {
    const confirmed = await openModal({ title: 'Bulk License Delete', message: `선택한 License ${keys.length}개를 삭제합니다. 삭제 후에는 복구할 수 없습니다.`, danger: true, confirmLabel: '모두 삭제' });
    if (!confirmed) return;
  }
  const r = await api('/api/licenses/bulk', { method: 'POST', body: { action: v.action, keys, days: Number(v.days) } });
  toast(`${r.success}/${r.total} 처리 완료`); selectedLicenses.clear(); renderLicenses();
}

async function backupAction(action, file) {
  if (action === 'verify') {
    const { verification: v } = await api(`/api/backups/${encodeURIComponent(file)}/verify`);
    const issues = [...(v.errors || []).map(x=>({...x,severity:'ERROR'})), ...(v.warnings || []).map(x=>({...x,severity:'WARNING'}))];
    await openModal({ title: `Backup Verify // ${file}`, html: `<div class="kv"><div>Result</div><div>${badge(v.ok ? 'GOOD' : 'ERROR')}</div><div>Servers</div><div>${v.stats.servers || 0}</div><div>Clients</div><div>${v.stats.clients || 0}</div><div>Licenses</div><div>${v.stats.licenses || 0}</div><div>Errors</div><div>${(v.errors || []).length}</div><div>Warnings</div><div>${(v.warnings || []).length}</div></div>${issues.length ? `<div class="integrity-list">${issues.map(x=>`<div class="integrity-row">${badge(x.severity)}<span class="code">${esc(x.code)}</span><span>${esc(x.message)}</span><span class="code">${esc(x.entity || '-')}</span></div>`).join('')}</div>` : '<div class="integrity-ok">[ BACKUP_HEALTHY ] Restore structure verified.</div>'}`, confirmLabel: '닫기' });
    return;
  }
  const label = action === 'restore' ? 'Restore' : 'Delete';
  const v = await openModal({ title: `Backup ${label}`, message: `${file}\n${action === 'restore' ? 'DB 상태를 이 Backup으로 복원하며 연결이 재설정될 수 있습니다.' : '이 Backup 파일을 삭제합니다.'}`, danger: true, confirmLabel: label.toUpperCase() });
  if (!v) return;
  if (action === 'restore') { const verify=await api(`/api/backups/${encodeURIComponent(file)}/verify`); if(!verify.verification.ok) throw new Error('BACKUP_VERIFY_FAILED'); }
  await api(`/api/backups/${encodeURIComponent(file)}/${action}`, { method: 'POST', body: {} });
  toast(`Backup ${action} 완료`); renderBackups();
}

async function applyVersion() {
  const protocol = Number(document.getElementById('version-protocol').value);
  const serverVersion = document.getElementById('version-server').value.trim();
  const clientVersion = document.getElementById('version-client').value.trim();
  const v = await openModal({ title: 'Version Policy 적용', message: `Protocol >= ${protocol} // Server >= ${serverVersion} // Client >= ${clientVersion}. 기준 미달 연결이 종료될 수 있습니다.`, danger: true, confirmLabel: '적용' });
  if (!v) return;
  await api('/api/system/version', { method: 'POST', body: { protocol, serverVersion, clientVersion } });
  toast('Version Policy 적용 완료'); renderSystem();
}

async function createSchedule() {
  const now = new Date(Date.now() + 3600000);
  const later = new Date(Date.now() + 7200000);
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const v = await openModal({ title: 'Maintenance 예약', fields: [
    { name: 'start', label: '시작', type: 'datetime-local', value: local(now) },
    { name: 'end', label: '종료', type: 'datetime-local', value: local(later) },
    { name: 'message', label: '공지 메시지', value: 'Scheduled maintenance' },
    { name: 'autoDrain', label: 'Auto Drain', type: 'select', options: [{value:'1',label:'ON - 예약 전 Drain 시작'},{value:'0',label:'OFF'}] },
    { name: 'drainLeadMinutes', label: 'Drain 시작 전 시간(분)', type: 'number', value: '15' },
    { name: 'forceStart', label: 'Client 남아도 예약 시각에 Maintenance 시작', type: 'select', options: [{value:'0',label:'OFF - 0명까지 대기 (권장)'},{value:'1',label:'ON - 예약 시각 강제 시작'}] }
  ], confirmLabel: '예약' });
  if (!v) return;
  await api('/api/system/maintenance/schedule', { method: 'POST', body: { startAt: new Date(v.start).getTime(), endAt: new Date(v.end).getTime(), message: v.message, autoDrain: v.autoDrain === '1', drainLeadMinutes: Number(v.drainLeadMinutes)||0, forceStart: v.forceStart === '1' } });
  toast('Maintenance 예약 완료'); renderSystem();
}

async function sendNoticeAll() {
  const v = await openModal({ title: '전체 Notice', fields: [{ name: 'message', label: '공지', type: 'textarea' }], confirmLabel: '전송' });
  if (!v) return;
  const r = await api('/api/system/notice', { method: 'POST', body: v });
  toast(`${r.count}개 Client에 전송 완료`);
}


function ensurePalette() {
  let root = document.getElementById('command-palette');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'command-palette';
  root.className = 'command-palette hidden';
  root.innerHTML = `<div class="palette-backdrop" data-palette-close></div><div class="palette-card"><div class="palette-head"><span>&gt;_ GLOBAL_SEARCH</span><kbd>ESC</kbd></div><input id="palette-input" class="palette-input" placeholder="Server / Client / License / Request 검색"><div id="palette-results" class="palette-results"><div class="palette-hint">CTRL+K // TYPE TO SEARCH</div></div></div>`;
  document.body.appendChild(root);
  root.addEventListener('click', async event => {
    if (event.target.closest('[data-palette-close]')) { closePalette(); return; }
    const row = event.target.closest('[data-palette-kind]');
    if (!row) return;
    const kind = row.dataset.paletteKind;
    const id = row.dataset.paletteId;
    closePalette();
    try {
      if (kind === 'SERVER') { switchView('servers'); await renderCurrent(); await serverAction('detail', id); }
      else if (kind === 'CLIENT') { switchView('clients'); await renderCurrent(); await clientAction('detail', id); }
      else if (kind === 'LICENSE') { licenseQuery = id; licenseStatus = 'ALL'; licenseExpiry = 'ALL'; switchView('licenses'); await renderCurrent(); }
      else if (kind === 'REQUEST') { traceQuery = row.dataset.paletteLabel || id; switchView('trace'); await renderCurrent(); }
    } catch (error) { toast(error.message, true); }
  });
  root.querySelector('#palette-input').addEventListener('input', event => {
    clearTimeout(paletteTimer);
    paletteTimer = setTimeout(() => runPaletteSearch(event.target.value), 140);
  });
  return root;
}

function openPalette() {
  if (!session) return;
  const root = ensurePalette();
  root.classList.remove('hidden');
  const input = root.querySelector('#palette-input');
  input.value = '';
  root.querySelector('#palette-results').innerHTML = '<div class="palette-hint">Server ID / Alias / Client / License Tag / Request ID</div>';
  setTimeout(() => input.focus(), 10);
}

function closePalette() {
  const root = document.getElementById('command-palette');
  if (root) root.classList.add('hidden');
}

async function runPaletteSearch(query) {
  const resultsEl = document.getElementById('palette-results');
  if (!resultsEl) return;
  query = String(query || '').trim();
  if (!query) { resultsEl.innerHTML = '<div class="palette-hint">Server ID / Alias / Client / License Tag / Request ID</div>'; return; }
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(query)}`);
    resultsEl.innerHTML = results.map(r => `<button class="palette-row" data-palette-kind="${esc(r.kind)}" data-palette-id="${esc(r.id)}" data-palette-label="${esc(r.label)}"><span class="palette-kind">${esc(r.kind)}</span><span class="palette-main"><strong>${esc(r.label)}</strong><small>${esc(r.detail)}</small></span>${r.status ? badge(r.status) : ''}</button>`).join('') || '<div class="palette-hint">NO_MATCH</div>';
  } catch (error) { resultsEl.innerHTML = `<div class="palette-hint error-text">${esc(error.message)}</div>`; }
}

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') { event.preventDefault(); openPalette(); return; }
  if (event.key === 'Escape') closePalette();
});



content.addEventListener('change', async event => {
  try {
    const el=event.target.closest('[data-release-channel-select]');
    if(!el)return;
    await api('/api/releases/device-channel',{method:'POST',body:{type:el.dataset.type,id:el.dataset.id,channel:el.value}});
    toast(`${el.dataset.type} ${el.dataset.id} → ${el.value}`);
    await renderReleases();
  } catch(error) { toast(error.message,true); }
});

restoreSession();

// PWA: cache only the static application shell. Authenticated API responses are network-only.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(() => {}));
}
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (installPwaBtn) installPwaBtn.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  if (installPwaBtn) installPwaBtn.classList.add('hidden');
});
if (installPwaBtn) installPwaBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try { await deferredInstallPrompt.userChoice; } catch (_) {}
  deferredInstallPrompt = null;
  installPwaBtn.classList.add('hidden');
});
