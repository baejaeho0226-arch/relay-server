'use strict';

async function renderEnrollment() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { enrollment:e } = await api('/api/enrollment');
  const rows=(e.records||[]).map(r=>`<tr><td>${badge(r.type)}</td><td class="code">${esc(r.deviceKey)}</td><td>${badge(r.status)}</td><td class="code">${esc(r.requestId)}</td><td>${esc(r.appVersion||'-')}</td><td>${r.protocolVersion||'-'}</td><td class="code">${esc(r.ip||'-')}</td><td>${esc(fmtTime(r.lastSeenAt))}</td><td class="code">${esc(r.assignedId||'-')}</td><td><div class="actions">${r.status==='PENDING'?`<button class="primary" data-enroll-decision="APPROVED" data-request-id="${esc(r.requestId)}">승인</button><button class="danger" data-enroll-decision="REJECTED" data-request-id="${esc(r.requestId)}">거절</button>`:''}<button data-enroll-reset="${esc(r.requestId)}">초기화</button></div></td></tr>`).join('');
  content.innerHTML=`<div class="cards"><div class="card"><div class="stat-label">정책</div><div class="stat-value">${e.policy.enabled?"켜짐":"꺼짐"}</div><div class="stat-sub">기존 등록 기기는 정책 변경 후에도 재접속할 수 있습니다.</div></div><div class="card"><div class="stat-label">대기 중</div><div class="stat-value">${e.pending}</div></div><div class="card"><div class="stat-label">승인됨</div><div class="stat-value">${e.approved}</div></div><div class="card"><div class="stat-label">거절됨</div><div class="stat-value">${e.rejected}</div></div></div><div class="section-card"><div class="section-head"><h3>새 기기 승인</h3><div class="actions"><button id="enrollment-policy-btn" class="${e.policy.enabled?'warning':'primary'}">${e.policy.enabled?"비활성화 정책":"활성화 정책"}</button></div></div><div class="section-body"><p class="muted">정책 켜짐 이후 처음 보는 기기 키만 대기 중 처리됩니다. 이미 등록된 서버 / 앱 기기는 재접속에 영향 없습니다.</p><div class="table-wrap"><table><thead><tr><th>유형</th><th>기기 키</th><th>상태</th><th>요청</th><th>앱</th><th>프로토콜</th><th>IP</th><th>마지막 확인</th><th>배정됨 식별자</th><th>작업</th></tr></thead><tbody>${rows||"<tr><td colspan=\"10\" class=\"empty\">기기 등록 기록 없음</td></tr>"}</tbody></table></div></div></div>`;
}

async function renderSecurityCenter() {
  const [{ security:s }, networkResult] = await Promise.all([
    api('/api/security/dashboard'),
    api('/api/security/network')
  ]);
  const network = networkResult.summary || { total:0, changed:0, critical:0, warning:0, info:0 };
  const geo = networkResult.geo || {};
  const alerts=(s.alerts||[]).map(a=>`<div class="integrity-row">${badge(a.severity)}<span class="code">${esc(a.code)}</span><span>개수 ${a.count}</span><span>${esc(a.message||'')}</span></div>`).join('');
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
    const action=roleIsAdmin()?`<button data-network-trust data-type="${esc(n.type)}" data-id="${esc(n.id)}" ${n.changed?'':'disabled'}>신뢰 현재</button>`:'-';
    return `<tr><td>${badge(n.type)}</td><td class="code">${esc(n.id)}</td><td>${badge(n.status||'TRUSTED')}</td><td>${n.severity?badge(n.severity):badge('OK')}</td><td class="code">${esc(current.ip||'-')}</td><td class="code">${esc(trusted.ip||'-')}</td><td>${esc(location)}</td><td>${esc(trustedLocation)}</td><td class="code">${esc(current.subnet||'-')}</td><td class="code">${esc(trusted.subnet||'-')}</td><td>${n.changeCount||0}</td><td>${esc(fmtTime(n.lastChangeAt))}</td><td>${action}</td></tr>`;
  }).join('');
  content.innerHTML=`<div class="cards">
    <div class="card"><div class="stat-label">보안 점수</div><div class="stat-value">${s.score}</div><div class="stat-sub">${esc(s.label)}</div></div>
    <div class="card"><div class="stat-label">HMAC 검증 완료</div><div class="stat-value">${s.verified} / ${s.onlineHmacCapable}</div><div class="stat-sub">온라인 HMAC 지원</div></div>
    <div class="card"><div class="stat-label">네트워크 변경됨</div><div class="stat-value">${network.changed}</div><div class="stat-sub">긴급 ${network.critical} · Warn ${network.warning}</div></div>
    <div class="card"><div class="stat-label">접속 위치</div><div class="stat-value">${geo.available?"준비됨":'FALLBACK'}</div><div class="stat-sub">${esc(geo.provider||'none')} · 아니요 외부 API</div></div>
    <div class="card"><div class="stat-label">인증키 경과 시간</div><div class="stat-value">${s.staleSecrets}</div><div class="stat-sub">90일 이상 · 확인 전 ${s.unknownSecretAge}</div></div>
    <div class="card"><div class="stat-label">이전 방식</div><div class="stat-value">${s.legacy}</div><div class="stat-sub">활성 교체 작업 ${s.activeRotations}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>보안 알림</h3>${badge(s.label)}</div><div class="section-body">${alerts||"<div class=\"integrity-ok\">현재 보안 경고가 없습니다.</div>"}</div></div>
  <div class="section-card"><div class="section-head"><h3>신뢰하는 네트워크 기준</h3><span class="small-note">국가=긴급 · 서브넷=주의 · IP=안내 · 자동 차단 없음</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>유형</th><th>식별자</th><th>상태</th><th>중요도</th><th>현재 IP</th><th>승인된 IP</th><th>현재 위치</th><th>승인된 위치</th><th>현재 서브넷</th><th>승인된 서브넷</th><th>변경 사항</th><th>마지막 변경</th><th>작업</th></tr></thead><tbody>${networkRows||"<tr><td colspan=\"13\" class=\"empty\">네트워크 프로필 없음</td></tr>"}</tbody></table></div></div></div>
  <div class="section-card"><div class="section-head"><h3>기기별 보안 상태</h3><span class="small-note">HMAC / 기기 등록 / 인증키 경과 시간 / 인증키 교체</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>유형</th><th>식별자</th><th>연결</th><th>HMAC</th><th>정책</th><th>인증키</th><th>경과 시간</th><th>인증 상태</th><th>마지막 검증됨</th><th>인증키 교체</th></tr></thead><tbody>${rows||"<tr><td colspan=\"10\" class=\"empty\">기기 없음</td></tr>"}</tbody></table></div></div></div>`;
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
    const actions = roleIsAdmin() && sec.online ? `<div class="actions"><button data-security-challenge data-type="${esc(r.type)}" data-id="${esc(r.id)}">인증 요청</button><button class="warning" data-security-rotate data-type="${esc(r.type)}" data-id="${esc(r.id)}">인증키 교체 인증키</button><button class="danger" data-security-reset data-type="${esc(r.type)}" data-id="${esc(r.id)}">재등록</button></div>` : '-';
    return `<tr><td>${badge(r.type)}</td><td class="code">${esc(r.id)}</td><td>${r.ready ? badge('READY') : badge('BLOCKED')}</td><td>${esc((r.profile && `${r.profile.current} → ${r.profile.candidate}`) || '-')}</td><td>${sec.hasSecret ? badge('ENROLLED') : badge('NONE')}</td><td>${sec.verified ? badge('VERIFIED') : badge(sec.online ? 'UNVERIFIED' : 'OFFLINE')}</td><td>${sec.enforced ? badge('ENFORCED') : badge('OPTIONAL')}</td><td>${rot ? badge(rot.status) : badge('NONE')}</td><td>${seq.capable ? badge(seq.enabled ? 'ON' : 'OFF') : badge('LEGACY')}</td><td>${st.rxLast || 0}</td><td>${st.rxMissing || 0}</td><td>${st.rxDuplicates || 0}</td><td>${st.rxOutOfOrder || 0}</td><td>${esc((r.blockers || []).join(', ') || '-')}</td><td>${actions}</td></tr>`;
  }).join('');
  const verified = (security || []).filter(x => x.verified).length;
  const enrolled = (security || []).filter(x => x.hasSecret).length;
  const missing = (sequences || []).reduce((a,x)=>a+Number(x.stats&&x.stats.rxMissing||0),0);
  const anomalies = (sequences || []).reduce((a,x)=>a+Number(x.stats&&x.stats.rxDuplicates||0)+Number(x.stats&&x.stats.rxOutOfOrder||0),0);
  content.innerHTML = `<div class="cards">
    <div class="card"><div class="stat-label">V3 준비됨</div><div class="stat-value">${readiness.ready} / ${readiness.total}</div><div class="stat-sub">후보 프로토콜 ${readiness.candidateProtocol}</div></div>
    <div class="card"><div class="stat-label">HMAC 검증 완료</div><div class="stat-value">${verified}</div><div class="stat-sub">등록됨 ${enrolled}</div></div>
    <div class="card"><div class="stat-label">이벤트 순서 누락</div><div class="stat-value">${missing}</div><div class="stat-sub">감지됨 누락</div></div>
    <div class="card"><div class="stat-label">이벤트 순서 이상 징후</div><div class="stat-value">${anomalies}</div><div class="stat-sub">중복 / 순서 어긋남</div></div>
  </div><div class="section-card"><div class="section-head"><h3>프로토콜 3 준비 상태 · 기기 보안 · 이벤트 순서</h3><span class="small-note">현재 프로토콜 2를 사용합니다. 이 화면은 새 프로토콜 준비 상태를 확인합니다.</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>유형</th><th>식별자</th><th>V3</th><th>프로필</th><th>인증키</th><th>HMAC</th><th>정책</th><th>인증키 교체</th><th>이벤트 순서</th><th>마지막 수신 순서</th><th>누락</th><th>중복</th><th>순서 어긋남</th><th>차단 요인</th><th>작업</th></tr></thead><tbody>${rows || "<tr><td colspan=\"15\" class=\"empty\">기기 없음</td></tr>"}</tbody></table></div></div></div>`;
}

