'use strict';

// ACCESS / QR / BUILD PAGES

async function renderNotifications(silent = false) {
  const { summary, notifications } = await api('/api/notifications?limit=300');
  if (!silent) updateNotificationBadge();
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">UNREAD</div><div class="stat-value">${summary.unread}</div><div class="stat-sub">Total ${summary.total}</div></div><div class="card"><div class="stat-label">CRITICAL</div><div class="stat-value">${summary.critical}</div><div class="stat-sub">Immediate attention</div></div><div class="card"><div class="stat-label">WARNING</div><div class="stat-value">${summary.warning}</div><div class="stat-sub">Operational warnings</div></div></div>
  <div class="toolbar"><button id="notification-read-all-btn">모두 읽음</button>${roleIsAdmin() ? '<button id="notification-clear-btn" class="danger">전체 지우기</button>' : ''}<span class="small-note">ACK timeout / Server offline / Flapping / License expiry / DB recovery</span></div>
  <div class="notification-list">${notifications.map(n => `<div class="notification-item ${n.read ? 'read' : 'unread'} ${esc(n.severity.toLowerCase())}"><div class="notification-icon">${n.severity === 'CRITICAL' ? '!' : n.severity === 'WARNING' ? '▲' : '•'}</div><div class="notification-main"><div class="notification-title">${badge(n.severity)} <strong>${esc(n.title)}</strong> ${n.count > 1 ? `<span class="nav-count">×${n.count}</span>` : ''}</div><div class="notification-message">${esc(n.message)}</div><div class="small-note">${esc(n.type)} // ${esc(fmtTime(n.updatedAt || n.createdAt))}${n.entityId ? ` // ${esc(n.entityId)}` : ''}</div></div>${!n.read ? `<button data-notification-read="${esc(n.id)}">읽음</button>` : ''}</div>`).join('') || '<div class="empty">알림 없음</div>'}</div>`;
}

async function renderProcessors() {
  const { processors } = await api('/api/processors');
  const p = processors.policy;
  const controls = roleIsAdmin() ? `<div class="actions"><button id="processor-save-btn" class="primary">정책 저장 / 배포</button><button id="processor-push-btn">ONLINE 서버 재전송</button><button id="processor-reset-stats-btn" class="danger">통계 초기화</button></div>` : '';
  content.innerHTML = `<div class="cards">
    <div class="card"><div class="stat-label">POLICY REVISION</div><div class="stat-value">${p.revision}</div><div class="stat-sub">${p.enabled ? 'ENABLED' : 'BYPASS'}</div></div>
    <div class="card"><div class="stat-label">PROCESSOR</div><div class="stat-value compact">${esc(p.processor)}</div><div class="stat-sub">Server-side execution</div></div>
    <div class="card"><div class="stat-label">BLOCKED VALUES</div><div class="stat-value">${p.blockedValues.length}</div><div class="stat-sub">Int64 exact-match rules</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>Number Policy</h3>${controls}</div><div class="section-body"><div class="grid-2">
    <label>Policy Mode<select id="processor-enabled" ${roleIsAdmin()?'':'disabled'}><option value="1" ${p.enabled?'selected':''}>ENABLED</option><option value="0" ${!p.enabled?'selected':''}>BYPASS</option></select></label>
    <label>Processor<select id="processor-name" ${roleIsAdmin()?'':'disabled'}><option value="DEFAULT">DEFAULT</option></select></label>
    <label>Minimum (empty = none)<input id="processor-min" class="code" value="${esc(p.minValue)}" placeholder="-9223372036854775808" ${roleIsAdmin()?'':'disabled'}></label>
    <label>Maximum (empty = none)<input id="processor-max" class="code" value="${esc(p.maxValue)}" placeholder="9223372036854775807" ${roleIsAdmin()?'':'disabled'}></label>
  </div><label>Blocked values (comma / whitespace, max 100)<textarea id="processor-blocked" class="code" ${roleIsAdmin()?'':'disabled'}>${esc(p.blockedValues.join(', '))}</textarea></label><p class="small-note">Int64 값은 JavaScript Number로 변환하지 않고 문자열 그대로 검증·저장되어 정밀도를 유지합니다.</p></div></div>
  <div class="section-card"><div class="section-head"><h3>Content Processor Routing</h3><span class="small-note">CONTENT IS VERIFIED BY BUILD SESSION</span></div><div class="table-wrap"><table><thead><tr><th>APK Content</th><th>WinSockServer Processor</th><th>Trust Source</th></tr></thead><tbody>${(processors.routes||[]).map(x=>`<tr><td>${accessTypeBadge(x.accessType)}</td><td class="code">${esc(processorDisplayName(x.processor))}</td><td>HMAC Build Session</td></tr>`).join('')}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>Processor Statistics</h3><span class="small-note">ACK PROCESS_RESULT</span></div><div class="table-wrap"><table><thead><tr><th>Processor</th><th>Requests</th><th>Success</th><th>Error</th><th>Success Rate</th><th>Average</th><th>Maximum</th><th>Last Error</th><th>Last ACK</th></tr></thead><tbody>${processors.stats.map(x=>`<tr><td class="code">${esc(processorDisplayName(x.processor))}</td><td>${x.requests}</td><td>${x.success}</td><td>${x.error}</td><td>${x.successRate}%</td><td>${x.avgMs} ms</td><td>${x.maxMs} ms</td><td class="code">${esc(x.lastError||'-')}</td><td>${esc(fmtTime(x.lastAt))}</td></tr>`).join('')||'<tr><td colspan="9" class="empty">통계 없음</td></tr>'}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>Server Policy Sync</h3></div><div class="table-wrap"><table><thead><tr><th>Server</th><th>Online</th><th>Sent</th><th>ACK Revision</th><th>ACK Status</th><th>Detail</th></tr></thead><tbody>${processors.servers.map(x=>`<tr><td class="code">${esc(x.serverId)}</td><td>${badge(x.online?'ONLINE':'OFFLINE')}</td><td>${esc(fmtTime(x.sentAt))}</td><td>${x.ack?x.ack.revision:'-'}</td><td>${x.ack?badge(x.ack.status):badge('NONE')}</td><td class="code">${esc(x.ack&&x.ack.detail||'-')}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">Server 없음</td></tr>'}</tbody></table></div></div>`;
}

async function renderBuildSessions() {
  const data = await api('/api/build-sessions');
  const summary = data.summary || {};
  const policy = summary.policy || { ttlMinutes: 30 };
  const sessions = data.sessions || [];
  const bindings = data.bindings || [];
  buildSessionServers = data.servers || [];
  const now = Date.now();
  const bindingRows = bindings.map(row => {
    const binding = row.binding || null;
    const active = row.activeSession || null;
    return `<tr>
      <td class="code">${esc(row.clientId)}</td>
      <td class="code">${esc(row.assignedServerId || '-')}</td>
      <td class="code">${esc(binding ? binding.serverId : '-')}</td>
      <td>${badge(row.matched ? 'MATCHED' : 'MISMATCH')}</td>
      <td>${active ? badge(active.status) : badge('NONE')}</td>
      <td>${binding ? esc(fmtTime(binding.updatedAt || binding.boundAt)) : '-'}</td>
      <td><button data-build-rebind="${esc(row.clientId)}" data-current-server="${esc(binding ? binding.serverId : row.assignedServerId || '')}">${binding ? 'REBIND' : 'BIND'}</button></td>
    </tr>`;
  }).join('');
  const sessionRows = sessions.map(item => `<tr>
    <td>${badge(item.status)}</td>
    <td class="code">${esc(item.sessionId)}</td>
    <td class="code">${esc(item.clientId)}</td>
    <td class="code">${esc(item.serverId)}</td>
    <td>${accessTypeBadge(item.accessType)}</td>
    <td class="code">${esc(item.requestId)}</td>
    <td>${esc(fmtTime(item.authorizedAt || item.createdAt))}</td>
    <td>${esc(fmtTime(item.expiresAt))}${item.status === 'AUTHORIZED' ? `<div class="small-note">${esc(fmtDuration(item.expiresAt - now))} 남음</div>` : ''}</td>
    <td class="code">${esc(item.reason || '-')}</td>
    <td>${item.status === 'AUTHORIZED' ? `<button class="danger" data-build-revoke="${esc(item.sessionId)}">REVOKE NOW</button>` : '-'}</td>
  </tr>`).join('');
  content.innerHTML = `<div class="cards">
    <div class="card"><div class="stat-label">ACTIVE LEASES</div><div class="stat-value">${summary.active || 0}</div><div class="stat-sub">TTL ${policy.ttlMinutes || 30} minutes</div></div>
    <div class="card"><div class="stat-label">PENDING</div><div class="stat-value">${summary.pending || 0}</div><div class="stat-sub">APK Build waiting</div></div>
    <div class="card"><div class="stat-label">FIXED BINDINGS</div><div class="stat-value">${summary.bindings || 0}</div><div class="stat-sub">First successful pair</div></div>
    <div class="card"><div class="stat-label">ENDED</div><div class="stat-value">${Number(summary.expired || 0) + Number(summary.revoked || 0) + Number(summary.failed || 0)}</div><div class="stat-sub">Expired ${summary.expired || 0} · Revoked ${summary.revoked || 0} · Failed ${summary.failed || 0}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>Build Session Lease Policy</h3><span class="small-note">1~1440 MINUTES · NEW SESSIONS ONLY</span></div><div class="section-body"><div class="toolbar"><label>Lease TTL (minutes)<input id="build-session-ttl" type="number" min="1" max="1440" value="${Number(policy.ttlMinutes) || 30}"></label><button id="build-session-policy-save" class="primary">SAVE POLICY</button></div><p class="small-note">Lease가 끝나거나 APK·라이선스·HMAC·Server 연결이 끊기면 WinSockServer가 즉시 다시 잠깁니다.</p></div></div>
  <div class="section-card"><div class="section-head"><h3>APK ↔ WinSockServer Fixed Binding</h3><span class="small-note">WEB ADMIN REBIND ONLY</span></div><div class="table-wrap"><table><thead><tr><th>Client</th><th>Assigned Server</th><th>Build Binding</th><th>Match</th><th>Active</th><th>Updated</th><th>Action</th></tr></thead><tbody>${bindingRows || '<tr><td colspan="7" class="empty">Client 없음</td></tr>'}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>Build Session History</h3><div class="actions"><span class="small-note">활성 세션 보존</span>${roleIsAdmin()?'<button class="danger" data-history-clean="BUILD_SESSIONS">CLEAN HISTORY</button>':''}</div></div><div class="table-wrap"><table><thead><tr><th>Status</th><th>Session</th><th>Client</th><th>Server</th><th>Content</th><th>Request</th><th>Authorized</th><th>Expires</th><th>Reason</th><th>Action</th></tr></thead><tbody>${sessionRows || '<tr><td colspan="10" class="empty">Build Session 없음</td></tr>'}</tbody></table></div></div>`;
}

async function currentPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(x => x.charCodeAt(0)));
}

async function renderReports() {
  const [{ push }, { daily }] = await Promise.all([api('/api/push/status'), api('/api/reports/daily?limit=120')]);
  let ownSubscription = null;
  try { ownSubscription = await currentPushSubscription(); } catch (_) {}
  const c = daily.current;
  content.innerHTML = `<div class="cards">
    <div class="card"><div class="stat-label">PUSH SERVICE</div><div class="stat-value compact">${push.available?'READY':'OFF'}</div><div class="stat-sub">${push.available?`${push.subscriptions} subscription(s)`:esc(push.reason)}</div></div>
    <div class="card"><div class="stat-label">THIS BROWSER</div><div class="stat-value compact">${ownSubscription?'ON':'OFF'}</div><div class="stat-sub">Permission: ${esc(('Notification' in window)?Notification.permission:'unsupported')}</div></div>
    <div class="card"><div class="stat-label">REPORT DATE</div><div class="stat-value compact">${esc(c.date)}</div><div class="stat-sub">${esc(daily.timezone)}</div></div>
    <div class="card"><div class="stat-label">ACK SUCCESS</div><div class="stat-value">${c.ack.successRate}%</div><div class="stat-sub">Timeout ${c.ack.timeout}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>PWA Push</h3>${roleIsAdmin()?`<div class="actions"><button id="push-enable-btn" class="primary" ${push.available&&!ownSubscription?'':'disabled'}>이 브라우저 구독</button><button id="push-disable-btn" ${ownSubscription?'':'disabled'}>구독 해제</button><button id="push-test-btn">TEST PUSH</button></div>`:''}</div><div class="section-body"><p class="muted">Admin이 구독한 브라우저에 WARNING / CRITICAL 운영 알림을 Web Admin이 닫힌 상태에서도 전달합니다. Daily Health 완료 알림도 하루 한 번 전송됩니다.</p>${push.available?'':`<div class="integrity-row">${badge('WARNING')}<span class="code">${esc(push.reason)}</span><span>Railway 환경변수 VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT를 설정하세요.</span></div>`}</div></div>
  <div class="section-card"><div class="section-head"><h3>Today Health Preview</h3>${roleIsAdmin()?'<button id="report-generate-btn" class="primary">현재 리포트 저장</button>':''}</div><div class="section-body"><div class="kv"><div>Servers</div><div>${c.servers.online} / ${c.servers.total} (Peak ${c.servers.peak})</div><div>Clients</div><div>${c.clients.online} / ${c.clients.total} (Peak ${c.clients.peak})</div><div>Connections / SEND</div><div>${c.connections} / ${c.sends}</div><div>ACK OK / Error / Timeout</div><div>${c.ack.ok} / ${c.ack.error} / ${c.ack.timeout}</div><div>Flapping</div><div>${c.flapping}</div><div>Licenses ≤7d</div><div>${c.licensesExpiring7d}</div><div>Backup</div><div>${badge(c.backup.ok?'GOOD':'WARNING')} ${esc(fmtTime(c.backup.lastAt))}</div><div>Database</div><div>${badge(c.database.ok?'GOOD':'CRITICAL')} ${esc(fmtTime(c.database.lastSaveAt))}</div></div></div></div>
  <div class="section-card"><div class="section-head"><h3>Daily History</h3><div class="actions"><span class="small-note">RETENTION ${daily.reports.length} / 365</span>${roleIsAdmin()?'<button class="danger" data-history-clean="DAILY_REPORTS">CLEAN HISTORY</button>':''}</div></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Servers</th><th>Clients</th><th>Connections</th><th>SEND</th><th>ACK Success</th><th>Error</th><th>Timeout</th><th>Flapping</th><th>Licenses ≤7d</th><th>Backup</th><th>DB</th><th>Generated</th></tr></thead><tbody>${daily.reports.map(r=>`<tr><td class="code">${esc(r.date)}</td><td>${r.servers.online}/${r.servers.total}</td><td>${r.clients.online}/${r.clients.total}</td><td>${r.connections}</td><td>${r.sends}</td><td>${r.ack.successRate}%</td><td>${r.ack.error}</td><td>${r.ack.timeout}</td><td>${r.flapping}</td><td>${r.licensesExpiring7d}</td><td>${badge(r.backup.ok?'GOOD':'WARNING')}</td><td>${badge(r.database.ok?'GOOD':'CRITICAL')}</td><td>${esc(fmtTime(r.generatedAt))}</td></tr>`).join('')||'<tr><td colspan="13" class="empty">저장된 Daily Report 없음</td></tr>'}</tbody></table></div></div>`;
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
    return `<div class="actions">${detail}${alias}${note}${kick}${drain}${enabled}<button class="danger" data-server-action="delete" data-id="${id}">Delete</button></div>`;
  };

  content.innerHTML = `<div class="toolbar">${roleIsAdmin()?'<button id="pairing-repair-btn" class="primary">1:1 MATCH REPAIR</button>':''}<span class="small-note">Delete는 장비 ID와 종속 바인딩을 제거 · 재접속 시 신규 장비로 등록</span></div><div class="table-wrap"><table><thead><tr><th>Alias</th><th>SERVER-ID</th><th>Status</th><th>Health</th><th>Accept</th><th>Clients</th><th>Drain</th><th>RTT</th><th>Version</th><th>IP</th><th>Last Seen</th><th>Reconnect</th><th>Note</th><th>Action</th></tr></thead><tbody>
    ${servers.map(s => `<tr><td>${esc(s.alias || '-')}</td><td class="code">${esc(s.id)}</td><td>${badge(s.status)}</td><td>${badge(s.health)}</td><td>${badge(s.acceptState || (s.canAcceptClients ? 'READY' : 'OFFLINE'))}</td><td>${s.clients} / ${s.savedClients}</td><td>${s.drain && s.drain.active ? `<div class="drain-inline"><strong>${s.drain.ready ? 'READY' : `${s.drain.progress}%`}</strong><span>${s.drain.currentClients} live</span></div>` : '-'}</td><td>${s.rttMs >= 0 ? `${s.rttMs} ms` : '-'}</td><td>${esc(s.appVersion || '-')}</td><td>${esc(s.lastIP || '-')}</td><td>${esc(fmtTime(s.lastSeen))}</td><td>${s.reconnectCount}</td><td class="note-cell" title="${esc(s.note || '')}">${esc(s.note || '-')}</td><td>${actions(s)}</td></tr>`).join('') || '<tr><td colspan="15" class="empty">Server 없음</td></tr>'}
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
      html += `<button class="primary" data-client-action="password" data-id="${id}">PIN 관리</button>`;
      html += `<button data-client-action="alias" data-id="${id}">Alias</button>`;
      html += `<button data-client-action="move" data-id="${id}">Move</button>`;
      if (client.online && client.status !== 'DISABLED') html += `<button class="warning" data-client-action="kick" data-id="${id}">Kick 60s</button>`;
      html += client.status === 'DISABLED'
        ? `<button class="primary" data-client-action="enable" data-id="${id}">Enable</button>`
        : `<button class="danger" data-client-action="disable" data-id="${id}">Disable</button>`;
      html += `<button class="danger" data-client-action="delete" data-id="${id}">Delete</button>`;
    }
    return `<div class="actions">${html}</div>`;
  };

  content.innerHTML = `<div class="toolbar">${roleIsAdmin() ? '<button id="pairing-repair-btn" class="primary">1:1 MATCH REPAIR</button><button class="primary pin-manage-open" data-open-view="clientpasswords">CLIENT PIN 관리 열기</button>' : ''}<span class="small-note">Delete는 QR/PIN/바인딩을 포함한 Client 등록 전체 삭제</span></div><div class="table-wrap"><table><thead><tr><th>Alias</th><th>CLIENT-ID</th><th>Status</th><th>Health</th><th>PIN</th><th>Server</th><th>License</th><th>Expires</th><th>RTT</th><th>Send</th><th>Last Seen</th><th>Note</th><th>Action</th></tr></thead><tbody>
    ${clients.map(c => `<tr><td>${esc(c.alias || '-')}</td><td class="code">${esc(c.id)}</td><td>${badge(c.status)}</td><td>${badge(c.health)}</td><td>${badge(c.password?.locked ? 'LOCKED' : (c.password?.registered ? 'SET' : 'NONE'))}</td><td class="code">${esc(c.serverAlias || c.serverId)}</td><td>${badge(c.licenseStatus)}</td><td>${esc(fmtTime(c.licenseExpiresAt))}</td><td>${c.rttMs >= 0 ? `${c.rttMs} ms` : '-'}</td><td>${c.sendCount}</td><td>${esc(fmtTime(c.lastSeenAt))}</td><td class="note-cell" title="${esc(c.note || '')}">${esc(c.note || '-')}</td><td>${actions(c)}</td></tr>`).join('') || '<tr><td colspan="13" class="empty">Client 없음</td></tr>'}
  </tbody></table></div>`;
}

async function renderClientPasswords() {
  if (!roleIsAdmin()) { content.innerHTML = '<div class="empty">ADMIN 권한이 필요합니다.</div>'; return; }
  const { clients } = await api('/api/clients');
  const registered = clients.filter(client => client.password?.registered).length;
  const locked = clients.filter(client => client.password?.locked).length;
  const missing = clients.length - registered;
  content.innerHTML = `
    <div class="pin-hero">
      <div><span class="pin-eyebrow">CLIENT ACCESS SECURITY</span><h3>PIN 관리 센터</h3><p>기존 PIN 원문은 저장하지 않습니다. 새 PIN을 재설정할 때 입력값을 확인하고, 완료 직후 한 번만 볼 수 있습니다.</p></div>
      <div class="pin-hero-lock">••••</div>
    </div>
    <div class="cards pin-summary-cards">
      <div class="card"><div class="stat-label">REGISTERED</div><div class="stat-value">${registered}</div><div class="stat-sub">PIN 등록 완료</div></div>
      <div class="card"><div class="stat-label">NOT SET</div><div class="stat-value">${missing}</div><div class="stat-sub">PIN 미등록</div></div>
      <div class="card"><div class="stat-label">LOCKED</div><div class="stat-value">${locked}</div><div class="stat-sub">입력 제한 상태</div></div>
      <div class="card"><div class="stat-label">STORAGE</div><div class="stat-value compact">HMAC</div><div class="stat-sub">원문 저장 안 함</div></div>
    </div>
    <div class="section-card pin-client-list"><div class="section-head"><h3>Client PIN Status</h3><span class="small-note">관리할 Client의 PIN 재설정을 누르세요.</span></div>
      <div class="table-wrap"><table><thead><tr><th>Client</th><th>Status</th><th>PIN</th><th>Content</th><th>Updated</th><th>Lock Until</th><th>Action</th></tr></thead><tbody>
        ${clients.map(client => `<tr><td><strong>${esc(client.alias || '이름 없음')}</strong><div class="code pin-client-id">${esc(client.id)}</div></td><td>${badge(client.status)}</td><td>${badge(client.password?.locked ? 'LOCKED' : (client.password?.registered ? 'SET' : 'NONE'))}</td><td>${accessTypeBadge(client.password?.accessType || 'TYPE1')}</td><td>${esc(fmtTime(client.password?.updatedAt))}</td><td>${esc(fmtTime(client.password?.lockUntil))}</td><td><button class="primary pin-reset-button" data-client-action="password" data-id="${esc(client.id)}">PIN 재설정 / 보기</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Client 없음</td></tr>'}
      </tbody></table></div>
    </div>`;
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('QR_IMAGE_READ_FAILED'));
    reader.readAsDataURL(file);
  });
}

async function renderQrAuth() {
  if (!roleIsAdmin()) { content.innerHTML = '<div class="empty">FORBIDDEN</div>'; return; }
  const { requests, summary } = await api('/api/qr-auth');
  if (qrScanResult) qrScanResult.defaultDays = summary.defaultDays;
  const scanned = qrScanResult && qrScanResult.request ? qrScanResult.request : null;
  const selectedFileName = qrSelectedFile ? `${qrSelectedFile.name} · ${fmtBytes(qrSelectedFile.size)}` : 'APK 화면을 촬영하거나 전달받은 사진을 올리세요.';
  const selectedPreview = qrSelectedPreviewDataUrl
    ? `<img id="qr-auth-preview" src="${esc(qrSelectedPreviewDataUrl)}" alt="선택한 QR 사진 미리보기">`
    : '<img id="qr-auth-preview" class="hidden" alt="선택한 QR 사진 미리보기">';
  const secretWarning = summary.durableSigningSecret ? '' : '<div class="warning-box">QR_APPROVAL_SECRET가 설정되지 않아 현재 프로세스의 임시 서명키를 사용 중입니다. 운영·HA 배포 전에 모든 Relay에 같은 전용 비밀값을 설정하세요.</div>';
  const scannedCard = scanned ? `<div class="qr-approval-card">
    <div class="qr-approval-icon">✓</div>
    <div class="qr-approval-main"><span class="small-note">SIGNED REQUEST VERIFIED</span><strong>${esc(scanned.clientId)}</strong><div class="code">${esc(scanned.requestId)}</div><div class="qr-approval-meta"><span>만료 ${esc(fmtTime(scanned.expiresAt))}</span><span>IP ${esc(scanned.lastIP || '-')}</span><span>Scan ${scanned.scanCount}</span></div></div>
    <div class="qr-approval-actions"><button id="qr-auth-approve-btn" class="primary">기기 승인</button><button id="qr-auth-clear-btn" class="ghost">지우기</button></div>
  </div>` : '<div class="qr-scan-empty">QR 사진을 선택하면 서버가 이미지, 서명, 일회용 토큰과 기기 결합을 모두 검증합니다.</div>';
  const rows = requests.map(item => `<tr><td>${badge(item.status)}</td><td class="code">${esc(item.requestId)}</td><td class="code">${esc(item.clientId)}</td><td>${accessTypeBadge(item.accessType || 'TYPE1')}</td><td>${esc(fmtTime(item.issuedAt))}</td><td>${esc(fmtTime(item.expiresAt))}</td><td>${esc(item.approvedBy || item.rejectedBy || '-')}</td><td>${esc(item.reason || '-')}</td><td>${item.status === 'PENDING' ? `<button class="danger" data-qr-reject="${esc(item.requestId)}">거절</button>` : '-'}</td></tr>`).join('');
  content.innerHTML = `${secretWarning}<div class="cards qr-summary-cards">
    <div class="card"><div class="stat-label">PENDING</div><div class="stat-value">${summary.pending}</div><div class="stat-sub">관리자 스캔 대기</div></div>
    <div class="card"><div class="stat-label">APPROVED</div><div class="stat-value">${summary.approved}</div><div class="stat-sub">일회용 승인 완료</div></div>
    <div class="card"><div class="stat-label">REJECTED</div><div class="stat-value">${summary.rejected}</div><div class="stat-sub">관리자 거절</div></div>
    <div class="card"><div class="stat-label">TOKEN TTL</div><div class="stat-value">${Math.round(summary.ttlMs / 60000)}m</div><div class="stat-sub">서버 HMAC ${summary.durableSigningSecret ? 'PERSISTENT' : 'EPHEMERAL'}</div></div>
  </div>
  <div class="qr-auth-layout">
    <div class="section-card qr-scan-panel"><div class="section-head"><h3>QR 사진 스캔</h3><span class="small-note">PNG / JPEG · 최대 ${fmtBytes(summary.maxImageBytes)} · 서버 내부 해독</span></div><div class="section-body">
      <input id="qr-auth-file" class="visually-hidden" type="file" accept="image/png,image/jpeg" capture="environment">
      <label for="qr-auth-file" class="qr-drop-zone"><div class="qr-drop-icon">▦</div><strong>${qrSelectedFile ? '선택한 사진 변경' : 'QR 사진 선택'}</strong><span id="qr-auth-file-name">${esc(selectedFileName)}</span>${selectedPreview}</label>
      <button id="qr-auth-scan-btn" class="primary qr-scan-button" data-max-bytes="${summary.maxImageBytes}">서버에서 QR 검증</button>
      <div class="qr-security-strip"><span>ONE-TIME</span><span>${Math.round(summary.ttlMs / 60000)} MIN</span><span>HMAC SIGNED</span><span>DEVICE BOUND</span></div>
    </div></div>
    <div class="section-card"><div class="section-head"><h3>검증 결과</h3><span class="small-note">승인 전에는 라이선스가 생성되지 않습니다.</span></div><div class="section-body">${scannedCard}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>QR 인증 요청 이력</h3><div class="actions"><span class="small-note">진행 중 요청 보존</span><button class="danger" data-history-clean="QR_AUTH">CLEAN HISTORY</button></div></div><div class="table-wrap"><table><thead><tr><th>Status</th><th>Request</th><th>Client</th><th>Content</th><th>Issued</th><th>Expires</th><th>Operator</th><th>Reason</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="empty">QR 인증 요청 없음</td></tr>'}</tbody></table></div></div>`;

  const fileInput = document.getElementById('qr-auth-file');
  if (fileInput) fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    qrScanResult = null;
    await setQrSelectedFile(file);
    await renderQrAuth();
  };
}
