'use strict';
async function handleTrafficAction(event) {
    if (event.target.id === 'failover-policy-save') {
      const body={
        enabled:document.getElementById('failover-policy-enabled').value==='1',
        autoReturn:document.getElementById('failover-auto-return').value==='1',
        offlineGraceSeconds:Number(document.getElementById('failover-offline-grace').value),
        returnGraceSeconds:Number(document.getElementById('failover-return-grace').value),
        maxMovesPerCycle:Number(document.getElementById('failover-max-moves').value)
      };
      await api('/api/failover/policy',{method:'POST',body}); toast("장애 자동 전환 정책 저장"); await renderFailover(); return true;
    }
    if (event.target.id === 'failover-run-now') { const r=await api('/api/failover/run',{method:'POST',body:{}}); toast(`장애 전환 이동 횟수 ${r.result.moves||0} / returns ${r.result.returns||0}`); await renderFailover(); return true; }
    const failoverToggle=event.target.closest('[data-failover-toggle]');
    if(failoverToggle){await api(`/api/failover/clients/${encodeURIComponent(failoverToggle.dataset.failoverToggle)}`,{method:'POST',body:{enabled:failoverToggle.dataset.enabled==='1'}});toast(`앱 기기 장애 전환 ${failoverToggle.dataset.enabled==='1'?'ON':'OFF'}`);await renderFailover();return true;}
    const failoverReturn=event.target.closest('[data-failover-return]');
    if(failoverReturn){const v=await openModal({title:"기본 서버로 복귀",message:`${failoverReturn.dataset.failoverReturn} 앱 기기를 원래 기본 서버로 복귀시킵니다. 기본가 준비되지 않았으면 실행되지 않습니다.`,confirmLabel:"복귀"});if(!v)return true;await api(`/api/failover/clients/${encodeURIComponent(failoverReturn.dataset.failoverReturn)}/return`,{method:'POST',body:{}});toast("기본 복귀 완료");await renderFailover();return true;}
    const bindingEdit=event.target.closest('[data-binding-edit]');
    if(bindingEdit){
      const c=failoverRows.get(bindingEdit.dataset.bindingEdit); if(!c)throw new Error('CLIENT_NOT_FOUND');
      const serverOptions=failoverServers.map(x=>({value:x.id,label:`${x.alias||x.id} // ${x.status}`}));
      const v=await openModal({title:"기본·예비 서버 배정",message:"평상시에는 기본만 사용하며 장애 시 지정 백업을 우선합니다.",fields:[
        {name:'primary',label:"기본 서버",type:'select',value:c.primaryServerId,options:serverOptions},
        {name:'backup',label:"예비 서버",type:'select',value:c.backupServerId||'',options:[{value:'',label:"없음"},...serverOptions]},
        {name:'fallback',label:"백업 불가 시 자동 선택",type:'select',value:c.allowAutomaticFallback?'1':'0',options:[{value:'0',label:"꺼짐 - 지정 백업만 사용"},{value:'1',label:"켜짐 - 다른 가용 서버 허용"}]}
      ],confirmLabel:"저장 배정"}); if(!v)return true;
      await api(`/api/failover/clients/${encodeURIComponent(c.clientId)}/binding`,{method:'POST',body:{primaryServerId:v.primary,backupServerId:v.backup,allowAutomaticFallback:v.fallback==='1'}});toast("기본·예비 서버 배정 저장");await renderFailover();return true;
    }
    const bindingClear=event.target.closest('[data-binding-clear]');
    if(bindingClear){const v=await openModal({title:"배정 해제",message:"지정한 기본·예비 서버 설정을 제거하고 현재 서버를 기본 바인딩으로 유지합니다.",confirmLabel:"지우기"});if(!v)return true;await api(`/api/failover/clients/${encodeURIComponent(bindingClear.dataset.bindingClear)}/binding/clear`,{method:'POST',body:{}});toast("배정 제거 완료");await renderFailover();return true;}

    if(event.target.id==='queue-policy-save'){
      await api('/api/request-recovery/policy',{method:'POST',body:{enabled:document.getElementById('queue-policy-enabled').value==='1',maxItemsPerClient:Number(document.getElementById('queue-policy-max').value),ttlSeconds:Number(document.getElementById('queue-policy-ttl').value),maxDeliveryAttempts:Number(document.getElementById('queue-policy-attempts').value)}});toast("오프라인 대기열 정책 저장");await renderRecovery();return true;
    }
    const queueToggle=event.target.closest('[data-queue-toggle]');
    if(queueToggle){await api(`/api/request-recovery/clients/${encodeURIComponent(queueToggle.dataset.queueToggle)}`,{method:'POST',body:{enabled:queueToggle.dataset.enabled==='1'}});toast(`앱 기기 대기열 ${queueToggle.dataset.enabled==='1'?'ON':'OFF'}`);await renderRecovery();return true;}
    const dlqRetry=event.target.closest('[data-dlq-retry]');
    if(dlqRetry){const v=await openModal({title:"다시 시도 전송 실패 요청",message:"새 요청 식별자를 생성해 다시 전달합니다. 원본 요청 식별자는 추적 관계로만 보존됩니다.",confirmLabel:"다시 시도"});if(!v)return true;const r=await api(`/api/dead-letters/${encodeURIComponent(dlqRetry.dataset.dlqRetry)}/retry`,{method:'POST',body:{}});toast(`실패 보관함 재전송 ${r.deadLetter.lastReplayRequestId}`);await renderRecovery();return true;}
    const dlqDiscard=event.target.closest('[data-dlq-discard]');
    if(dlqDiscard){const v=await openModal({title:"폐기 전송 실패 요청",message:"이 요청을 폐기 상태로 전환합니다. 감사 기록과 실패 보관함 이력은 유지됩니다.",danger:true,confirmLabel:"폐기"});if(!v)return true;await api(`/api/dead-letters/${encodeURIComponent(dlqDiscard.dataset.dlqDiscard)}/discard`,{method:'POST',body:{}});toast("실패 보관함 폐기 완료");await renderRecovery();return true;}
    if(event.target.id==='recovery-search-btn'){recoveryQuery=document.getElementById('recovery-search').value.trim();await renderRecovery();return true;}

    
  return false;
}
