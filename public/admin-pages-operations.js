'use strict';

async function renderAudit() {
  const { events } = await api(`/api/audit?query=${encodeURIComponent(auditQuery)}&type=${encodeURIComponent(auditType)}`);
  const types = [...new Set(events.map(x => x.type))].sort();
  content.innerHTML = `<div class="toolbar"><input id="audit-search" placeholder="이벤트 검색" value="${esc(auditQuery)}"><select id="audit-type"><option value="ALL">전체</option>${types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select><button id="audit-search-btn">검색</button>${roleIsAdmin()?"<button class=\"danger\" data-history-clean=\"AUDIT\">이력 정리 감사 기록</button>":''}</div>
  <div class="table-wrap"><table><thead><tr><th>시각</th><th>유형</th><th>상세</th></tr></thead><tbody>${events.map(e => `<tr><td>${esc(fmtTime(e.time))}</td><td class="code">${esc(uiText(e.type))}</td><td>${esc(e.detail)}</td></tr>`).join('') || "<tr><td colspan=\"3\" class=\"empty\">감사 기록 없음</td></tr>"}</tbody></table></div>`;
  const typeEl = document.getElementById('audit-type');
  if ([...typeEl.options].some(o => o.value === auditType)) typeEl.value = auditType;
}

async function renderActivity() {
  const { activities } = await api(`/api/admin-activity?query=${encodeURIComponent(activityQuery)}&limit=500`);
  content.innerHTML = `<div class="toolbar"><input id="activity-search" placeholder="역할 / IP / API / 상태 검색" value="${esc(activityQuery)}"><button id="activity-search-btn">검색</button><span class="small-note">비밀번호와 요청 본문은 기록하지 않습니다.</span></div>
  <div class="table-wrap"><table><thead><tr><th>시각</th><th>역할</th><th>IP</th><th>방식</th><th>API</th><th>상태</th><th>작업</th></tr></thead><tbody>${activities.map(a => `<tr><td>${esc(fmtTime(a.time))}</td><td>${badge(a.role)}</td><td class="code">${esc(a.ip || '-')}</td><td class="code">${esc(a.method)}</td><td class="code">${esc(a.path)}</td><td>${a.status >= 200 && a.status < 300 ? badge('OK') : badge('ERROR')} ${esc(uiText(a.status))}</td><td>${esc(a.action || '-')}</td></tr>`).join('') || "<tr><td colspan=\"7\" class=\"empty\">활동 없음</td></tr>"}</tbody></table></div>`;
}

async function renderSessions() {
  const { sessions } = await api('/api/sessions');
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">활성 세션</div><div class="stat-value">${sessions.length}</div><div class="stat-sub">현재 로그인 세션 포함</div></div><div class="card"><div class="stat-label">관리자</div><div class="stat-value">${sessions.filter(x => x.role === 'admin').length}</div><div class="stat-sub">관리 권한 세션</div></div><div class="card"><div class="stat-label">다른 역할</div><div class="stat-value">${sessions.filter(x => x.role !== 'admin').length}</div><div class="stat-sub">운영자 / 조회 전용</div></div></div>
  <div class="toolbar"><button id="session-revoke-others-btn" class="warning">현재 세션 제외 전부 종료</button><button id="session-revoke-all-btn" class="danger">전체 세션 종료</button><span class="small-note">세션 토큰 원문은 화면/로그에 노출하지 않습니다.</span></div>
  <div class="table-wrap"><table><thead><tr><th>세션 식별자</th><th>역할</th><th>IP</th><th>생성됨</th><th>마지막 활성</th><th>만료일</th><th>현재</th><th>작업</th></tr></thead><tbody>${sessions.map(s => `<tr><td class="code">${esc(s.id)}</td><td>${badge(s.role)}</td><td class="code">${esc(s.ip || '-')}</td><td>${esc(fmtTime(s.createdAt))}</td><td>${esc(fmtTime(s.lastSeenAt))}</td><td>${esc(fmtTime(s.expiresAt))}</td><td>${s.current ? badge('CURRENT') : '-'}</td><td>${s.current ? '<span class="muted">현재 세션</span>' : `<button class="danger" data-session-revoke="${esc(s.id)}">종료</button>`}</td></tr>`).join('') || "<tr><td colspan=\"8\" class=\"empty\">세션 없음</td></tr>"}</tbody></table></div>`;
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
    <div class="card"><div class="stat-label">중계 서버</div><div class="stat-value">${o.serviceEnabled ? "온라인" : "오프라인"}</div><div class="stat-sub">가동 시간 ${esc(fmtDuration(o.uptimeMs))}</div></div>
    <div class="card"><div class="stat-label">데이터베이스</div><div class="stat-value">${db.exists && db.dataDirWritable && db.lastSaveOk ? 'OK' : "확인"}</div><div class="stat-sub">${esc(fmtBytes(db.size))} · ${esc(fmtTime(db.lastSaveAt))}</div></div>
    <div class="card"><div class="stat-label">백업</div><div class="stat-value">${b.count}</div><div class="stat-sub">최근 ${esc(b.latest ? fmtTime(b.latest.mtimeMs) : '-')}</div></div>
    <div class="card"><div class="stat-label">관리자 로그인 세션</div><div class="stat-value">${w.sessions.total}</div><div class="stat-sub">관리자 ${w.sessions.roles.admin} · 운영자 ${w.sessions.roles.operator} · 조회 전용 ${w.sessions.roles.viewer}</div></div>
    <div class="card"><div class="stat-label">데이터베이스 무결성</div><div class="stat-value">${integrity.ok ? 'HEALTHY' : "오류"}</div><div class="stat-sub">오류 ${integrity.errors.length} · 경고 ${integrity.warnings.length}</div></div>
  </div>
  <div class="panel-grid health-panels">
    <div class="section-card"><div class="section-head"><h3>노드 실행 환경</h3>${badge('ONLINE')}</div><div class="section-body"><div class="kv"><div>실행 환경</div><div class="code">${esc(n.version)}</div><div>프로세스 번호</div><div>${n.pid}</div><div>운영체제</div><div>${esc(n.platform)} / ${esc(n.arch)}</div><div>가동 시간</div><div>${esc(fmtDuration(n.uptimeMs))}</div><div>실제 메모리 사용량</div><div>${esc(fmtBytes(n.rss))}</div><div>힙 메모리</div><div>${esc(fmtBytes(n.heapUsed))} / ${esc(fmtBytes(n.heapTotal))}</div><div>프로세서 사용량</div><div>${n.cpuCount} cores</div><div>최근 1·5·15분 부하</div><div>${n.load1m} / ${n.load5m} / ${n.load15m}</div></div></div></div>
    <div class="section-card"><div class="section-head"><h3>데이터베이스</h3>${badge(db.exists && db.dataDirWritable && db.lastSaveOk ? 'GOOD' : 'WARNING')}</div><div class="section-body"><div class="kv"><div>파일</div><div class="code">${esc(db.file)}</div><div>존재 여부</div><div>${badge(db.exists ? 'GOOD' : 'ERROR')}</div><div>쓰기 가능</div><div>${badge(db.dataDirWritable ? 'GOOD' : 'ERROR')}</div><div>크기</div><div>${esc(fmtBytes(db.size))}</div><div>수정됨</div><div>${esc(fmtTime(db.mtimeMs))}</div><div>마지막 저장</div><div>${esc(fmtTime(db.lastSaveAt))}</div><div>마지막 저장 결과</div><div>${badge(db.lastSaveOk ? 'GOOD' : 'ERROR')}</div></div></div></div>
    <div class="section-card"><div class="section-head"><h3>백업 / 감사 기록</h3>${badge(b.writable && a.writable ? 'GOOD' : 'WARNING')}</div><div class="section-body"><div class="kv"><div>백업 쓰기 가능</div><div>${badge(b.writable ? 'GOOD' : 'ERROR')}</div><div>백업 개수</div><div>${b.count}</div><div>최근 백업</div><div class="code">${esc(b.latest ? b.latest.file : '-')}</div><div>최근 시각</div><div>${esc(b.latest ? fmtTime(b.latest.mtimeMs) : '-')}</div><div>감사 기록 쓰기 가능</div><div>${badge(a.writable ? 'GOOD' : 'ERROR')}</div><div>감사 기록 파일</div><div>${a.count}</div><div>최근 감사 기록</div><div class="code">${esc(a.latest ? a.latest.file : '-')}</div></div></div></div>
    <div class="section-card"><div class="section-head"><h3>중계 서버 실행 상태</h3>${badge(o.serviceEnabled ? 'GOOD' : 'OFFLINE')}</div><div class="section-body"><div class="kv"><div>서버</div><div>${r.serversOnline} 온라인</div><div>앱 기기</div><div>${r.clientsOnline} 온라인</div><div>응답 대기</div><div>${r.pendingAcks}</div><div>요청 요청 추적</div><div>${r.requestTraces}</div><div>오프라인 대기열</div><div>${r.offlineQueue||0}</div><div>활성 실패 보관함</div><div>${r.activeDeadLetters||0}</div><div>재전송됨</div><div>${r.replayedRequests||0}</div><div>대기열 처리됨</div><div>${r.dequeuedRequests||0}</div><div>응답 성공</div><div>${r.ackOk}</div><div>응답 오류</div><div>${r.ackError}</div><div>응답 시간 초과</div><div>${r.ackTimeout}</div><div>재시도</div><div>${r.ackRetries}</div><div>접속 수</div><div>${r.connections}</div></div></div></div>
  </div><div class="section-card integrity-panel"><div class="section-head"><h3>데이터베이스 무결성</h3>${badge(integrity.ok ? 'GOOD' : 'ERROR')}</div><div class="section-body"><div class="stats-summary"><span>서버 <strong>${integrity.stats.servers || 0}</strong></span><span>앱 기기 <strong>${integrity.stats.clients || 0}</strong></span><span>라이선스 <strong>${integrity.stats.licenses || 0}</strong></span><span>오류 <strong>${integrity.errors.length}</strong></span><span>경고 <strong>${integrity.warnings.length}</strong></span><button id="integrity-run-btn">실행 확인</button></div>${integrity.errors.length || integrity.warnings.length ? `<div class="integrity-list">${[...integrity.errors.map(x=>({...x,severity:'ERROR'})),...integrity.warnings.map(x=>({...x,severity:'WARNING'}))].map(x=>`<div class="integrity-row">${badge(x.severity)}<span class="code">${esc(x.code)}</span><span>${esc(x.message)}</span><span class="code">${esc(x.entity || '-')}</span></div>`).join('')}</div>` : "<div class=\"integrity-ok\">잘못된 연결이나 데이터 구조가 없습니다.</div>"}</div></div>`;
}

async function renderBackups() {
  const { backups } = await api('/api/backups');
  content.innerHTML = `<div class="toolbar">${roleIsAdmin() ? '<button id="backup-create-btn" class="primary">백업 생성</button>' : ''}<span class="small-note">복원는 현재 서버/앱 기기를 재접속시킵니다.</span></div>
  <div class="table-wrap"><table><thead><tr><th>파일</th><th>크기</th><th>생성됨</th><th>작업</th></tr></thead><tbody>${backups.map(b => `<tr><td class="code">${esc(b.file)}</td><td>${esc(fmtBytes(b.size))}</td><td>${esc(fmtTime(b.mtimeMs))}</td><td><div class="actions"><button data-backup-action="verify" data-file="${esc(b.file)}">검증</button>${roleIsAdmin() ? `<button data-open-view="danger" class="warning">주의가 필요한 작업</button>` : ''}</div></td></tr>`).join('') || "<tr><td colspan=\"4\" class=\"empty\">백업 없음</td></tr>"}</tbody></table></div>`;
}

async function renderLoadSimulator() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { simulator } = await api('/api/load-simulator');
  const p = simulator.presets || {};
  content.innerHTML = `<div class="section-card"><div class="section-head"><h3>별도 실행 부하 시험</h3>${badge('STAGING ONLY')}</div><div class="section-body">
    <p class="muted">운영 중계 서버 프로세스 내부에서 부하를 만들지 않습니다. 별도 PC/프로세스에서 <span class="code">tools/load-simulator.js</span>를 실행합니다.</p>
    <div class="warning-box">전용 시험 배포에서 실행을 권장합니다. 모의 시험 앱 기기 식별정보는 테스트 데이터베이스에 남을 수 있습니다. 전체 모드는 임시 라이선스를 생성하고 종료 시 자동 삭제합니다.</div>
    <div class="grid-2"><label>중계 서버 호스트<input id="load-relay-host" value="127.0.0.1"></label><label>중계 서버 포트<input id="load-relay-port" type="number" value="3000"></label><label>웹 관리자 주소<input id="load-web-url" value="http://127.0.0.1:8080"></label><label>모드<select id="load-mode"><option value="connect">연결만 테스트</option><option value="full">라이선스·전송·처리 응답 전체 테스트</option></select></label><label>서버<input id="load-servers" type="number" min="1" max="500" value="${p.medium?.servers || 10}"></label><label>앱 기기<input id="load-clients" type="number" min="1" max="5000" value="${p.medium?.clients || 100}"></label><label>요청 / 앱 기기<input id="load-requests" type="number" min="0" max="100" value="${p.medium?.requestsPerClient || 1}"></label></div>
    <div class="actions"><button id="load-preset-smoke">소규모</button><button id="load-preset-medium">중규모</button><button id="load-preset-heavy">대규모</button><button id="load-command-btn" class="primary">생성 명령</button></div>
    <div class="terminal-box"><div class="small-note">실행 명령 · 전체 테스트 모드에서는 마지막에 <span class="code">--admin-secret YOUR_SECRET</span>을 추가하거나 실행 환경에 ADMIN_SECRET을 설정하세요.</div><pre id="load-command-output" class="code-block">${esc(simulator.example || '')}</pre><button id="load-copy-btn">복사</button></div>
  </div></div>`;
}

async function renderStorageMigration() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { migration: m } = await api('/api/storage/migration/status');
  const s = m.sqlite || {};
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">활성 저장소</div><div class="stat-value">${esc(m.activeProvider)}</div><div class="stat-sub">${m.switched ? 'AUTHORITATIVE' : "호환성"}</div></div><div class="card"><div class="stat-label">데이터 구조</div><div class="stat-value">v${m.schemaVersion}</div><div class="stat-sub">개정 번호 ${s.revision || 0}</div></div><div class="card"><div class="stat-label">무결성</div><div class="stat-value">${s.ok && m.ready ? "정상" : "확인"}</div><div class="stat-sub">${esc(s.file || '-')} · ${fmtBytes(s.size || 0)}</div></div><div class="card"><div class="stat-label">라이선스 개정</div><div class="stat-value">${m.licenseRevision}</div><div class="stat-sub">SQLite 스냅샷 기준</div></div></div>
    <div class="section-card"><div class="section-head"><h3>SQLite 기본 저장소</h3>${badge(s.ok && m.ready ? 'GOOD' : 'WARNING')}</div><div class="section-body"><div class="kv"><div>방식</div><div class="code">${esc(m.strategy)}</div><div>스냅샷 저장됨</div><div>${esc(fmtTime(s.savedAt))}</div><div>소스 인스턴스</div><div class="code">${esc(s.sourceInstance || '-')}</div><div>서버</div><div>${m.counts.servers}</div><div>앱 기기</div><div>${m.counts.clients}</div><div>라이선스</div><div>${m.counts.licenses}</div><div>기기 인증키</div><div>${m.counts.deviceSecrets}</div><div>데이터 경로</div><div class="code">${esc(m.dataDir)}</div></div>
    <p class="muted">SQLite가 실제 기본 저장소입니다. 기존 JSON은 최초 실행 시 자동 이관되며 이후에는 장애 복구용 미러로만 유지됩니다.</p>
    ${m.blockers?.length ? `<div class="warning-box">차단 요인: ${esc(m.blockers.join(', '))}</div>` : ''}
    <div class="actions"><button id="storage-schema-btn">보기 데이터 구조</button><button id="storage-export-btn" class="primary" ${m.ready ? '' : 'disabled'}>생성 이관 묶음 파일</button></div><div id="storage-export-result" class="small-note"></div></div></div>`;
}

async function renderHA() {
  const { ha } = await api('/api/ha/status');
  const peer = ha.peer || {};
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">현재 서버 역할</div><div class="stat-value">${esc(uiText(ha.role))}</div><div class="stat-sub">${esc(ha.instanceId)} · 우선순위 ${ha.priority}</div></div><div class="card"><div class="stat-label">트래픽</div><div class="stat-value">${ha.acceptsTraffic ? "활성" : "차단됨"}</div><div class="stat-sub">대기 노드는 기기 접속과 변경 요청을 받지 않습니다.</div></div><div class="card"><div class="stat-label">상대 서버</div><div class="stat-value">${esc(peer.role || (ha.peerUrlConfigured ? 'WAITING' : 'NONE'))}</div><div class="stat-sub">${esc(peer.instanceId || '-')} · 우선순위 ${peer.priority || '-'}</div></div><div class="card"><div class="stat-label">동기화</div><div class="stat-value">R${ha.lastReplicationRevision || 0}</div><div class="stat-sub">${esc(fmtTime(ha.lastReplicationAt))}</div></div></div>
    <div class="section-card"><div class="section-head"><h3>주 서버·대기 서버 조정</h3>${badge(ha.role)}</div><div class="section-body"><div class="kv"><div>활성 / 설정됨</div><div>${badge(ha.enabled ? 'ONLINE' : 'DISABLED')} ${badge(ha.configured ? 'GOOD' : 'WARNING')}</div><div>결정</div><div class="code">${esc(uiText(ha.reason))}</div><div>상대 서버 마지막 확인</div><div>${esc(fmtTime(ha.lastPeerSeenAt))}</div><div>장애 전환 시간 초과</div><div>${ha.failoverTimeoutMs} ms</div><div>최근 동기화 오류</div><div class="code">${esc(ha.lastReplicationError || '-')}</div></div><div class="warning-box">두 중계 서버는 같은 <span class="code">HA_SHARED_SECRET</span>을 사용하고 서로의 웹 관리자 주소을 <span class="code">HA_PEER_URL</span>로 지정해야 합니다. 높은 우선순위가 활성이며 동률이면 인스턴스 식별자가 작은 노드가 활성입니다.</div></div></div>`;
}

async function renderSystem() {
  const { system: s } = await api('/api/system');
  const schedule = s.maintenanceSchedule;
  content.innerHTML = `<div class="panel-grid">
    <div class="section-card"><div class="section-head"><h3>서비스</h3>${badge(s.serviceEnabled ? 'ONLINE' : 'OFFLINE')}</div><div class="section-body"><div class="kv"><div>점검</div><div>${badge(s.maintenanceMode ? 'ON' : 'OFF')}</div><div>웹 관리자</div><div>v${esc(s.webAdminVersion || '-')}</div><div>이전 방식 TCP 관리자</div><div>${badge(s.legacyTcpAdminEnabled ? 'ONLINE' : 'DISABLED')}</div><div>데이터 경로</div><div class="code">${esc(s.dataDir)}</div><div>최대 앱 기기 / 서버</div><div>${s.maxClientsPerServer}</div><div>속도 제한</div><div>${s.rateLimit}/초</div></div>${roleIsAdmin() ? `<div class="toolbar"><button id="service-start-btn">서비스 시작</button><button id="maint-on-btn" class="warning">점검 켜짐</button><button id="maint-off-btn">점검 꺼짐</button><button data-open-view="danger" class="danger">주의가 필요한 작업</button></div>` : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>버전 정책</h3></div><div class="section-body"><div class="form-grid"><label>프로토콜<input id="version-protocol" type="number" min="1" max="${s.currentProtocolVersion}" value="${s.minProtocolVersion}"></label><label>서버<input id="version-server" value="${esc(s.minServerVersion)}"></label><label>앱 기기<input id="version-client" value="${esc(s.minClientVersion)}"></label><label>현재 프로토콜<input disabled value="${s.currentProtocolVersion}"></label></div>${roleIsAdmin() ? "<button data-open-view=\"danger\" class=\"warning\">주의가 필요한 작업에서 변경</button>" : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>점검 예약 / 자동 연결 정리</h3>${s.maintenanceAutomation?.active ? badge(s.maintenanceAutomation.phase) : ''}</div><div class="section-body">${schedule ? `<div class="kv"><div>시작</div><div>${esc(fmtTime(schedule.startAt))}</div><div>종료</div><div>${esc(fmtTime(schedule.endAt))}</div><div>메시지</div><div>${esc(schedule.message)}</div><div>자동 연결 정리</div><div>${badge(schedule.autoDrain?'ON':'OFF')}</div><div>연결 정리 준비 시간</div><div>${schedule.drainLeadMinutes||0} 최소</div><div>강제 시작</div><div>${badge(schedule.forceStart?'ON':'OFF')}</div><div>단계</div><div>${badge(s.maintenanceAutomation?.phase||'SCHEDULED')}</div><div>실시간 연결 앱 기기</div><div>${s.maintenanceAutomation?.liveClients??0}</div><div>자동으로 연결 정리된 서버</div><div>${s.maintenanceAutomation?.autoDrainedServers??0}</div></div>${s.maintenanceAutomation?.phase==='WAITING_FOR_DRAIN'?"<div class=\"warning-box\">예약 시각이 지났지만 앱 기기가 남아 있어 점검 진입을 기다리고 있습니다. 연결 정리은 앱 기기를 강제 종료하지 않습니다.</div>":''}` : "<p class=\"muted\">예약된 점검가 없습니다.</p>"}${roleIsAdmin() ? '<div class="toolbar"><button id="schedule-create-btn">예약 설정</button><button id="schedule-clear-btn">예약 제거</button></div>' : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>공지</h3></div><div class="section-body"><p class="muted">현재 온라인 앱 기기 전체에 공지를 전송합니다.</p>${roleCanOperate() ? '<button id="notice-all-btn">전체 공지 보내기</button>' : ''}</div></div>
  </div>`;
}
