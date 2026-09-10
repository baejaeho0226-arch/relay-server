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
const WEB_UI_REVISION = 'fix24';
const menuToggle = document.getElementById('menu-toggle');
function closeMobileMenu() {
  app.classList.remove('menu-open');
  if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
}
if (menuToggle) menuToggle.addEventListener('click', () => {
  const open = app.classList.toggle('menu-open');
  menuToggle.setAttribute('aria-expanded', String(open));
  if (open) nav.querySelector('button.active')?.focus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && app.classList.contains('menu-open')) {
    closeMobileMenu(); menuToggle?.focus();
  }
});
app.addEventListener('click', event => {
  if (event.target === app && app.classList.contains('menu-open')) closeMobileMenu();
});

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
let qrPhotoSerial = 0;
let qrSelectedPreviewDataUrl = '';
let buildSessionServers = [];

async function setQrSelectedFile(file) {
  const serial=++qrPhotoSerial;qrSelectedFile=null;qrSelectedPreviewDataUrl='';
  if(!file)return;
  if(!['image/png','image/jpeg'].includes(file.type)||file.size>8*1024*1024)throw Error('8MB 이하의 PNG 또는 JPEG 사진을 선택해주세요.');
  qrSelectedFile=file;
  try{const preview=await fileAsDataUrl(file);if(serial===qrPhotoSerial)qrSelectedPreviewDataUrl=preview;}
  catch(e){if(serial!==qrPhotoSerial)return;qrSelectedFile=null;throw e;}
}

function clearQrSelectedFile() {
  qrPhotoSerial++;
  qrSelectedFile = null;
  qrSelectedPreviewDataUrl = '';
}

const titles = {
  'member-overview': ['운영 요약', ''],
  'member-news': ['소식', ''],
  'member-products': ['게임', ''],
  'member-profiles': ['회원', ''],
  'member-posts': ['피드', ''],
  'member-comments': ['댓글', ''],
  'member-reports': ['신고', ''],
  'member-orders': ['이용권 내역', ''],
  'member-ledger': ['결제 원장', ''],
  support: ['고객센터', 'APK 사용자와 대화합니다. 미접속 기기에는 다음 고객센터 연결 시 답변이 전달됩니다.'],
  reinstallblocks: ['재설치 차단', "앱 기기 삭제·바인딩 변경과 관계없이 유지되는 재설치 차단을 관리합니다."],
  dashboard: ['대시보드', "중계 서버 전체 상태와 최근 이벤트를 확인합니다."],
  console: ['실시간 이벤트', "중계 서버 이벤트가 실시간으로 스트리밍됩니다."],
  trace: ['요청 추적', "요청 식별자 기준으로 전달/다시 시도/처리 응답 처리 과정을 추적합니다."],
  monitor: ['연결 상태', "서버 / 앱 기기 왕복 지연와 연결 상태를 3초 단위로 감시합니다."],
  terminal: ['관리 명령', "허용된 중계 서버 관리 명령만 실행합니다. OS Shell은 연결되지 않습니다."],
  distribution: ['기기 배정', "서버별 실시간 연결 / 배정 앱 기기 분포와 연결 정리 진행률을 확인합니다."],
  failover: ['장애 전환', "기존 기본 바인딩을 보존한 채 개별 허용 앱 기기만 장애 시 임시 서버로 재배치합니다."],
  recovery: ['요청 복구', "오프라인 대기열, 요청 재전송, 전송 실패 보관함를 관리합니다."],
  notifications: ['알림', '중요 운영 경고와 시스템 이벤트를 확인합니다.'],
  processors: ['처리 정책', "숫자 허용 범위·차단값 정책과 처리기 처리 통계를 관리합니다."],
  reports: ['푸시 · 보고서', "웹 앱 푸시 알림 구독과 날짜별 중계 서버 상태 리포트를 관리합니다."],
  production: ['운영 설정', '1:1 승인, 배포 무결성, 패스키, 감사 체인과 운영 복원력을 통합 관리합니다.'],
  servers: ['서버 기기', 'WinSockServer 연결과 상태를 관리합니다.'],
  clients: ['앱 기기', "APK 앱 기기 연결, 라이선스와 배정을 확인합니다."],
  clientbiometrics: ['생체인증 관리', 'APK의 Android 시스템 생체인증 상태와 재등록을 관리합니다.'],
  buildsessions: ["실행 세션", "실행 이용 권한, APK↔서버 고정 바인딩, 즉시 해제를 관리합니다."],
  licenses: ['라이선스', '라이선스 생성, 연장, 이전 및 상태를 관리합니다.'],
  qrauth: ['QR 인증', 'APK의 QR 사진을 서버에서 검증하고 해당 기기를 승인합니다.'],
  releases: ['앱 배포', "자동 업데이트, 배포 채널, 단계별 배포을 관리합니다."],
  features: ['기능 설정', "전역 기능과 서버 / 앱 기기별 개별 설정를 관리합니다."],
  confighistory: ['설정 이력', "실행 설정와 Feature 기능 변경 이력 및 되돌리기을 관리합니다."],
  enrollment: ['기기 등록', "새 서버 / 앱 기기의 최초 등록 승인 정책을 관리합니다."],
  protocol: ['프로토콜', "프로토콜 v3 준비도, 기기 HMAC, 이벤트 이벤트 순서 상태를 확인합니다."],
  security: ['보안 상태', "HMAC 검증, 기기 등록, 기기 인증키 수명과 인증 이상을 한 화면에서 확인합니다."],
  audit: ['감사 기록', '최근 서버 이벤트와 관리 작업 기록입니다.'],
  activity: ['관리자 활동', "웹 관리자에서 수행된 관리 작업과 결과를 추적합니다."],
  sessions: ['로그인 세션', "현재 웹 관리자 로그인 세션을 확인하고 종료합니다."],
  backups: ['백업 · 복원', "중계 서버 데이터베이스 백업과 복원을 관리합니다."],
  health: ['시스템 상태', "실행 환경 / 데이터베이스 / 백업 / 감사 기록 / 중계 서버 상태를 진단합니다."],
  loadlab: ['부하 테스트', "별도 프로세스에서 중계 서버 연결/프로토콜 부하 테스트 명령을 생성합니다."],
  ha: ['이중화 관리', "중계 서버 A/B 활성/대기, 상태 복제 및 승격 상태를 확인합니다."],
  storage: ['저장소', '실제 SQLite 기본 저장소, JSON 자동 이관 및 복구 미러 상태를 확인합니다.'],
  system: ['System', '서비스, 유지보수 및 최소 버전 정책을 관리합니다.'],
  danger: ["주의가 필요한 작업", '복구 영향이 큰 작업만 별도로 실행합니다.']
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
  if (type === 'TYPE2') return uiText('R2Beat');
  if (type === 'TYPE3') return uiText('Lostsaga');
  return uiText('TalesRunner');
}

function accessTypeBadge(value) {
  return `<span class="badge good">${esc(accessTypeName(value))}</span>`;
}

function processorDisplayName(value) {
  return String(value || '')
    .replace(/^TYPE1(?=\/|$)/i, '테일즈런너')
    .replace(/^TYPE2(?=\/|$)/i, '알투비트')
    .replace(/^TYPE3(?=\/|$)/i, '로스트사가').replace(/DEFAULT/g, '기본');
}

function badge(value) {
  const text = String(value || 'UNKNOWN').toUpperCase();
  let cls = text.toLowerCase();
  if (['GOOD', 'ONLINE', 'BOUND', 'AVAILABLE', 'ACTIVE', 'APPROVED', 'AUTHORIZED', 'SET', 'MATCHED', 'READY'].includes(text)) cls = 'good';
  else if (['SLOW', 'UNSTABLE', 'DRAINING', 'KICKED', 'FLAPPING', 'WARNING', 'STANDBY', 'CANDIDATE', 'PENDING', 'FULL'].includes(text)) cls = 'warn';
  else if (['OFFLINE', 'DISABLED', 'EXPIRED', 'SUSPENDED', 'CRITICAL', 'REJECTED', 'SUPERSEDED', 'LOCKED', 'REVOKED', 'FAILED', 'MISMATCH'].includes(text)) cls = 'bad';
  else if (text === 'NONE') cls = 'none';
  return `<span class="badge ${esc(cls)}">${esc(uiText(text))}</span>`;
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = uiText(message);
  toastEl.className = `toast${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3200);
}

function readableApiError(code) {
  if(code==='INVALID_SUPPORT_FAQ')return '질문·답변 길이, 검색어 8개 이하, FAQ 12개 이하인지 확인해주세요.';
  if(code==='FAQ_NOT_FOUND')return '삭제되었거나 없는 질문입니다. 목록을 다시 확인해주세요.';
  if(code==='HISTORY_CHANGED')return '다른 곳에서 내용이 변경되었습니다. 최신 상태를 불러온 뒤 다시 시도해주세요.';
  if (code === 'PERMISSIONS_REQUIRED') return '기기의 필수 권한을 모두 허용한 뒤 다시 승인해주세요.';
  if (code === 'QR_REQUEST_SUPERSEDED') return '이전 QR이 해제되었습니다. 앱에 새로 표시된 QR을 사용해주세요.';
  return uiError(code);
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
    throw new Error(`${readableApiError(data && data.error || `HTTP_${response.status}`)}${detail}`);
  }
  if (!data || typeof data !== 'object') throw new Error(`EMPTY_API_RESPONSE [${method} ${url}]`);
  if (!['GET', 'HEAD'].includes(method)) dirtyViews.delete(currentView);
  return data;
}

function showLogin() {
  if (typeof resetSupportUiState === 'function') resetSupportUiState();
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
  roleLabel.textContent = uiText(session.role.toUpperCase());
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
    webVersionLabel.textContent = `웹 v${system.webAdminVersion || '4.13.0'} · 화면 ${WEB_UI_REVISION}`;
  } catch (_) {
    webVersionLabel.textContent = `웹 v4.13.0 · 화면 ${WEB_UI_REVISION}`;
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
  row.innerHTML = `<span class="console-time">${esc(fmtTime(event.time))}</span><span class="console-type">${esc(uiText(event.type))}</span><span class="console-detail">${esc(event.detail)}</span>`;
  list.appendChild(row);
  while (list.children.length > 300) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}

function startEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('ready', () => {
    liveState.textContent = "실시간 연결";
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
  eventSource.addEventListener('service-state', event => {
    try { const status = JSON.parse(event.data); if (!status.enabled) resetServiceUi(); renderCurrent(true); } catch (_) {}
  });
  eventSource.addEventListener('tick', () => {
    if (document.hidden || rendering) return;
    const liveViews = ['support', 'reinstallblocks', 'dashboard', 'monitor', 'distribution', 'failover', 'recovery', 'servers', 'clients', 'clientbiometrics', 'buildsessions', 'qrauth', 'notifications', 'processors', 'reports', 'sessions', 'health', 'system', 'features', 'confighistory', 'enrollment', 'releases', 'security', 'protocol', 'loadlab', 'storage', 'danger'];
    const qrEditInProgress = currentView === 'qrauth' && (qrSelectedFile || qrScanResult);
    if (liveViews.includes(currentView) && !qrEditInProgress) renderCurrent(true);
    updateNotificationBadge();
    updateQrAuthBadge();
  });
  eventSource.addEventListener('session', () => showLogin());
  eventSource.onerror = () => {
    liveState.textContent = "재연결 중";
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
  if (button) closeMobileMenu();
  if (!button) return;
  dirtyViews.delete(currentView);
  switchView(button.dataset.view);
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
  if (silent && (dirtyViews.has(currentView) || content.contains(document.activeElement) && document.activeElement.matches('input,textarea,select'))) return;
  if (!silent) dirtyViews.delete(currentView);
  const view = currentView;
  const scrollState = silent ? captureScrollState(view) : null;
  rendering = true;
  const meta = titles[currentView] || titles.dashboard;
  pageTitle.textContent = meta[0];
  pageSubtitle.textContent = meta[1];
  if (!silent) content.innerHTML = '<div class="empty">불러오는 중...</div>';
  try {
    if (isMemberPage()) await renderMember();
    else if (currentView === 'dashboard') await renderDashboard();
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
    else if (currentView === 'production') await renderProductionHardening();
    else if (currentView === 'servers') await renderServers();
    else if (currentView === 'clients') await renderClients();
    else if (currentView === 'support') await renderSupportCenter();
    else if (currentView === 'reinstallblocks') await renderReinstallBlocks();
    else if (currentView === 'clientbiometrics') await renderClientBiometrics();
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
      content.innerHTML = `<div class="api-error"><strong>요청을 처리하지 못했습니다.</strong><span>${esc(error.message)}</span><small>새로고침 후에도 반복되면 서버 로그의 참조 번호를 확인하세요.</small></div>`;
      toast(error.message, true);
    } else {
      console.warn(`[WEB AUTO REFRESH] ${view}:`, error.message);
    }
  } finally {
    if (scrollState) restoreScrollState(scrollState);
    rendering = false;
    if (view !== currentView) renderCurrent();
  }
}


function isMemberPage(view=currentView) { return view.startsWith('member-') && Object.hasOwn(memberTabs,view.slice(7)); }
function switchView(view) {
  if(view==='member')view='member-overview';
  if(isMemberPage(view)&&currentView!==view){memberView=view.slice(7);memberOffset=0;memberFilter='';memberQuery='';memberSort='recent';memberSelected.clear();memberFingerprint='';memberRenderSerial++;}
  if (currentView !== view) dirtyViews.delete(currentView);
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
