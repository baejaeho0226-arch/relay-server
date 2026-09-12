'use strict';

function distributionBar(value, max, cls='live') {
  const pct = Math.max(0, Math.min(100, max > 0 ? (Number(value||0)/max)*100 : 0));
  return `<div class="distribution-meter"><i class="${esc(cls)}" style="width:${pct.toFixed(1)}%"></i></div><span class="distribution-pct">${pct.toFixed(1)}%</span>`;
}

async function renderDistribution() {
  const [{ servers }, { system }] = await Promise.all([api('/api/servers'), api('/api/system')]);
  const max = Number(system.maxClientsPerServer || 1);
  const sorted = [...servers].sort((a,b)=>b.savedClients-a.savedClients || b.clients-a.clients);
  const totalLive=sorted.reduce((n,x)=>n+x.clients,0), totalSaved=sorted.reduce((n,x)=>n+x.savedClients,0);
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">전체 실시간 연결</div><div class="stat-value">${totalLive}</div><div class="stat-sub">접속 중인 앱 연결</div></div><div class="card"><div class="stat-label">전체 배정</div><div class="stat-value">${totalSaved}</div><div class="stat-sub">고정 앱 기기 → 서버</div></div><div class="card"><div class="stat-label">수용량</div><div class="stat-value">${sorted.length*max}</div><div class="stat-sub">${max} / 서버</div></div><div class="card"><div class="stat-label">연결 정리 중</div><div class="stat-value">${sorted.filter(x=>x.drain&&x.drain.active).length}</div><div class="stat-sub">준비됨 ${sorted.filter(x=>x.drain&&x.drain.ready).length}</div></div></div><div class="section-card"><div class="section-head"><h3>서버별 앱 배정</h3><span class="small-note">3초마다 자동 갱신</span></div><div class="distribution-list">${sorted.map(s=>`<div class="distribution-row"><div class="distribution-id"><strong>${esc(s.alias||s.id)}</strong><small>${esc(s.id)}</small>${badge(s.status)} ${badge(s.health)}</div><div class="distribution-load"><label>실시간 연결 <b>${s.clients}/${max}</b></label>${distributionBar(s.clients,max,'live')}<label>배정 <b>${s.savedClients}/${max}</b></label>${distributionBar(s.savedClients,max,'saved')}</div><div class="distribution-drain">${s.drain&&s.drain.active?`<div class="drain-label">연결 정리 // ${s.drain.ready?"<strong>점검 준비 완료</strong>":`${s.drain.currentClients} ACTIVE`}</div><div class="drain-progress"><i style="width:${s.drain.progress}%"></i></div><div class="small-note">${s.drain.progress}% // 시작 ${esc(fmtTime(s.drain.startedAt))} // initial ${s.drain.initialClients}</div>`:`<span class="small-note">수용 앱 기기: ${esc(s.acceptState || (s.canAcceptClients?'READY':'OFFLINE'))}</span>`}</div>${roleIsAdmin()?`<div class="actions">${s.drain&&s.drain.active?`<button data-server-action="drain-off" data-id="${esc(s.id)}">연결 정리 꺼짐</button>`:`<button data-server-action="drain-on" data-id="${esc(s.id)}">연결 정리 켜짐</button>`}</div>`:''}</div>`).join('')||"<div class=\"empty\">서버 없음</div>"}</div></div>`;
}


async function renderFailover() {
  const [{ failover:f }, { servers }] = await Promise.all([api('/api/failover'), api('/api/servers')]);
  failoverServers = servers || [];
  failoverRows = new Map((f.clients||[]).map(x=>[x.clientId,x]));
  const p=f.policy||{}, sum=f.summary||{};
  const rows=(f.clients||[]).map(c=>{
    const stateLabel=c.failedOver?'FAILED_OVER':(c.enabled?'ARMED':'OFF');
    const action=roleIsAdmin()?`<div class="actions"><button data-binding-edit="${esc(c.clientId)}">배정</button>${c.bindingConfigured?`<button data-binding-clear="${esc(c.clientId)}">지우기</button>`:''}<button data-failover-toggle="${esc(c.clientId)}" data-enabled="${c.enabled?'0':'1'}">${c.enabled?"허용 해제":"개별 허용"}</button>${c.failedOver?`<button class="warning" data-failover-return="${esc(c.clientId)}">기본 서버로 복귀</button>`:''}</div>`:'-';
    return `<tr><td class="code">${esc(c.clientId)}</td><td>${badge(stateLabel)}</td><td>${c.bindingConfigured?badge('CONFIGURED'):badge('AUTO')}</td><td class="code">${esc(c.primaryServerId||'-')}</td><td class="code">${esc(c.backupServerId||'-')}</td><td class="code">${esc(c.currentServerId||'-')}</td><td>${badge(c.primaryStatus||'UNKNOWN')}</td><td>${badge(c.backupStatus||'NOT_CONFIGURED')}</td><td>${c.allowAutomaticFallback?"예":"아니요"}</td><td>${c.moveCount||0}</td><td>${esc(c.selectedBy||c.reason||'-')}</td><td>${esc(fmtTime(c.failedOverAt))}</td><td>${action}</td></tr>`;
  }).join('');
  content.innerHTML=`<div class="cards">
    <div class="card"><div class="stat-label">전체 정책</div><div class="stat-value">${p.enabled?"켜짐":"꺼짐"}</div><div class="stat-sub">기본 꺼짐 · 개별 허용 전용</div></div>
    <div class="card"><div class="stat-label">개별 허용 앱 기기</div><div class="stat-value">${sum.optedIn||0}</div><div class="stat-sub">전체 ${sum.totalClients||0}</div></div>
    <div class="card"><div class="stat-label">장애 전환됨</div><div class="stat-value">${sum.failedOver||0}</div><div class="stat-sub">임시 배정</div></div>
    <div class="card"><div class="stat-label">주 서버 연결 끊김</div><div class="stat-value">${sum.primaryUnavailable||0}</div><div class="stat-sub">대기 중·유예 시간 적용</div></div>
    <div class="card"><div class="stat-label">직접 지정 배정</div><div class="stat-value">${sum.configuredBindings||0}</div><div class="stat-sub">기본·예비 서버 정책</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>장애 자동 전환 정책</h3><span class="small-note">기본 배정을 유지하며 연결 정리는 장애 전환을 유발하지 않습니다.</span></div><div class="section-body">
    <div class="form-grid">
      <label>전체<select id="failover-policy-enabled"><option value="0" ${p.enabled?'':'selected'}>꺼짐</option><option value="1" ${p.enabled?'selected':''}>켜짐</option></select></label>
      <label>기본 서버 자동 복귀<select id="failover-auto-return"><option value="1" ${p.autoReturn?'selected':''}>켜짐</option><option value="0" ${p.autoReturn?'':'selected'}>꺼짐</option></select></label>
      <label>연결 끊김 유예 시간 (초)<input id="failover-offline-grace" type="number" min="0" max="3600" value="${Number(p.offlineGraceSeconds||15)}"></label>
      <label>복귀 유예 시간 (초)<input id="failover-return-grace" type="number" min="0" max="3600" value="${Number(p.returnGraceSeconds||30)}"></label>
      <label>최대 이동 횟수 / 주기<input id="failover-max-moves" type="number" min="1" max="1000" value="${Number(p.maxMovesPerCycle||50)}"></label>
    </div>
    ${roleIsAdmin()?"<div class=\"toolbar\"><button id=\"failover-policy-save\" class=\"primary\">저장 정책</button><button id=\"failover-run-now\">평가 지금</button></div>":''}
    <div class="warning-box">장애 자동 전환은 기존 고정 서버 식별자를 삭제하지 않습니다. 장애 전환 기록에 기본 서버를 보존하고, 장애 시에만 임시 배정으로 이동합니다. 점검 중에는 자동 이동을 멈춥니다.</div>
  </div></div>
  <div class="section-card"><div class="section-head"><h3>기본·예비 서버 배정 현황</h3><span class="small-note">명시적 백업 우선 · 선택적으로 자동 대체</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>앱 기기</th><th>모드</th><th>배정</th><th>기본</th><th>백업</th><th>현재</th><th>기본 상태</th><th>백업 상태</th><th>대체 서버 자동 선택</th><th>이동 횟수</th><th>선택</th><th>실패 시각</th><th>작업</th></tr></thead><tbody>${rows||"<tr><td colspan=\"13\" class=\"empty\">앱 기기 없음</td></tr>"}</tbody></table></div></div></div>`;
}

async function renderRecovery() {
  const { recovery:r } = await api(`/api/request-recovery?query=${encodeURIComponent(recoveryQuery)}`);
  const p=r.policy||{}, s=r.summary||{};
  const clientRows=(r.clients||[]).map(x=>`<tr><td class="code">${esc(x.clientId)}</td><td class="code">${esc(x.serverId)}</td><td>${badge(x.enabled?'ON':'OFF')}</td><td>${x.queued}</td><td>${x.deadLetters}</td><td>${roleIsAdmin()?`<button data-queue-toggle="${esc(x.clientId)}" data-enabled="${x.enabled?'0':'1'}">${x.enabled?"비활성화":"활성화"}</button>`:'-'}</td></tr>`).join('');
  const queueRows=(r.queue||[]).map(x=>`<tr><td class="code">${esc(x.queueId)}</td><td class="code">${esc(x.requestId)}</td><td class="code">${esc(x.clientId)}</td><td class="code">${esc(x.serverId||'-')}</td><td class="code">${esc(x.number)}</td><td>${x.attempts}</td><td>${esc(uiText(x.reason))}</td><td>${esc(fmtTime(x.queuedAt))}</td><td>${esc(fmtTime(x.expiresAt))}</td></tr>`).join('');
  const dlqRows=(r.deadLetters||[]).map(x=>`<tr><td class="code">${esc(x.deadLetterId)}</td><td>${badge(x.status)}</td><td class="code">${esc(x.originalRequestId)}</td><td class="code">${esc(x.clientId)}</td><td class="code">${esc(x.serverId||'-')}</td><td class="code">${esc(x.number)}</td><td>${esc(uiText(x.reason))}</td><td>${x.attempts}</td><td>${esc(fmtTime(x.failedAt))}</td><td>${x.status==='ACTIVE'&&roleIsAdmin()?`<div class="actions"><button class="warning" data-dlq-retry="${esc(x.deadLetterId)}">다시 시도</button><button data-dlq-discard="${esc(x.deadLetterId)}">폐기</button></div>`:(x.lastReplayRequestId?`<span class="code">${esc(x.lastReplayRequestId)}</span>`:'-')}</td></tr>`).join('');
  content.innerHTML=`<div class="cards">
    <div class="card"><div class="stat-label">오프라인 대기열</div><div class="stat-value">${p.enabled?"켜짐":"꺼짐"}</div><div class="stat-sub">개별 허용 앱 기기 ${s.enabledClients||0}</div></div>
    <div class="card"><div class="stat-label">대기 중</div><div class="stat-value">${s.queued||0}</div><div class="stat-sub">앱 기기별 순서 유지</div></div>
    <div class="card"><div class="stat-label">활성 실패 보관함</div><div class="stat-value">${s.activeDeadLetters||0}</div><div class="stat-sub">운영자 확인 필요</div></div>
    <div class="card"><div class="stat-label">해결됨 실패 보관함</div><div class="stat-value">${(s.replayedDeadLetters||0)+(s.discardedDeadLetters||0)}</div><div class="stat-sub">재전송 ${s.replayedDeadLetters||0} · 폐기 ${s.discardedDeadLetters||0}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>오프라인 대기열 정책</h3><span class="small-note">기본 꺼짐 · 앱 기기별 개별 허용 · 입력 순서 유지</span></div><div class="section-body"><div class="form-grid">
    <label>전체<select id="queue-policy-enabled"><option value="0" ${p.enabled?'':'selected'}>꺼짐</option><option value="1" ${p.enabled?'selected':''}>켜짐</option></select></label>
    <label>최대 / 앱 기기<input id="queue-policy-max" type="number" min="1" max="1000" value="${Number(p.maxItemsPerClient||100)}"></label>
    <label>유효 시간 (초)<input id="queue-policy-ttl" type="number" min="30" max="604800" value="${Number(p.ttlSeconds||3600)}"></label>
    <label>전달 시도 횟수<input id="queue-policy-attempts" type="number" min="1" max="50" value="${Number(p.maxDeliveryAttempts||5)}"></label>
  </div>${roleIsAdmin()?"<div class=\"toolbar\"><button id=\"queue-policy-save\" class=\"primary\">저장 정책</button></div>":''}<div class="warning-box">대기열은 앱 기기별 입력 순서를 보존합니다. 재전송에는 동일 요청 식별자를 사용해 MoaPlayConnect RequestCache의 중복 처리 방지를 유지합니다.</div></div></div>
  <div class="section-card"><div class="section-head"><h3>앱 기기 대기열 개별 허용</h3></div><div class="table-wrap"><table><thead><tr><th>앱 기기</th><th>현재 서버</th><th>대기열</th><th>대기 중</th><th>활성 실패 보관함</th><th>작업</th></tr></thead><tbody>${clientRows||"<tr><td colspan=\"6\" class=\"empty\">앱 기기 없음</td></tr>"}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>오프라인 대기열</h3><span class="small-note">서버 복구 후 자동 전달</span></div><div class="table-wrap"><table><thead><tr><th>대기열 식별자</th><th>요청</th><th>앱 기기</th><th>대상</th><th>입력값</th><th>시도 횟수</th><th>사유</th><th>대기 시작 시각</th><th>만료일</th></tr></thead><tbody>${queueRows||"<tr><td colspan=\"9\" class=\"empty\">대기 중 요청 없음</td></tr>"}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>전송 실패 보관함</h3><div class="actions"><input id="recovery-search" placeholder="실패 보관함 / 요청 / 앱 기기 / 사유" value="${esc(recoveryQuery)}"><button id="recovery-search-btn">검색</button>${roleIsAdmin()?"<button class=\"danger\" data-history-clean=\"DLQ\">해결된 이력 정리</button>":''}</div></div><div class="table-wrap"><table><thead><tr><th>실패 보관함 식별자</th><th>상태</th><th>원본 요청</th><th>앱 기기</th><th>서버</th><th>입력값</th><th>사유</th><th>시도 횟수</th><th>실패 시각</th><th>작업 / 재전송</th></tr></thead><tbody>${dlqRows||"<tr><td colspan=\"10\" class=\"empty\">전송 실패 요청 없음</td></tr>"}</tbody></table></div></div>`;
}

