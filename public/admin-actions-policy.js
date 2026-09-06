'use strict';
async function handlePolicyAction(event) {
    if (event.target.id === 'feature-global-save') {
      const flags = {};
      document.querySelectorAll('[data-global-flag]').forEach(el => flags[el.dataset.globalFlag] = el.value === 'ON');
      await api('/api/control/features/global', { method: 'POST', body: { flags } });
      toast("전체 기능 설정 저장"); await renderFeatureFlags(); return true;
    }
    if (event.target.id === 'feature-device-save') {
      const btn=event.target, flags={};
      document.querySelectorAll('[data-flag-name]').forEach(el => { if(el.value==='ON') flags[el.dataset.flagName]=true; else if(el.value==='OFF') flags[el.dataset.flagName]=false; });
      await api('/api/control/features/device', { method:'POST', body:{ type:btn.dataset.type, id:btn.dataset.id, flags } });
      toast("기기 기기별 기능 설정 저장"); await renderFeatureFlags(); return true;
    }
    if (event.target.id === 'feature-device-clear') {
      const btn=event.target;
      await api('/api/control/features/device', { method:'POST', body:{ type:btn.dataset.type, id:btn.dataset.id, flags:{} } });
      toast("기기 기기별 기능 설정 초기화"); await renderFeatureFlags(); return true;
    }
    const securityChallenge = event.target.closest('[data-security-challenge]');
    if (securityChallenge) {
      await api('/api/control/security/challenge', { method:'POST', body:{ type:securityChallenge.dataset.type, id:securityChallenge.dataset.id } });
      toast("HMAC 인증 확인 요청 전송"); setTimeout(()=>renderProtocolSecurity(),350); return true;
    }
    const configRollback = event.target.closest('[data-config-rollback]');
    if (configRollback) {
      const v=await openModal({title:"설정 되돌리기",message:"선택한 설정 스냅샷을 새 개정 번호로 복원하고 온라인 기기에 즉시 동기화합니다.",danger:true,confirmLabel:"되돌리기"}); if(!v)return true;
      const r=await api('/api/control/config-history/rollback',{method:'POST',body:{id:configRollback.dataset.configRollback}}); toast(`되돌리기 완료 → 개정 번호 ${r.currentRevision}`); await renderConfigHistory(); return true;
    }
    if (event.target.id === 'enrollment-policy-btn') {
      const { enrollment:e }=await api('/api/enrollment'); const enabled=!e.policy.enabled;
      const v=await openModal({title:"새 기기 승인 정책",message:enabled?"새 기기 키를 승인 전 대기 중으로 전환합니다. 기존 등록 기기는 영향 없습니다.":"새 기기 자동 등록을 다시 허용합니다.",danger:enabled,confirmLabel:enabled?"활성화":"비활성화"});if(!v)return true;
      await api('/api/enrollment/policy',{method:'POST',body:{enabled}});toast(`기기 등록 ${enabled?'ON':'OFF'}`);await renderEnrollment();return true;
    }
    const enrollDecision=event.target.closest('[data-enroll-decision]');
    if(enrollDecision){await api('/api/enrollment/decision',{method:'POST',body:{requestId:enrollDecision.dataset.requestId,status:enrollDecision.dataset.enrollDecision}});toast(`기기 등록 ${enrollDecision.dataset.enrollDecision}`);await renderEnrollment();return true;}
    const enrollReset=event.target.closest('[data-enroll-reset]');
    if(enrollReset){await api('/api/enrollment/reset',{method:'POST',body:{requestId:enrollReset.dataset.enrollReset}});toast("기기 등록 기록 초기화");await renderEnrollment();return true;}
    const securityRotate = event.target.closest('[data-security-rotate]');
    if (securityRotate) {
      const v=await openModal({title:"접속을 유지하는 인증키 교체",message:`${securityRotate.dataset.type} ${securityRotate.dataset.id}의 현재 인증키에서 새 인증키을 파생하고 2단계 Commit합니다. 인증키 원문은 네트워크로 다시 보내지 않습니다.`,danger:true,confirmLabel:"인증키 교체"});if(!v)return true;
      const r=await api('/api/control/security/rotate',{method:'POST',body:{type:securityRotate.dataset.type,id:securityRotate.dataset.id}});toast(`인증키 교체 ${r.rotation.rotationId} 시작`);setTimeout(()=>renderProtocolSecurity(),350);return true;
    }
    const securityReset = event.target.closest('[data-security-reset]');
    if (securityReset) {
      const v=await openModal({title:"재등록 기기 인증키",message:`${securityReset.dataset.type} ${securityReset.dataset.id}의 기존 인증키을 폐기하고 새 인증키을 다시 등록합니다. 연결 장애 복구용입니다.`,danger:true,confirmLabel:"재등록"}); if(!v)return true;
      await api('/api/control/security/reset', { method:'POST', body:{ type:securityReset.dataset.type, id:securityReset.dataset.id } });
      toast("기기 인증키 재등록 시작"); setTimeout(()=>renderProtocolSecurity(),350); return true;
    }

    const networkTrust=event.target.closest('[data-network-trust]');
    if(networkTrust){
      const v=await openModal({title:"현재 네트워크 신뢰",message:`${networkTrust.dataset.type} ${networkTrust.dataset.id}의 현재 IP / 서브넷 / 국가를 새 기준점으로 승인합니다. 과거 감사 기록은 유지됩니다.`,confirmLabel:"신뢰"}); if(!v)return true;
      await api('/api/security/network/trust',{method:'POST',body:{type:networkTrust.dataset.type,id:networkTrust.dataset.id}});
      toast("현재 네트워크를 신뢰하도록 저장했습니다."); await renderSecurityCenter(); return true;
    }

    
  return false;
}
