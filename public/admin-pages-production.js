'use strict';

function pkDecode(value){const text=String(value||'').replace(/-/g,'+').replace(/_/g,'/');const raw=atob(text+'==='.slice((text.length+3)%4));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
function pkEncode(value){const bytes=new Uint8Array(value);let raw='';for(const b of bytes)raw+=String.fromCharCode(b);return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function normalizePublicKeyOptions(options){const x=JSON.parse(JSON.stringify(options));x.challenge=pkDecode(x.challenge);if(x.user)x.user.id=pkDecode(x.user.id);if(x.allowCredentials)x.allowCredentials=x.allowCredentials.map(c=>({...c,id:pkDecode(c.id)}));return x;}

async function registerAdminPasskey(){
  if(!window.PublicKeyCredential||!navigator.credentials)throw new Error('이 브라우저는 WebAuthn 패스키를 지원하지 않습니다.');
  const begin=await api('/api/production/passkeys/register/begin',{method:'POST',body:{}});
  const credential=await navigator.credentials.create({publicKey:normalizePublicKeyOptions(begin.publicKey)});
  const response=credential.response;
  if(typeof response.getPublicKey!=='function'||!response.getPublicKey())throw new Error('브라우저가 공개키 내보내기를 지원하지 않습니다.');
  const values=await openModal({title:'패스키 이름',message:'이 기기를 구분할 이름을 입력하세요.',fields:[{name:'name',label:'이름',value:'Admin Passkey'}],confirmLabel:'등록'});
  if(!values)return;
  await api('/api/production/passkeys/register/finish',{method:'POST',body:{challengeId:begin.challengeId,credentialId:pkEncode(credential.rawId),clientDataJSON:pkEncode(response.clientDataJSON),authenticatorData:pkEncode(response.getAuthenticatorData()),publicKeySpki:pkEncode(response.getPublicKey()),name:values.name}});
  toast('관리자 패스키가 등록되었습니다.');await renderProductionHardening();
}

async function loginWithPasskey(){
  if(!window.PublicKeyCredential||!navigator.credentials)throw new Error('이 브라우저는 WebAuthn 패스키를 지원하지 않습니다.');
  const begin=await api('/api/passkey/login/begin',{method:'POST',body:{role:loginRole.value}});
  const credential=await navigator.credentials.get({publicKey:normalizePublicKeyOptions(begin.publicKey)});
  const response=credential.response;
  const done=await api('/api/passkey/login/finish',{method:'POST',body:{challengeId:begin.challengeId,credentialId:pkEncode(credential.rawId),clientDataJSON:pkEncode(response.clientDataJSON),authenticatorData:pkEncode(response.authenticatorData),signature:pkEncode(response.signature)}});
  session={role:done.role,csrf:done.csrf,expiresAt:done.expiresAt};showApp();
}

async function renderProductionHardening(){
  if(!roleIsAdmin()){content.innerHTML="<div class=\"empty\">접근 권한 없음</div>";return;}
  const d=await api('/api/production'),c=d.compatibility,t=d.transport,u=d.updates,s=d.slo;
  const devices=c.devices.map(x=>`<tr><td>${badge(x.type)}</td><td class="code">${esc(x.id)}</td><td>${badge(x.online?'ONLINE':'OFFLINE')}</td><td>${esc(x.version||'-')} / P${x.protocol}</td><td>${badge(x.compatible?'MATCHED':'MISMATCH')}</td><td>${x.missing.map(badge).join(' ')||'-'}</td><td class="code">${esc(x.fingerprint)}</td></tr>`).join('');
  const incidents=d.incidents.slice(0,30).map(x=>`<tr><td>${badge(x.severity)}</td><td class="code">${esc(x.id)}</td><td>${esc(x.title)}</td><td>${esc(x.entity)}</td><td>${x.count}</td><td>${badge(x.status)}</td><td>${esc(fmtTime(x.lastAt))}</td><td>${x.status==='OPEN'?`<button data-prod-resolve="${esc(x.id)}">해결</button>`:'-'}</td></tr>`).join('');
  const tx=u.transactions.slice(0,30).map(x=>`<tr><td>${esc(uiText(x.type))}</td><td class="code">${esc(x.id)}</td><td>${esc(uiText(x.channel))}</td><td>${esc(x.version)}</td><td>${badge(x.status)}</td><td>${esc(fmtTime(x.updatedAt))}</td></tr>`).join('');
  const passkeys=d.passkeys.map(x=>`<tr><td>${esc(x.name)}</td><td class="code">${esc(x.id)}</td><td>${esc(fmtTime(x.createdAt))}</td><td>${esc(fmtTime(x.lastUsedAt))}</td><td>${x.revokedAt?badge('REVOKED'):`<button class="danger" data-prod-passkey-revoke="${esc(x.id)}">해제</button>`}</td></tr>`).join('');
  const approvals=d.approvals.slice(0,20).map(x=>`<tr><td class="code">${esc(x.ticketId)}</td><td>${esc(x.method)} ${esc(x.pathname)}</td><td>${badge(x.status)}</td><td>${esc(x.requestedBy)}</td><td>${esc(x.approvedBy||'-')}</td><td>${x.status==='PENDING'?`<button data-prod-approval="${esc(x.ticketId)}">2차 승인</button>`:'-'}</td></tr>`).join('');
  const anomalies=d.anomalies.map(x=>`<tr><td>${esc(x.key)}</td><td>${badge(x.severity)}</td><td>${badge(x.status)}</td><td>${x.count}</td><td>${esc(fmtTime(x.lastAt))}</td></tr>`).join('');
  content.innerHTML=`
  <div class="cards production-summary">
    <div class="card"><div class="stat-label">호환됨</div><div class="stat-value">${c.summary.compatible}/${c.summary.online}</div><div class="stat-sub">접속 중인 기기 식별값</div></div>
    <div class="card"><div class="stat-label">통신</div><div class="stat-value compact">${esc(t.actualMode)}</div><div class="stat-sub">${t.tlsConfigured?'certificate loaded':"HMAC 인증됨"}</div></div>
    <div class="card"><div class="stat-label">서비스 목표</div><div class="stat-value">${s.ackSuccess.toFixed(2)}%</div><div class="stat-sub">허용량 ${s.errorBudget.remainingPercent}%</div></div>
    <div class="card"><div class="stat-label">감사 기록 검증 체인</div><div class="stat-value compact">${d.audit.lastError?'INVALID':"검증됨"}</div><div class="stat-sub">${d.audit.count} 이벤트</div></div>
  </div>
  ${!t.tlsConfigured?"<div class=\"warning-box\">중계 서버 TCP는 현재 HMAC 인증 모드입니다. TLS 인증서 파일을 서버 환경에 설정하기 전에는 TLS/Pinning이 활성화된 것으로 표시하지 않습니다.</div>":''}
  <div class="production-grid">
    <div class="section-card"><div class="section-head"><h3>호환성 / 빌드 식별값</h3><span>${c.summary.mismatch} 불일치</span></div><div class="table-wrap"><table><thead><tr><th>유형</th><th>식별자</th><th>연결</th><th>버전</th><th>상태</th><th>누락</th><th>식별값</th></tr></thead><tbody>${devices||'<tr><td colspan="7" class="empty">기기 없음</td></tr>'}</tbody></table></div></div>
    <div class="section-card"><div class="section-head"><h3>서명 검증 업데이트 관리</h3><button data-prod-rollback>수동 되돌리기</button></div><div class="section-body kv"><div>자동 되돌리기</div><div>${badge(u.policy.autoRollback?'ACTIVE':'OFF')}</div><div>실패 기준값</div><div>${u.policy.failureThresholdPercent}% / 최소 ${u.policy.minimumSamples}</div><div>시작 처리 응답</div><div>${u.policy.startupAckSeconds}s</div></div><div class="table-wrap compact-table"><table><tbody>${tx||'<tr><td class="empty">트랜잭션 없음</td></tr>'}</tbody></table></div></div>
    <div class="section-card"><div class="section-head"><h3>감사 기록 / 장애 시간순 이력</h3><button data-prod-audit-verify>검증 검증 체인</button></div><div class="table-wrap"><table><thead><tr><th>중요도</th><th>식별자</th><th>신호</th><th>대상</th><th>개수</th><th>상태</th><th>마지막</th><th></th></tr></thead><tbody>${incidents||'<tr><td colspan="8" class="empty">장애 없음</td></tr>'}</tbody></table></div></div>
    <div class="section-card"><div class="section-head"><h3>서비스 목표·허용 오류량</h3><span>${badge(s.compliant?'GOOD':'WARNING')}</span></div><div class="section-body metric-row"><div><span>가용률</span><strong>${s.availability}%</strong></div><div><span>응답 성공</span><strong>${s.ackSuccess}%</strong></div><div><span>상위 95% 응답 시간</span><strong>${s.p95Ms}ms</strong></div><div><span>남은 허용 오류량</span><strong>${s.errorBudget.remainingPercent}%</strong></div></div></div>
    <div class="section-card"><div class="section-head"><h3>패스키 로그인</h3><button class="primary" data-prod-passkey-register>패스키 등록</button></div><div class="table-wrap"><table><thead><tr><th>이름</th><th>식별자</th><th>생성됨</th><th>마지막 사용됨</th><th></th></tr></thead><tbody>${passkeys||'<tr><td colspan="5" class="empty">등록된 패스키 없음</td></tr>'}</tbody></table></div></div>
    <div class="section-card"><div class="section-head"><h3>관리자 이중 승인</h3><button data-prod-dual-toggle>${d.dualApprovalRequired?"비활성화":"활성화"}</button></div><div class="section-body"><p class="small-note">삭제·복원·서비스 종료·핵심 정책 변경은 서로 다른 관리자 세션의 승인 티켓으로 보호할 수 있습니다.</p></div><div class="table-wrap"><table><thead><tr><th>승인 요청</th><th>작업</th><th>상태</th><th>요청자</th><th>승인자</th><th></th></tr></thead><tbody>${approvals||'<tr><td colspan="6" class="empty">승인 티켓 없음</td></tr>'}</tbody></table></div></div>
    <div class="section-card"><div class="section-head"><h3>설정 적용 미리보기</h3><button class="primary" data-prod-dry-run>새 계획 검사</button></div><div class="section-body"><div class="kv"><div>배포 명세 개정 번호</div><div>${c.manifest.revision}</div><div>마지막 운영자</div><div>${esc(c.manifest.updatedBy||'-')}</div></div>${c.manifest.lastDryRun?`<div class="warning-box"><strong>${esc(c.manifest.lastDryRun.planId)}</strong><br>${c.manifest.lastDryRun.warnings.map(esc).join('<br>')||'검사 통과'}<br><button data-prod-apply-plan="${esc(c.manifest.lastDryRun.planId)}">적용 계획</button></div>`:''}</div></div>
    <div class="section-card"><div class="section-head"><h3>복구 / 진단</h3><div class="actions"><button data-prod-drill>복구 모의 복구</button><button data-prod-diag>기기 묶음 파일</button></div></div><div class="section-body kv"><div>마지막 모의 복구</div><div>${d.recoveryDrills[0]?badge(d.recoveryDrills[0].ok?'PASS':'FAIL'):'-'}</div><div>묶음 파일</div><div>${d.diagnosticsBundles.length}</div><div>복원 모드</div><div>분리된 검증</div></div></div>
    <div class="section-card"><div class="section-head"><h3>이상 징후 탐지</h3><span>최근 15분 기준</span></div><div class="table-wrap"><table><thead><tr><th>규칙</th><th>중요도</th><th>상태</th><th>개수</th><th>마지막</th></tr></thead><tbody>${anomalies||'<tr><td colspan="5" class="empty">이상 징후 없음</td></tr>'}</tbody></table></div></div>
    <div class="section-card"><div class="section-head"><h3>보관 기간 / 자동 정리</h3><button data-prod-retention>적용 지금</button></div><div class="section-body kv"><div>감사 기록</div><div>${d.retention.auditDays}d</div><div>장애 기록</div><div>${d.retention.incidentDays}d</div><div>진단</div><div>${d.retention.diagnosticsDays}d</div><div>업데이트</div><div>${d.retention.updateDays}d</div></div></div>
    <div class="section-card"><div class="section-head"><h3>구성요소 목록·소스 무결성</h3><button data-prod-sbom>생성</button></div><div class="section-body kv"><div>생성됨</div><div>${esc(fmtTime(d.supplyChain.generatedAt))}</div><div>파일</div><div>${(d.supplyChain.files||[]).length}</div><div>소스 해시</div><div class="code wrap-code">${esc(d.supplyChain.sourceHash||'-')}</div><div>위반 사항</div><div>${(d.supplyChain.violations||[]).length}</div></div></div>
    <div class="section-card"><div class="section-head"><h3>장애 대응 모의 시험</h3><button data-prod-chaos>실행 모의 실행</button></div><div class="section-body"><p class="small-note">실기기 연결을 끊지 않는 모델 기반 검증입니다. 운영 데이터와 기기에는 쓰지 않습니다.</p><div class="kv"><div>마지막 시나리오</div><div>${esc(d.chaosRuns[0]?.scenario||'-')}</div><div>모드</div><div>모의 실행 전용</div></div></div></div>
  </div>`;
}

document.getElementById('passkey-login-btn')?.addEventListener('click',()=>loginWithPasskey().catch(e=>{loginError.textContent=e.message;}));
document.addEventListener('click',async event=>{try{
  if(event.target.closest('[data-prod-passkey-register]'))return await registerAdminPasskey();
  const revoke=event.target.closest('[data-prod-passkey-revoke]');if(revoke){await api('/api/production/passkeys/revoke',{method:'POST',body:{id:revoke.dataset.prodPasskeyRevoke}});return await renderProductionHardening();}
  const resolve=event.target.closest('[data-prod-resolve]');if(resolve){await api('/api/production/incidents/resolve',{method:'POST',body:{id:resolve.dataset.prodResolve}});return await renderProductionHardening();}
  if(event.target.closest('[data-prod-audit-verify]')){const r=await api('/api/production/audit/verify',{method:'POST',body:{}});toast(r.verification.ok?"감사 기록 검증 체인 검증됨":`감사 기록 invalid: ${r.verification.error}`,!r.verification.ok);return await renderProductionHardening();}
  if(event.target.closest('[data-prod-dual-toggle]')){const d=await api('/api/production');await api('/api/production/dual-policy',{method:'POST',body:{required:!d.dualApprovalRequired}});toast('2인 승인 정책이 변경되었습니다.');return await renderProductionHardening();}
  const approve=event.target.closest('[data-prod-approval]');if(approve){await api('/api/production/approvals/approve',{method:'POST',body:{ticketId:approve.dataset.prodApproval}});toast('2차 승인이 완료되었습니다.');return await renderProductionHardening();}
  if(event.target.closest('[data-prod-dry-run]')){const v=await openModal({title:"설정 적용 미리보기",fields:[{name:'minProtocolVersion',label:"최소값 프로토콜",type:'number',value:'2'},{name:'heartbeatMs',label:"연결 확인 주기 (밀리초)",type:'number',value:'10000'}],confirmLabel:'검사'});if(!v)return;const r=await api('/api/production/config/dry-run',{method:'POST',body:{minProtocolVersion:Number(v.minProtocolVersion),heartbeatMs:Number(v.heartbeatMs)}});toast(r.plan.safe?"Dry 실행 통과":`경고 ${r.plan.warnings.length}건`);return await renderProductionHardening();}
  const apply=event.target.closest('[data-prod-apply-plan]');if(apply){await api('/api/production/config/apply',{method:'POST',body:{planId:apply.dataset.prodApplyPlan}});toast('검증된 설정 계획이 적용되었습니다.');return await renderProductionHardening();}
  if(event.target.closest('[data-prod-drill]')){const r=await api('/api/production/recovery-drill',{method:'POST',body:{}});toast(r.drill.ok?'복구 훈련 PASS':'복구 훈련 FAIL',!r.drill.ok);return await renderProductionHardening();}
  if(event.target.closest('[data-prod-diag]')){const v=await openModal({title:"기기 진단 묶음 파일",fields:[{name:'type',label:"유형",type:'select',value:'CLIENT',options:[{value:'CLIENT',label:"앱 기기"},{value:'SERVER',label:"서버"}]},{name:'id',label:"기기 식별자",value:''}],confirmLabel:'생성'});if(!v)return;const r=await api('/api/production/diagnostics',{method:'POST',body:v}),a=document.createElement('a');a.href=`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(r.bundle.payload,null,2))}`;a.download=`${r.bundle.bundleId}.json`;a.click();toast('비밀값이 제거된 진단 번들을 생성했습니다.');return await renderProductionHardening();}
  if(event.target.closest('[data-prod-retention]')){const r=await api('/api/production/retention/apply',{method:'POST',body:{}});toast(`보존 정책 적용: ${Object.values(r.removed).reduce((a,b)=>a+b,0)}건 정리`);return await renderProductionHardening();}
  if(event.target.closest('[data-prod-sbom]')){await api('/api/production/supply-chain',{method:'POST',body:{}});toast('SBOM 및 소스 해시를 생성했습니다.');return await renderProductionHardening();}
  if(event.target.closest('[data-prod-chaos]')){const v=await openModal({title:"장애 대응 모의 실행",fields:[{name:'scenario',label:"시나리오",type:'select',value:'SERVER_OUTAGE',options:['SERVER_OUTAGE','RELAY_LATENCY','DATABASE_READ_ONLY','AUTH_FLOOD'].map(x=>({value:x,label:x}))}],confirmLabel:'시뮬레이션'});if(!v)return;const r=await api('/api/production/chaos',{method:'POST',body:v});toast(`${r.run.scenario}: PASS`);return await renderProductionHardening();}
  if(event.target.closest('[data-prod-rollback]')){const v=await openModal({title:"서명 검증 업데이트 되돌리기",fields:[{name:'type',label:"유형",type:'select',value:'SERVER',options:[{value:'SERVER',label:"서버"},{value:'CLIENT',label:"앱 기기"}]},{name:'channel',label:"채널",type:'select',value:'TEST',options:['TEST','BETA','STABLE'].map(x=>({value:x,label:x}))},{name:'reason',label:"사유",value:'ADMIN_ROLLBACK'}],danger:true,confirmLabel:"되돌리기"});if(!v)return;await api('/api/production/update/rollback',{method:'POST',body:v});toast('서명 업데이트 롤백 정책을 적용했습니다.');return await renderProductionHardening();}
}catch(error){toast(error.message,true);}});
