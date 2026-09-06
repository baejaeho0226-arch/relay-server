'use strict';
async function handleOperationsAction(event) {
    if (event.target.id === 'processor-save-btn') {
      const result = await api('/api/processors/policy', { method: 'POST', body: {
        enabled: document.getElementById('processor-enabled').value === '1',
        processor: document.getElementById('processor-name').value,
        minValue: document.getElementById('processor-min').value.trim(),
        maxValue: document.getElementById('processor-max').value.trim(),
        blockedValues: document.getElementById('processor-blocked').value
      }});
      toast(`처리기 정책 개정 번호 ${result.policy.revision} 배포`); await renderProcessors(); return true;
    }
    if (event.target.id === 'processor-push-btn') {
      const result = await api('/api/processors/push', { method: 'POST', body: {} });
      toast(`${result.pushes.filter(x=>x.ok).length}개 온라인 서버에 재전송`); await renderProcessors(); return true;
    }
    if (event.target.id === 'processor-reset-stats-btn') {
      const v = await openModal({ title: "처리기 통계 초기화", message: "누적 처리기 통계를 0으로 초기화합니다. 일일 보고서 이력은 유지됩니다.", danger: true, confirmLabel: "초기화" });
      if (!v) return true;
      await api('/api/processors/stats/reset', { method: 'POST', body: {} }); toast("처리기 통계 초기화 완료"); await renderProcessors(); return true;
    }
    if (event.target.id === 'push-enable-btn') {
      if (!('Notification' in window)) throw new Error('PUSH_NOT_SUPPORTED');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('NOTIFICATION_PERMISSION_DENIED');
      const { push } = await api('/api/push/status');
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(push.publicKey) });
      await api('/api/push/subscribe', { method: 'POST', body: { subscription } });
      toast("이 브라우저 푸시 알림 구독 완료"); await renderReports(); return true;
    }
    if (event.target.id === 'push-disable-btn') {
      const subscription = await currentPushSubscription();
      if (subscription) {
        await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: subscription.endpoint } });
        await subscription.unsubscribe();
      }
      toast("이 브라우저 푸시 알림 구독 해제"); await renderReports(); return true;
    }
    if (event.target.id === 'push-test-btn') {
      const result = await api('/api/push/test', { method: 'POST', body: {} });
      toast(`테스트 푸시 알림: ${result.sent} 전송됨 / ${result.failed} 실패`); return true;
    }
    if (event.target.id === 'report-generate-btn') {
      const result = await api('/api/reports/daily/generate', { method: 'POST', body: {} });
      toast(`${result.report.date} 일일 상태 보고서 저장`); await renderReports(); return true;
    }
    if (event.target.id === 'terminal-help-btn') { await executeTerminalCommand('help'); await renderTerminal(); return true; }
    if (event.target.id === 'terminal-clear-btn') { terminalLines = []; await renderTerminal(); return true; }
    if (event.target.id === 'danger-service-stop') {
      const v=await openModal({title:"서비스 종료",message:'서버·앱 등록 목록, QR 라이선스, 생체인증, 실행 세션, 기기 배정, 대화와 대기 요청을 정리하고 서비스를 종료합니다. 관리자 로그인·재시작 버튼, 운영 설정·배포 파일, 재설치 차단 기록은 유지됩니다.',danger:true,confirmLabel:"서비스 종료"});
      if(!v)return true; await api('/api/system/service/stop',{method:'POST',body:{}}); toast('서비스가 종료되었습니다.'); resetServiceUi(); switchView('system'); await renderCurrent(); return true;
    }
    if (event.target.id === 'danger-backup-restore') {
      const file=document.getElementById('danger-backup-file').value; const v=await openModal({title:"백업 복원",message:`${file} 로 데이터베이스를 복원합니다. 현재 연결이 재설정될 수 있습니다.`,danger:true,confirmLabel:"복원"}); if(!v)return true;
      const verify=await api(`/api/backups/${encodeURIComponent(file)}/verify`); if(!verify.verification.ok) throw new Error('BACKUP_VERIFY_FAILED');
      await api(`/api/backups/${encodeURIComponent(file)}/restore`,{method:'POST',body:{}}); toast("백업 복원 완료"); await renderDangerZone(); return true;
    }
    if (event.target.id === 'danger-backup-delete') {
      const file=document.getElementById('danger-backup-file').value; const v=await openModal({title:"백업 삭제",message:`${file} 백업 파일을 삭제합니다.`,danger:true,confirmLabel:"삭제"}); if(!v)return true;
      await api(`/api/backups/${encodeURIComponent(file)}/delete`,{method:'POST',body:{}}); toast("백업 삭제 완료"); await renderDangerZone(); return true;
    }
    if (event.target.id === 'danger-version-apply') {
      const protocol=Number(document.getElementById('danger-version-protocol').value), serverVersion=document.getElementById('danger-version-server').value.trim(), clientVersion=document.getElementById('danger-version-client').value.trim();
      const v=await openModal({title:"버전 정책",message:`프로토콜 >= ${protocol} // 서버 >= ${serverVersion} // 앱 기기 >= ${clientVersion} 로 적용합니다. 기준 미달 연결이 종료될 수 있습니다.`,danger:true,confirmLabel:"적용"}); if(!v)return true;
      await api('/api/system/version',{method:'POST',body:{protocol,serverVersion,clientVersion}}); toast("버전 정책 적용 완료"); await renderDangerZone(); return true;
    }
    if (event.target.id === 'danger-license-delete') {
      const keys=document.getElementById('danger-license-keys').value.split(/[\s,;]+/).map(x=>x.trim()).filter(Boolean).slice(0,500); if(!keys.length) throw new Error('NO_KEYS');
      const v=await openModal({title:"일괄 라이선스 삭제",message:`${keys.length}개 라이선스를 삭제합니다.`,danger:true,confirmLabel:"삭제"}); if(!v)return true;
      const r=await api('/api/licenses/bulk',{method:'POST',body:{action:'delete',keys}}); toast(`${r.success}/${r.total} 라이선스 삭제`); await renderDangerZone(); return true;
    }
    if (event.target.id && event.target.id.startsWith('load-preset-')) {
      const name=event.target.id.replace('load-preset-','').toLowerCase(); const presets={smoke:[2,10,1],medium:[10,100,1],heavy:[100,1000,1]}; const v=presets[name]; if(v){document.getElementById('load-servers').value=v[0];document.getElementById('load-clients').value=v[1];document.getElementById('load-requests').value=v[2];} return true;
    }
    if (event.target.id === 'load-command-btn') {
      const body={relayHost:document.getElementById('load-relay-host').value,relayPort:Number(document.getElementById('load-relay-port').value),webUrl:document.getElementById('load-web-url').value,mode:document.getElementById('load-mode').value,servers:Number(document.getElementById('load-servers').value),clients:Number(document.getElementById('load-clients').value),requestsPerClient:Number(document.getElementById('load-requests').value)};
      const r=await api('/api/load-simulator/command',{method:'POST',body}); document.getElementById('load-command-output').textContent=r.command; return true;
    }
    if (event.target.id === 'load-copy-btn') { const t=document.getElementById('load-command-output')?.textContent||''; if(navigator.clipboard) await navigator.clipboard.writeText(t); toast("명령을 복사했습니다."); return true; }
    if (event.target.id === 'storage-schema-btn') { const r=await api('/api/storage/migration/schema'); await openModal({title:`SQLite 데이터 구조 v${r.schema.version}`,html:`<pre class="code-block schema-preview">${esc(r.schema.sql)}</pre>`,confirmLabel:'닫기'}); return true; }
    if (event.target.id === 'storage-export-btn') { const v=await openModal({title:"SQLite 스냅샷 내보내기",message:"현재 SQLite 스냅샷을 데이터 구조·데이터·검증값 형식의 이식 가능한 번들로 내보냅니다.",confirmLabel:"내보내기"}); if(!v)return true; const r=await api('/api/storage/migration/export',{method:'POST',body:{}}); const out=document.getElementById('storage-export-result'); if(out)out.textContent=`${r.directory} // SHA256 ${r.checksum}`; toast("SQLite 스냅샷 묶음 파일 생성 완료"); return true; }

    if (event.target.id === 'release-upload-btn') { await uploadRelease(); return true; }
    const releaseRollout=event.target.closest('[data-release-rollout]');
    if(releaseRollout){
      const cur=await api('/api/releases'); const item=(cur.releases.releases||[]).find(x=>x.type===releaseRollout.dataset.type&&x.channel===releaseRollout.dataset.channel); const v=await openModal({title:"단계별 배포",message:`${releaseRollout.dataset.type}/${releaseRollout.dataset.channel} 배포 비율`,fields:[{name:'percent',label:"배포 비율 %",type:'number',value:String(item?.rolloutPercent??100)}],confirmLabel:"적용"}); if(!v)return true;
      await api('/api/releases/rollout',{method:'POST',body:{type:releaseRollout.dataset.type,channel:releaseRollout.dataset.channel,rolloutPercent:Number(v.percent)}}); toast("단계별 배포 적용"); await renderReleases(); return true;
    }
    const releaseToggle=event.target.closest('[data-release-toggle]');
    if(releaseToggle){ await api('/api/releases/enabled',{method:'POST',body:{type:releaseToggle.dataset.type,channel:releaseToggle.dataset.channel,enabled:releaseToggle.dataset.enabled==='1'}}); toast("배포 상태 변경"); await renderReleases(); return true; }
    const releasePush=event.target.closest('[data-release-push]');
    if(releasePush){ const r=await api('/api/releases/push',{method:'POST',body:{type:releasePush.dataset.type,channel:releasePush.dataset.channel}}); toast(`업데이트 확인 알림 전송됨: ${(r.results||[]).filter(x=>x.available).length}`); return true; }
    const releaseDevicePush=event.target.closest('[data-release-device-push]');
    if(releaseDevicePush){ const r=await api('/api/releases/push',{method:'POST',body:{type:releaseDevicePush.dataset.type,id:releaseDevicePush.dataset.id}}); toast(r.result?.available?'UPDATE_AVAILABLE 전송':'대상 업데이트 없음'); return true; }

    
  return false;
}
