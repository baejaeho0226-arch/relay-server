'use strict';

async function renderServers() {
  const { servers } = await api('/api/servers');
  const actions = server => {
    const id = esc(server.id);
    const detail = `<button data-server-action="detail" data-id="${id}">상세</button>`;
    const note = roleCanOperate() ? `<button data-server-action="note" data-id="${id}">메모</button>` : '';
    if (!roleIsAdmin()) return `<div class="actions">${detail}${note}</div>`;
    const alias = `<button data-server-action="alias" data-id="${id}">별칭</button>`;

    const kick = server.online && server.status !== 'DISABLED' ? `<button class="warning" data-server-action="kick" data-id="${id}">60초간 연결 차단</button>` : '';
    const drain = server.status === 'DRAINING'
      ? `<button data-server-action="drain-off" data-id="${id}">연결 정리 꺼짐</button>`
      : server.status !== 'DISABLED' ? `<button data-server-action="drain-on" data-id="${id}">연결 정리 켜짐</button>` : '';
    const enabled = server.status === 'DISABLED'
      ? `<button class="primary" data-server-action="enable" data-id="${id}">활성화</button>`
      : `<button class="danger" data-server-action="disable" data-id="${id}">비활성화</button>`;
    return `<div class="actions">${detail}${alias}${note}${kick}${drain}${enabled}<button class="danger" data-server-action="delete" data-id="${id}">삭제</button></div>`;
  };

  content.innerHTML = `<div class="toolbar">${roleIsAdmin()?"<button id=\"pairing-repair-btn\" class=\"primary\">1:1 일치 복구</button><button class=\"danger\" data-history-clean=\"SERVER_HISTORY\">이력 정리 서버 이력</button>":"<button class=\"danger\" disabled title=\"관리자 권한 필요\">삭제 · 관리자</button>"}<span class="small-note">삭제는 장비 식별자와 종속 바인딩을 제거 · 이력 정리는 접속/연결 반복 이력만 정리</span></div><div class="table-wrap"><table><thead><tr><th>별칭</th><th>서버 식별자</th><th>상태</th><th>상태</th><th>수용</th><th>앱 기기</th><th>연결 정리</th><th>왕복 지연</th><th>버전</th><th>IP</th><th>마지막 확인</th><th>재연결 중</th><th>메모</th><th class="sticky-actions">작업</th></tr></thead><tbody>
    ${servers.map(s => `<tr><td>${esc(s.alias || '-')}</td><td class="code">${esc(s.id)}</td><td>${badge(s.status)}</td><td>${badge(s.health)}</td><td>${badge(s.acceptState || (s.canAcceptClients ? 'READY' : 'OFFLINE'))}</td><td>${s.clients} / ${s.savedClients}</td><td>${s.drain && s.drain.active ? `<div class="drain-inline"><strong>${s.drain.ready ? "준비됨" : `${s.drain.progress}%`}</strong><span>${s.drain.currentClients} 실시간 연결</span></div>` : '-'}</td><td>${s.rttMs >= 0 ? `${s.rttMs} ms` : '-'}</td><td>${esc(s.appVersion || '-')}</td><td>${esc(s.lastIP || '-')}</td><td>${esc(fmtTime(s.lastSeen))}</td><td>${s.reconnectCount}</td><td class="note-cell" title="${esc(s.note || '')}">${esc(s.note || '-')}</td><td class="sticky-actions">${actions(s)}</td></tr>`).join('') || "<tr><td colspan=\"15\" class=\"empty\">서버 없음</td></tr>"}
  </tbody></table></div>`;
}

async function renderClients() {
  const { clients } = await api('/api/clients');
  const actions = client => {
    const id = esc(client.id);
    let html = `<button data-client-action="detail" data-id="${id}">상세</button>`;
    if (roleCanOperate() && client.online) html += `<button data-client-action="notice" data-id="${id}">공지</button>`;
    if (roleCanOperate()) html += `<button data-client-action="note" data-id="${id}">메모</button>`;
    if (roleIsAdmin()) {
      html += `<button class="primary" data-client-action="biometric" data-id="${id}">생체인증 관리</button>`;
      if(client.online)html += `<button data-client-action="auth-recover" data-id="${id}">기기 인증 복구</button>`;
      html += `<button data-client-action="alias" data-id="${id}">별칭</button>`;
      html += `<button data-client-action="move" data-id="${id}">이동</button>`;
      if (client.online && client.status !== 'DISABLED') html += `<button class="warning" data-client-action="kick" data-id="${id}">60초간 연결 차단</button>`;
      html += client.status === 'DISABLED'
        ? `<button class="primary" data-client-action="enable" data-id="${id}">활성화</button>`
        : `<button class="danger" data-client-action="disable" data-id="${id}">비활성화</button>`;
      html += `<button class="danger" data-client-action="delete" data-id="${id}">삭제</button>`;
    }
    return `<div class="actions">${html}</div>`;
  };

  content.innerHTML = `<div class="toolbar">${roleIsAdmin() ? "<button id=\"pairing-repair-btn\" class=\"primary\">1:1 일치 복구</button><button class=\"primary\" data-open-view=\"clientbiometrics\">앱 기기 생체인증 관리</button><button class=\"danger\" data-history-clean=\"CLIENT_HISTORY\">이력 정리 앱 기기 이력</button>" : "<button class=\"danger\" disabled title=\"관리자 권한 필요\">삭제 · 관리자</button>"}<span class="small-note">삭제는 QR/생체인증/바인딩 포함 전체 삭제 · 이력 정리는 접속/연결 반복 이력만 정리</span></div><div class="table-wrap"><table><thead><tr><th>별칭</th><th>앱 식별자</th><th>상태</th><th>상태</th><th>생체인증</th><th>서버</th><th>라이선스</th><th>만료일</th><th>왕복 지연</th><th>전송</th><th>마지막 확인</th><th>메모</th><th class="sticky-actions">작업</th></tr></thead><tbody>
    ${clients.map(c => `<tr><td>${esc(c.alias || '-')}</td><td class="code">${esc(c.id)}</td><td>${badge(c.status)}</td><td>${badge(c.health)}</td><td>${badge(c.biometric?.verified ? 'VERIFIED' : (c.biometric?.enrolled ? 'ENROLLED' : 'NONE'))}</td><td class="code">${esc(c.serverAlias || c.serverId)}</td><td>${badge(c.licenseStatus)}</td><td>${esc(fmtTime(c.licenseExpiresAt))}</td><td>${c.rttMs >= 0 ? `${c.rttMs} ms` : '-'}</td><td>${c.sendCount}</td><td>${esc(fmtTime(c.lastSeenAt))}</td><td class="note-cell" title="${esc(c.note || '')}">${esc(c.note || '-')}</td><td class="sticky-actions">${actions(c)}</td></tr>`).join('') || "<tr><td colspan=\"13\" class=\"empty\">앱 기기 없음</td></tr>"}
  </tbody></table></div>`;
}

async function renderClientBiometrics() {
  if (!roleIsAdmin()) { content.innerHTML = "<div class=\"empty\">관리자 권한이 필요합니다.</div>"; return; }
  const { clients } = await api('/api/clients');
  const enrolled = clients.filter(client => client.biometric?.enrolled).length;
  const verified = clients.filter(client => client.biometric?.verified).length;
  const missing = clients.length - enrolled;
  content.innerHTML = `
    <div class="biometric-hero">
      <div><span class="biometric-eyebrow">앱 기기 접근 보안</span><h3>생체인증 관리 센터</h3><p>중계 서버에는 지문 원본이나 템플릿이 저장되지 않습니다. Android 시스템 인증 결과와 기기 HMAC 증명만 확인합니다.</p></div>
      <div class="biometric-hero-mark">◎</div>
    </div>
    <div class="cards biometric-summary-cards">
      <div class="card"><div class="stat-label">등록됨</div><div class="stat-value">${enrolled}</div><div class="stat-sub">생체인증 등록</div></div>
      <div class="card"><div class="stat-label">검증됨</div><div class="stat-value">${verified}</div><div class="stat-sub">현재 세션 인증</div></div>
      <div class="card"><div class="stat-label">미설정</div><div class="stat-value">${missing}</div><div class="stat-sub">등록 대기</div></div>
      <div class="card"><div class="stat-label">인증 증명</div><div class="stat-value compact">HMAC</div><div class="stat-sub">지문 데이터 미수집</div></div>
    </div>
    <div class="section-card biometric-client-list"><div class="section-head"><h3>앱 기기 생체인증 상태</h3><span class="small-note">초기화하면 온라인 모아플레이에서 시스템 생체인증을 다시 수행합니다.</span></div>
      <div class="table-wrap"><table><thead><tr><th>앱 기기</th><th>상태</th><th>생체인증</th><th>콘텐츠</th><th>등록됨</th><th>마지막 검증됨</th><th>작업</th></tr></thead><tbody>
        ${clients.map(client => `<tr><td><strong>${esc(client.alias || '이름 없음')}</strong><div class="code biometric-client-id">${esc(client.id)}</div></td><td>${badge(client.status)}</td><td>${badge(client.biometric?.verified ? 'VERIFIED' : (client.biometric?.enrolled ? 'ENROLLED' : 'NONE'))}</td><td>${accessTypeBadge(client.biometric?.accessType || 'TYPE1')}</td><td>${esc(fmtTime(client.biometric?.enrolledAt))}</td><td>${esc(fmtTime(client.biometric?.verifiedAt))}</td><td><button class="primary biometric-reset-button" data-client-action="biometric" data-id="${esc(client.id)}">생체인증 초기화</button></td></tr>`).join('') || "<tr><td colspan=\"7\" class=\"empty\">앱 기기 없음</td></tr>"}
      </tbody></table></div>
    </div>`;
}

