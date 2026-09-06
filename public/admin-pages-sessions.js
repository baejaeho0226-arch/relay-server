'use strict';

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
      <td><button data-build-rebind="${esc(row.clientId)}" data-current-server="${esc(binding ? binding.serverId : row.assignedServerId || '')}">${binding ? "배정 변경" : "배정"}</button></td>
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
    <td>${item.status === 'AUTHORIZED' ? `<button class="danger" data-build-revoke="${esc(item.sessionId)}">해제 지금</button>` : '-'}</td>
  </tr>`).join('');
  content.innerHTML = `<div class="cards">
    <div class="card"><div class="stat-label">활성 이용 권한</div><div class="stat-value">${summary.active || 0}</div><div class="stat-sub">유효 시간 ${policy.ttlMinutes || 30} 분</div></div>
    <div class="card"><div class="stat-label">대기 중</div><div class="stat-value">${summary.pending || 0}</div><div class="stat-sub">APK 실행 대기 중</div></div>
    <div class="card"><div class="stat-label">고정 배정</div><div class="stat-value">${summary.bindings || 0}</div><div class="stat-sub">처음 승인된 기기 조합</div></div>
    <div class="card"><div class="stat-label">종료됨</div><div class="stat-value">${Number(summary.expired || 0) + Number(summary.revoked || 0) + Number(summary.failed || 0)}</div><div class="stat-sub">만료 ${summary.expired || 0} · 해제됨 ${summary.revoked || 0} · 실패 ${summary.failed || 0}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>실행 세션 이용 권한 정책</h3><span class="small-note">1~1,440분 · 새 세션에 적용</span></div><div class="section-body"><div class="toolbar"><label>이용 권한 유효 시간 (분)<input id="build-session-ttl" type="number" min="1" max="1440" value="${Number(policy.ttlMinutes) || 30}"></label><button id="build-session-policy-save" class="primary">저장 정책</button></div><p class="small-note">이용 권한이 끝나거나 APK·라이선스·HMAC·서버 연결이 끊기면 WinSockServer가 즉시 다시 잠깁니다.</p></div></div>
  <div class="section-card"><div class="section-head"><h3>APK ↔ WinSockServer 고정 배정</h3><span class="small-note">웹 관리자에서만 배정 변경 가능</span></div><div class="table-wrap"><table><thead><tr><th>앱 기기</th><th>배정됨 서버</th><th>실행 배정</th><th>일치</th><th>활성</th><th>갱신됨</th><th>작업</th></tr></thead><tbody>${bindingRows || "<tr><td colspan=\"7\" class=\"empty\">앱 기기 없음</td></tr>"}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>실행 세션 이력</h3><div class="actions"><span class="small-note">활성 세션 보존</span>${roleIsAdmin()?"<button class=\"danger\" data-history-clean=\"BUILD_SESSIONS\">이력 정리</button>":''}</div></div><div class="table-wrap"><table><thead><tr><th>상태</th><th>세션</th><th>앱 기기</th><th>서버</th><th>콘텐츠</th><th>요청</th><th>인증됨</th><th>만료일</th><th>사유</th><th>작업</th></tr></thead><tbody>${sessionRows || "<tr><td colspan=\"10\" class=\"empty\">실행 세션 없음</td></tr>"}</tbody></table></div></div>`;
}

