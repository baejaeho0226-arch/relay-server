'use strict';

function renderStatsPanel(stats) {
  const rows = stats.buckets || [];
  return `<div class="section-card stats-panel"><div class="section-head"><h3>트래픽 추이</h3><div class="actions"><button data-stats-range="1H" class="${statsRange==='1H'?'primary':''}">1시간</button><button data-stats-range="6H" class="${statsRange==='6H'?'primary':''}">6시간</button><button data-stats-range="24H" class="${statsRange==='24H'?'primary':''}">24시간</button><button data-stats-range="7D" class="${statsRange==='7D'?'primary':''}">7일</button></div></div><div class="stats-grid"><div class="chart-box"><div class="chart-title">연결 · 전송</div>${svgLineChart(rows,[{key:'connections',label:"접속 수"},{key:'sends',label:"전송"}])}</div><div class="chart-box"><div class="chart-title">처리 응답 결과</div>${svgLineChart(rows,[{key:'ackOk',label:"응답 성공"},{key:'ackError',label:"응답 오류"},{key:'ackTimeout',label:"시간 초과"}])}</div></div><div class="stats-summary"><span>접속 수 <strong>${stats.totals.connections}</strong></span><span>전송 <strong>${stats.totals.sends}</strong></span><span>응답 성공 <strong>${stats.totals.ackOk}</strong></span><span>오류 <strong>${stats.totals.ackError}</strong></span><span>시간 초과 <strong>${stats.totals.ackTimeout}</strong></span><span>성공 <strong>${stats.totals.ackSuccessRate}%</strong></span></div></div>`;
}

async function renderDashboard() {
  const [{ dashboard: d }, { statistics: stats }] = await Promise.all([api('/api/dashboard'), api(`/api/statistics?range=${encodeURIComponent(statsRange)}`)]);
  content.innerHTML = `
    <div class="cards">
      <div class="card"><div class="stat-label">서버 연결</div><div class="stat-value">${d.servers.online} / ${d.servers.total}</div><div class="stat-sub">비활성 ${d.servers.disabled} · 연결 정리 중 ${d.servers.draining}</div></div>
      <div class="card"><div class="stat-label">앱 연결</div><div class="stat-value">${d.clients.online} / ${d.clients.total}</div><div class="stat-sub">비활성 ${d.clients.disabled}</div></div>
      <div class="card"><div class="stat-label">QR 승인 대기</div><div class="stat-value">${d.qrAuth.pending}</div><div class="stat-sub">승인됨 ${d.qrAuth.approved} · 거절됨 ${d.qrAuth.rejected}</div></div>
      <div class="card"><div class="stat-label">사용 중인 라이선스</div><div class="stat-value">${d.licenses.bound}</div><div class="stat-sub">사용 가능 ${d.licenses.available} · 만료 ${d.licenses.expired}</div></div>
      <div class="card"><div class="stat-label">처리 성공률</div><div class="stat-value">${d.ack.successRate}%</div><div class="stat-sub">대기 중 ${d.ack.pending} · 시간 초과 ${d.ack.timeout}</div></div>
      <div class="card"><div class="stat-label">확인할 알림</div><div class="stat-value">${d.notifications.unread}</div><div class="stat-sub">긴급 ${d.notifications.critical} · 주의 ${d.notifications.warning}</div></div>
      <div class="card"><div class="stat-label">서비스 상태</div><div class="stat-value">${d.serviceEnabled ? "온라인" : "오프라인"}</div><div class="stat-sub">점검 ${d.maintenanceMode ? "켜짐" : "꺼짐"}</div></div>
      <div class="card"><div class="stat-label">연속 운영 시간</div><div class="stat-value">${esc(fmtDuration(d.uptimeMs))}</div><div class="stat-sub">접속 수 ${d.totalConnections}</div></div>
      <div class="card"><div class="stat-label">프로토콜 버전</div><div class="stat-value">P${d.versions.protocol}</div><div class="stat-sub">서버 ${esc(d.versions.server)} · 앱 기기 ${esc(d.versions.client)}</div></div>
      <div class="card"><div class="stat-label">복구 대기</div><div class="stat-value">${d.recovery.queued} / ${d.recovery.deadLetters}</div><div class="stat-sub">대기열 / 활성 실패 보관함 · 재전송 ${d.recovery.replayed}</div></div>
      <div class="card"><div class="stat-label">이중화 상태</div><div class="stat-value">${esc(uiText(d.ha.role))}</div><div class="stat-sub">${esc(d.ha.instanceId)} · ${d.ha.acceptsTraffic ? "트래픽 켜짐" : "조회 전용"}</div></div>
    </div>
    ${renderStatsPanel(stats)}
    <div class="section-card"><div class="section-head"><h3>서버별 기기 배정</h3><button data-open-view="distribution">배정 확인</button></div><div class="section-body"><p class="muted">서버별 실시간 연결/배정 앱 기기 부하와 순차 연결 정리 진행률을 확인합니다.</p></div></div>
    <div class="section-card"><div class="section-head"><h3>라이선스 만료 일정</h3><span class="small-note">선택하여 목록 보기</span></div><div class="section-body"><div class="expiry-grid">
      <button class="expiry-card critical" data-license-expiry="EXPIRED"><span>만료됨</span><strong>${d.licenseExpiry.expired}</strong></button>
      <button class="expiry-card critical" data-license-expiry="1D"><span>24시간 이내</span><strong>${d.licenseExpiry.within1d}</strong></button>
      <button class="expiry-card warning" data-license-expiry="3D"><span>3일 이내</span><strong>${d.licenseExpiry.within3d}</strong></button>
      <button class="expiry-card warning" data-license-expiry="7D"><span>7일 이내</span><strong>${d.licenseExpiry.within7d}</strong></button>
      <button class="expiry-card" data-license-expiry="30D"><span>30일 이내</span><strong>${d.licenseExpiry.within30d}</strong></button>
    </div></div></div>
    <div class="grid-2">
      <div class="section-card"><div class="section-head"><h3>최근 이벤트</h3><span class="small-note">최근 30건</span></div><div class="section-body"><div class="event-list">
        ${d.recentEvents.length ? d.recentEvents.map(e => `<div class="event"><span>${esc(fmtTime(e.time))}</span><span class="type">${esc(uiText(e.type))}</span><span>${esc(e.detail)}</span></div>`).join('') : '<div class="empty">이벤트 없음</div>'}
      </div></div></div>
      <div class="section-card"><div class="section-head"><h3>라이선스 상태</h3></div><div class="section-body"><div class="kv">
        <div>사용 가능</div><div>${d.licenses.available}</div><div>연결됨</div><div>${d.licenses.bound}</div><div>이용 정지</div><div>${d.licenses.suspended}</div><div>만료</div><div>${d.licenses.expired}</div><div>전체</div><div>${d.licenses.total}</div>
      </div></div></div>
    </div>`;
}

async function renderConsole() {
  if (!consoleHistoryLoaded) {
    const { events } = await api('/api/audit');
    if (!liveConsoleEvents.length) liveConsoleEvents = events.slice(-300);
    consoleHistoryLoaded = true;
  }
  content.innerHTML = `<div class="terminal-panel"><div class="terminal-head"><span>실시간 이벤트 기록</span><div class="actions"><button id="console-pause-btn">${consolePaused ? "이용 재개" : "일시 중지"}</button><button id="console-clear-btn">지우기</button></div></div><div id="live-console-list" class="live-console">${liveConsoleEvents.slice(-300).map(e => `<div class="console-line"><span class="console-time">${esc(fmtTime(e.time))}</span><span class="console-type">${esc(uiText(e.type))}</span><span class="console-detail">${esc(e.detail)}</span></div>`).join('') || '<div class="empty">이벤트 없음</div>'}</div></div>`;
  const list = document.getElementById('live-console-list');
  if (list) list.scrollTop = list.scrollHeight;
}

async function renderTrace() {
  const { traces } = await api(`/api/request-traces?query=${encodeURIComponent(traceQuery)}`);
  traceRows = new Map(traces.map(t => [t.key, t]));
  content.innerHTML = `<div class="toolbar"><input id="trace-search" placeholder="요청 식별자 / 앱 기기 / 서버 / 입력값" value="${esc(traceQuery)}"><button id="trace-search-btn">요청 추적</button>${roleIsAdmin()?"<button class=\"danger\" data-history-clean=\"REQUEST_TRACES\">이력 정리</button>":''}<span class="small-note">처리 중·대기열 요청은 보존</span></div><div class="table-wrap"><table><thead><tr><th>요청 식별자</th><th>소스</th><th>앱 기기</th><th>서버</th><th>입력값</th><th>상태</th><th>다시 시도</th><th>기간</th><th>전달됨</th><th>작업</th></tr></thead><tbody>${traces.map(t => `<tr><td class="code">${esc(t.requestId)}</td><td>${esc(t.source||'CLIENT')}</td><td class="code">${esc(t.clientId)}</td><td class="code">${esc(t.serverId)}</td><td class="code">${esc(t.number)}</td><td>${badge(t.status)}</td><td>${t.retries}</td><td>${t.completedAt ? `${t.durationMs} ms` : '-'}</td><td>${esc(fmtTime(t.forwardedAt))}</td><td><div class="actions"><button data-trace-detail="${esc(t.key)}">상세</button>${roleIsAdmin()&&['ERROR','TIMEOUT','DLQ'].includes(String(t.status||'').toUpperCase())?`<button class="warning" data-trace-replay="${esc(t.key)}">재전송</button>`:''}</div></td></tr>`).join('') || "<tr><td colspan=\"10\" class=\"empty\">요청 추적 없음</td></tr>"}</tbody></table></div>`;
}

async function renderMonitor() {
  const [{ servers }, { clients }] = await Promise.all([api('/api/servers'), api('/api/clients')]);
  const serverGood = servers.filter(x => x.health === 'GOOD').length;
  const clientGood = clients.filter(x => x.health === 'GOOD').length;
  const problemServers = servers.filter(x => !['GOOD', 'OFFLINE'].includes(x.health)).length;
  const problemClients = clients.filter(x => !['GOOD', 'OFFLINE'].includes(x.health)).length;
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">서버 정상</div><div class="stat-value">${serverGood}</div><div class="stat-sub">문제 ${problemServers}</div></div><div class="card"><div class="stat-label">앱 기기 정상</div><div class="stat-value">${clientGood}</div><div class="stat-sub">문제 ${problemClients}</div></div><div class="card"><div class="stat-label">서버 온라인</div><div class="stat-value">${servers.filter(x => x.online).length}</div><div class="stat-sub">전체 ${servers.length}</div></div><div class="card"><div class="stat-label">앱 기기 온라인</div><div class="stat-value">${clients.filter(x => x.online).length}</div><div class="stat-sub">전체 ${clients.length}</div></div></div><div class="section-card monitor-section"><div class="section-head"><h3>서버 상태</h3><span class="small-note">3초마다 자동 갱신</span></div><div class="table-wrap"><table><thead><tr><th>별칭</th><th>서버 식별자</th><th>상태</th><th>상태</th><th>왕복 지연</th><th>처리 응답</th><th>앱 기기</th><th>재연결 중</th><th>마지막 확인</th></tr></thead><tbody>${servers.map(x => `<tr><td>${esc(x.alias || '-')}</td><td class="code">${esc(x.id)}</td><td>${badge(x.status)}</td><td>${badge(x.health)}</td><td>${x.rttMs >= 0 ? `${x.rttMs} ms` : '-'}</td><td>${x.ack.successRate}% <span class="muted">(${x.ack.ok}/${x.ack.error}/${x.ack.timeout})</span></td><td>${x.clients} / ${x.savedClients}</td><td>${x.reconnectCount}</td><td>${esc(fmtTime(x.lastSeen))}</td></tr>`).join('') || "<tr><td colspan=\"9\" class=\"empty\">서버 없음</td></tr>"}</tbody></table></div></div><div class="section-card monitor-section"><div class="section-head"><h3>앱 기기 상태</h3><span class="small-note">3초마다 자동 갱신</span></div><div class="table-wrap"><table><thead><tr><th>별칭</th><th>앱 식별자</th><th>상태</th><th>상태</th><th>왕복 지연</th><th>처리 응답</th><th>서버</th><th>전송</th><th>재연결 중</th></tr></thead><tbody>${clients.map(x => `<tr><td>${esc(x.alias || '-')}</td><td class="code">${esc(x.id)}</td><td>${badge(x.status)}</td><td>${badge(x.health)}</td><td>${x.rttMs >= 0 ? `${x.rttMs} ms` : '-'}</td><td>${x.ack.successRate}% <span class="muted">(${x.ack.ok}/${x.ack.error}/${x.ack.timeout})</span></td><td class="code">${esc(x.serverAlias || x.serverId)}</td><td>${x.sendCount}</td><td>${x.reconnectCount}</td></tr>`).join('') || "<tr><td colspan=\"9\" class=\"empty\">앱 기기 없음</td></tr>"}</tbody></table></div></div>`;
}


