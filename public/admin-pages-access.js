'use strict';

async function renderNotifications(silent = false) {
  const { summary, notifications } = await api('/api/notifications?limit=300');
  if (!silent) updateNotificationBadge();
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">읽지 않음</div><div class="stat-value">${summary.unread}</div><div class="stat-sub">전체 ${summary.total}</div></div><div class="card"><div class="stat-label">긴급</div><div class="stat-value">${summary.critical}</div><div class="stat-sub">즉시 확인 필요</div></div><div class="card"><div class="stat-label">주의</div><div class="stat-value">${summary.warning}</div><div class="stat-sub">운영 주의 사항</div></div></div>
  <div class="toolbar"><button id="notification-read-all-btn">모두 읽음</button>${roleIsAdmin() ? '<button id="notification-clear-btn" class="danger">전체 지우기</button>' : ''}<span class="small-note">응답 시간 초과 / 서버 오프라인 / 연결 반복 / 라이선스 이용 기간 / 데이터베이스 복구</span></div>
  <div class="notification-list">${notifications.map(n => `<div class="notification-item ${n.read ? 'read' : 'unread'} ${esc(n.severity.toLowerCase())}"><div class="notification-icon">${n.severity === 'CRITICAL' ? '!' : n.severity === 'WARNING' ? '▲' : '•'}</div><div class="notification-main"><div class="notification-title">${badge(n.severity)} <strong>${esc(uiText(n.title))}</strong> ${n.count > 1 ? `<span class="nav-count">×${n.count}</span>` : ''}</div><div class="notification-message">${esc(n.message)}</div><div class="small-note">${esc(uiText(n.type))} // ${esc(fmtTime(n.updatedAt || n.createdAt))}${n.entityId ? ` // ${esc(n.entityId)}` : ''}</div></div>${!n.read ? `<button data-notification-read="${esc(n.id)}">읽음</button>` : ''}</div>`).join('') || '<div class="empty">알림 없음</div>'}</div>`;
}

async function renderProcessors() {
  const { processors } = await api('/api/processors');
  const p = processors.policy;
  const controls = roleIsAdmin() ? `<div class="actions"><button id="processor-save-btn" class="primary">정책 저장 / 배포</button><button id="processor-push-btn">온라인 서버 재전송</button><button id="processor-reset-stats-btn" class="danger">통계 초기화</button></div>` : '';
  content.innerHTML = `<div class="cards">
    <div class="card"><div class="stat-label">정책 개정 번호</div><div class="stat-value">${p.revision}</div><div class="stat-sub">${p.enabled ? "활성" : "통과"}</div></div>
    <div class="card"><div class="stat-label">처리기</div><div class="stat-value compact">${esc(p.processor)}</div><div class="stat-sub">서버에서 실행</div></div>
    <div class="card"><div class="stat-label">차단됨 값</div><div class="stat-value">${p.blockedValues.length}</div><div class="stat-sub">64비트 정수의 정확한 값 일치 규칙</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>입력값 처리 정책</h3>${controls}</div><div class="section-body"><div class="grid-2">
    <label>정책 모드<select id="processor-enabled" ${roleIsAdmin()?'':'disabled'}><option value="1" ${p.enabled?'selected':''}>활성</option><option value="0" ${!p.enabled?'selected':''}>통과</option></select></label>
    <label>처리기<select id="processor-name" ${roleIsAdmin()?'':'disabled'}><option value="DEFAULT">기본값</option></select></label>
    <label>최소값 (없음 = 없음)<input id="processor-min" class="code" value="${esc(p.minValue)}" placeholder="-9223372036854775808" ${roleIsAdmin()?'':'disabled'}></label>
    <label>최대값 (없음 = 없음)<input id="processor-max" class="code" value="${esc(p.maxValue)}" placeholder="9223372036854775807" ${roleIsAdmin()?'':'disabled'}></label>
  </div><label>차단값 (쉼표 또는 공백으로 구분, 최대 100개)<textarea id="processor-blocked" class="code" ${roleIsAdmin()?'':'disabled'}>${esc(p.blockedValues.join(', '))}</textarea></label><p class="small-note">Int64 값은 숫자 자료형으로 변환하지 않고 문자열 그대로 검증·저장되어 정밀도를 유지합니다.</p></div></div>
  <div class="section-card"><div class="section-head"><h3>콘텐츠별 처리 분기</h3><span class="small-note">서버가 확인한 실행 세션에 따라 콘텐츠를 이용합니다.</span></div><div class="table-wrap"><table><thead><tr><th>APK 콘텐츠</th><th>WinSockServer 처리기</th><th>신뢰 소스</th></tr></thead><tbody>${(processors.routes||[]).map(x=>`<tr><td>${accessTypeBadge(x.accessType)}</td><td class="code">${esc(processorDisplayName(x.processor))}</td><td>HMAC 실행 세션</td></tr>`).join('')}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>처리기 통계</h3><span class="small-note">처리 응답 처리 결과</span></div><div class="table-wrap"><table><thead><tr><th>처리기</th><th>요청</th><th>성공</th><th>오류</th><th>성공률</th><th>평균</th><th>최대값</th><th>마지막 오류</th><th>마지막 처리 응답</th></tr></thead><tbody>${processors.stats.map(x=>`<tr><td class="code">${esc(processorDisplayName(x.processor))}</td><td>${x.requests}</td><td>${x.success}</td><td>${x.error}</td><td>${x.successRate}%</td><td>${x.avgMs} ms</td><td>${x.maxMs} ms</td><td class="code">${esc(x.lastError||'-')}</td><td>${esc(fmtTime(x.lastAt))}</td></tr>`).join('')||'<tr><td colspan="9" class="empty">통계 없음</td></tr>'}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>서버 정책 동기화</h3></div><div class="table-wrap"><table><thead><tr><th>서버</th><th>온라인</th><th>전송됨</th><th>처리 응답 개정 번호</th><th>처리 응답 상태</th><th>상세</th></tr></thead><tbody>${processors.servers.map(x=>`<tr><td class="code">${esc(x.serverId)}</td><td>${badge(x.online?'ONLINE':'OFFLINE')}</td><td>${esc(fmtTime(x.sentAt))}</td><td>${x.ack?x.ack.revision:'-'}</td><td>${x.ack?badge(x.ack.status):badge('NONE')}</td><td class="code">${esc(x.ack&&x.ack.detail||'-')}</td></tr>`).join('')||"<tr><td colspan=\"6\" class=\"empty\">서버 없음</td></tr>"}</tbody></table></div></div>`;
}

