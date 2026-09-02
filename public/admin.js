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
const qrAuthBadge = document.getElementById('qr-auth-badge');
const navFilter = document.getElementById('nav-filter');
const installPwaBtn = document.getElementById('install-pwa-btn');
const webVersionLabel = document.getElementById('web-version-label');

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
let consoleHistoryLoaded = false;
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
let qrScanResult = null;
let qrSelectedFile = null;
let qrSelectedPreviewDataUrl = '';
let buildSessionServers = [];

async function setQrSelectedFile(file) {
  qrSelectedFile = file || null;
  qrSelectedPreviewDataUrl = qrSelectedFile ? await fileAsDataUrl(qrSelectedFile) : '';
}

function clearQrSelectedFile() {
  qrSelectedFile = null;
  qrSelectedPreviewDataUrl = '';
}

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
  processors: ['Number Processing', '숫자 허용 범위·차단값 정책과 Processor 처리 통계를 관리합니다.'],
  reports: ['Push / Daily Report', 'PWA Push 구독과 날짜별 Relay Health 리포트를 관리합니다.'],
  servers: ['Servers', 'WinSockServer 연결과 상태를 관리합니다.'],
  clients: ['Clients', 'APK Client 연결, 라이선스와 배정을 확인합니다.'],
  clientpasswords: ['Client PIN 관리', 'APK Client PIN 상태 확인과 안전한 재설정을 수행합니다.'],
  buildsessions: ['Build Sessions', 'Build Lease, APK↔Server 고정 바인딩, 즉시 Revoke를 관리합니다.'],
  licenses: ['Licenses', '라이선스 생성, 연장, 이전 및 상태를 관리합니다.'],
  qrauth: ['QR 인증', 'APK의 QR 사진을 서버에서 검증하고 해당 기기를 승인합니다.'],
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
  ha: ['Relay HA', 'Relay A/B Active/Standby, 상태 복제 및 승격 상태를 확인합니다.'],
  storage: ['SQLite Storage', '실제 SQLite 기본 저장소, JSON 자동 이관 및 복구 미러 상태를 확인합니다.'],
  system: ['System', '서비스, 유지보수 및 최소 버전 정책을 관리합니다.'],
  danger: ['Danger Zone', '복구 영향이 큰 작업만 별도로 실행합니다.']
};

const requestedStartupView = new URLSearchParams(location.search).get('view');
if (requestedStartupView && Object.prototype.hasOwnProperty.call(titles, requestedStartupView)) currentView = requestedStartupView;

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

function accessTypeName(value) {
  const type = String(value || 'TYPE1').trim().toUpperCase();
  if (type === 'TYPE2') return 'R2Beat';
  if (type === 'TYPE3') return 'Lostsaga';
  return 'TalesRunner';
}

function accessTypeBadge(value) {
  return `<span class="badge good">${esc(accessTypeName(value))}</span>`;
}

function processorDisplayName(value) {
  return String(value || '')
    .replace(/^TYPE1(?=\/|$)/i, 'TalesRunner')
    .replace(/^TYPE2(?=\/|$)/i, 'R2Beat')
    .replace(/^TYPE3(?=\/|$)/i, 'Lostsaga');
}

function badge(value) {
  const text = String(value || 'UNKNOWN').toUpperCase();
  let cls = text.toLowerCase();
  if (['GOOD', 'ONLINE', 'BOUND', 'AVAILABLE', 'ACTIVE', 'APPROVED', 'AUTHORIZED', 'SET', 'MATCHED', 'READY'].includes(text)) cls = 'good';
  else if (['SLOW', 'UNSTABLE', 'DRAINING', 'KICKED', 'FLAPPING', 'WARNING', 'STANDBY', 'CANDIDATE', 'PENDING', 'FULL'].includes(text)) cls = 'warn';
  else if (['OFFLINE', 'DISABLED', 'EXPIRED', 'SUSPENDED', 'CRITICAL', 'REJECTED', 'SUPERSEDED', 'LOCKED', 'REVOKED', 'FAILED', 'MISMATCH'].includes(text)) cls = 'bad';
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
  const responseText = await response.text();
  let data = null;
  if (responseText) {
    try { data = JSON.parse(responseText); }
    catch (_) {
      throw new Error(`INVALID_API_RESPONSE [${method} ${url}]`);
    }
  }
  if (response.status === 401) {
    showLogin();
    throw new Error('로그인이 만료되었습니다.');
  }
  if (!response.ok || (data && data.ok === false)) {
    const detail = data && data.detail ? ` [${data.detail}]` : '';
    throw new Error(`${data && data.error || `HTTP_${response.status}`}${detail}`);
  }
  if (!data || typeof data !== 'object') throw new Error(`EMPTY_API_RESPONSE [${method} ${url}]`);
  return data;
}

function showLogin() {
  session = null;
  qrScanResult = null;
  clearQrSelectedFile();
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
  switchView(currentView);
  startEvents();
  updateNotificationBadge();
  updateQrAuthBadge();
  updateWebVersion();
  renderCurrent();
}

async function updateWebVersion() {
  if (!webVersionLabel) return;
  try {
    const { system } = await api('/api/system');
    webVersionLabel.textContent = `WEB v${system.webAdminVersion || '3.5.0'}`;
  } catch (_) {
    webVersionLabel.textContent = 'WEB v3.5.0';
  }
}

function pushLiveEvent(event) {
  if (!event || !event.type) return;
  liveConsoleEvents.push(event);
  if (liveConsoleEvents.length > 500) liveConsoleEvents.shift();
  if (consolePaused || currentView !== 'console') return;
  const list = document.getElementById('live-console-list');
  if (!list) return;
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
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
    const liveViews = ['dashboard', 'monitor', 'distribution', 'failover', 'recovery', 'servers', 'clients', 'clientpasswords', 'buildsessions', 'qrauth', 'notifications', 'processors', 'reports', 'sessions', 'health', 'system', 'features', 'confighistory', 'enrollment', 'releases', 'security', 'protocol', 'loadlab', 'storage', 'danger'];
    const qrEditInProgress = currentView === 'qrauth' && (qrSelectedFile || qrScanResult);
    if (liveViews.includes(currentView) && !qrEditInProgress) renderCurrent(true);
    updateNotificationBadge();
    updateQrAuthBadge();
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

if (navFilter) navFilter.addEventListener('input', () => {
  const query = navFilter.value.trim().toLowerCase();
  nav.querySelectorAll('.nav-group').forEach(group => {
    let visible = 0;
    group.querySelectorAll('button[data-view]').forEach(button => {
      const match = !query || button.textContent.toLowerCase().includes(query);
      button.classList.toggle('nav-filter-hidden', !match);
      if (match) visible++;
    });
    group.classList.toggle('nav-filter-hidden', visible === 0);
    if (query && visible) group.open = true;
  });
});

function roleIsAdmin() { return session && session.role === 'admin'; }
function roleCanOperate() { return session && (session.role === 'admin' || session.role === 'operator'); }

const PRESERVED_SCROLL_SELECTOR = '.table-wrap,.live-console,.event-list,.terminal-output,.command-terminal-output';

function captureScrollState(view) {
  const scrolling = document.scrollingElement || document.documentElement;
  return {
    view,
    documentTop: scrolling ? scrolling.scrollTop : 0,
    documentLeft: scrolling ? scrolling.scrollLeft : 0,
    navTop: nav ? nav.scrollTop : 0,
    nodes: Array.from(content.querySelectorAll(PRESERVED_SCROLL_SELECTOR)).map((element, index) => ({
      element,
      index,
      signature: `${element.tagName}|${element.id}|${element.className}`,
      top: element.scrollTop,
      left: element.scrollLeft
    }))
  };
}

function restoreScrollState(snapshot) {
  if (!snapshot || snapshot.view !== currentView) return;
  const scrolling = document.scrollingElement || document.documentElement;
  if (scrolling) {
    scrolling.scrollTop = snapshot.documentTop;
    scrolling.scrollLeft = snapshot.documentLeft;
  }
  if (nav) nav.scrollTop = snapshot.navTop;
  const nodes = Array.from(content.querySelectorAll(PRESERVED_SCROLL_SELECTOR));
  for (const saved of snapshot.nodes) {
    let element = nodes[saved.index];
    const signature = element ? `${element.tagName}|${element.id}|${element.className}` : '';
    if (!element || signature !== saved.signature) {
      element = nodes.find(candidate => `${candidate.tagName}|${candidate.id}|${candidate.className}` === saved.signature);
    }
    if (!element) continue;
    element.scrollTop = saved.element ? saved.element.scrollTop : saved.top;
    element.scrollLeft = saved.element ? saved.element.scrollLeft : saved.left;
  }
}

async function renderCurrent(silent = false) {
  if (!session || rendering) return;
  const view = currentView;
  const scrollState = silent ? captureScrollState(view) : null;
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
    else if (currentView === 'processors') await renderProcessors();
    else if (currentView === 'reports') await renderReports();
    else if (currentView === 'servers') await renderServers();
    else if (currentView === 'clients') await renderClients();
    else if (currentView === 'clientpasswords') await renderClientPasswords();
    else if (currentView === 'buildsessions') await renderBuildSessions();
    else if (currentView === 'qrauth') await renderQrAuth();
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
    else if (currentView === 'ha') await renderHA();
    else if (currentView === 'loadlab') await renderLoadSimulator();
    else if (currentView === 'storage') await renderStorageMigration();
    else if (currentView === 'system') await renderSystem();
    else if (currentView === 'danger') await renderDangerZone();
  } catch (error) {
    if (!silent) {
      content.innerHTML = `<div class="api-error"><strong>REQUEST FAILED</strong><span>${esc(error.message)}</span><small>새로고침 후에도 반복되면 서버 로그의 REF 번호를 확인하세요.</small></div>`;
      toast(error.message, true);
    } else {
      console.warn(`[WEB AUTO REFRESH] ${view}:`, error.message);
    }
  } finally {
    if (scrollState) restoreScrollState(scrollState);
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

// Remaining page renderers and actions are loaded from modular admin-*.js files.
