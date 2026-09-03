'use strict';

// EVENTS / ACTIONS / STARTUP

function openModal(options) {
  return new Promise(resolve => {
    modalTitle.textContent = options.title || '확인';
    const fields = options.fields || [];
    modalBody.innerHTML = `${options.message ? `<p>${esc(options.message)}</p>` : ''}${options.html || ''}${fields.map(f => {
      if (f.type === 'textarea') return `<label>${esc(f.label)}<textarea data-modal-field="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea></label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select data-modal-field="${esc(f.name)}">${(f.options || []).map(o => `<option value="${esc(o.value ?? o)}" ${String(o.value ?? o)===String(f.value ?? '')?'selected':''}>${esc(o.label ?? o)}</option>`).join('')}</select></label>`;
      if (f.type === 'password') return `<label>${esc(f.label)}<div class="password-input-row"><input data-modal-field="${esc(f.name)}" type="password" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" inputmode="${esc(f.inputmode || 'numeric')}" autocomplete="new-password" maxlength="${Number(f.maxLength || 8)}"><button type="button" data-modal-reveal="${esc(f.name)}">보기</button></div></label>`;
      return `<label>${esc(f.label)}<input data-modal-field="${esc(f.name)}" type="${esc(f.type || 'text')}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"></label>`;
    }).join('')}`;
    modalConfirm.textContent = options.confirmLabel || '확인';
    modalConfirm.className = options.danger ? 'danger' : 'primary';
    modalEl.classList.remove('hidden');
    modalEl.setAttribute('aria-hidden', 'false');

    const close = value => {
      modalEl.classList.add('hidden');
      modalEl.setAttribute('aria-hidden', 'true');
      modalConfirm.onclick = null;
      modalCancel.onclick = null;
      modalBody.onclick = null;
      modalEl.querySelectorAll('[data-modal-close]').forEach(x => x.onclick = null);
      resolve(value);
    };
    modalCancel.onclick = () => close(null);
    modalEl.querySelectorAll('[data-modal-close]').forEach(x => x.onclick = () => close(null));
    modalBody.onclick = event => {
      const reveal = event.target.closest('[data-modal-reveal]');
      if (!reveal) return;
      const input = modalBody.querySelector(`[data-modal-field="${CSS.escape(reveal.dataset.modalReveal)}"]`);
      if (!input) return;
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      reveal.textContent = visible ? '보기' : '숨기기';
      input.focus();
    };
    modalConfirm.onclick = () => {
      const values = {};
      modalBody.querySelectorAll('[data-modal-field]').forEach(el => values[el.dataset.modalField] = el.value);
      close(values);
    };
    const first = modalBody.querySelector('input,textarea,select');
    if (first) setTimeout(() => first.focus(), 20);
  });
}

content.addEventListener('click', async event => {
  try {
    const openViewBtn = event.target.closest('[data-open-view]');
    if (openViewBtn) { switchView(openViewBtn.dataset.openView); await renderCurrent(); return; }
    const restoreDeleted = event.target.closest('[data-deleted-device-restore]');
    if (restoreDeleted) {
      const tombstoneId = restoreDeleted.dataset.deletedDeviceRestore;
      const type = restoreDeleted.dataset.deviceType || 'DEVICE';
      const v = await openModal({ title: `${type} Restore`, message: '삭제 차단을 해제합니다. 실행 중인 프로그램은 다음 재접속 때 신규 장치로 등록되며, CLIENT는 새 QR 승인이 필요합니다.', danger: true, confirmLabel: 'RESTORE' });
      if (!v) return;
      await api(`/api/deleted-devices/${encodeURIComponent(tombstoneId)}/restore`, { method: 'POST', body: {} });
      toast(`${type} 재등록 허용 완료`);
      await renderCurrent();
      return;
    }
    if (event.target.id === 'pairing-repair-btn') {
      const v = await openModal({ title: '1:1 Matching Repair', message: '존재하지 않는 SERVER 바인딩과 중복 배정을 정리합니다. 미배정 APK의 PC 선택은 QR 승인에서만 이루어지며 연결 순서로 자동 배정하지 않습니다.', confirmLabel: 'REPAIR' });
      if (!v) return;
      const r = await api('/api/pairing/repair', { method: 'POST', body: {} });
      toast(`1:1 복구 완료 · orphan ${r.repair.orphaned} · duplicate ${r.repair.duplicate} · assigned ${r.repair.assigned}`);
      await renderCurrent();
      return;
    }
    const historyClean = event.target.closest('[data-history-clean]');
    if (historyClean) {
      const scope = historyClean.dataset.historyClean;
      const v = await openModal({ title: 'History Clean', message: `${scope} 종료 이력을 정리합니다. 진행 중인 요청, 활성 Build 세션, 대기 QR 및 ACTIVE DLQ는 보존됩니다.`, danger: true, confirmLabel: 'CLEAN' });
      if (!v) return;
      await api('/api/history/clean', { method: 'POST', body: { scope } });
      toast(`${scope} CLEAN 완료`);
      await renderCurrent();
      return;
    }
    if (event.target.id === 'qr-auth-scan-btn') {
      const file = qrSelectedFile;
      if (!file) throw new Error('QR 사진을 먼저 선택하세요.');
      if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('PNG 또는 JPEG 사진만 사용할 수 있습니다.');
      const scanButton = event.target;
      const maxBytes = Number(scanButton.dataset.maxBytes || 8 * 1024 * 1024);
      if (file.size > maxBytes) throw new Error(`QR 사진은 ${fmtBytes(maxBytes)} 이하여야 합니다.`);
      scanButton.disabled = true;
      scanButton.textContent = '검증 중...';
      try {
        const imageData = await fileAsDataUrl(file);
        qrScanResult = await api('/api/qr-auth/scan', { method: 'POST', body: { imageData } });
        toast(`${qrScanResult.request.clientId} 서명 검증 완료`);
        await renderQrAuth();
      } finally {
        if (document.body.contains(scanButton)) {
          scanButton.disabled = false;
          scanButton.textContent = '서버에서 QR 검증';
        }
      }
      return;
    }
    if (event.target.id === 'qr-auth-approve-btn') {
      if (!qrScanResult || !qrScanResult.request || !qrScanResult.approvalToken) throw new Error('검증된 QR 요청이 없습니다.');
      const pairableServers = (qrScanResult.pairingServers || []).filter(x => x.eligible || x.current || x.occupiedBy === qrScanResult.request.clientId);
      const preferredServer = pairableServers.find(x => x.current || x.occupiedBy === qrScanResult.request.clientId) || pairableServers[0] || null;
      const fields = [];
      if (preferredServer) fields.push({ name: 'serverId', label: '1:1 대상 PC', type: 'select', value: preferredServer.id, options: pairableServers.map(x => ({ value: x.id, label: `${x.alias || x.id} · ${x.id}${x.current || x.occupiedBy === qrScanResult.request.clientId ? ' · 현재 연결' : ''}` })) });
      fields.push(
        { name: 'days', label: '사용 기간(일)', type: 'number', value: String(qrScanResult.defaultDays || 30) },
        { name: 'accessType', label: 'APK 전용 콘텐츠', type: 'select', value: 'TYPE1', options: [{ value: 'TYPE1', label: 'TalesRunner' }, { value: 'TYPE2', label: 'R2Beat' }, { value: 'TYPE3', label: 'Lostsaga' }] },
        { name: 'memo', label: '메모', value: `QR 승인 ${qrScanResult.request.clientId}` },
        { name: 'tags', label: '태그', value: 'QR', placeholder: 'QR, CUSTOMER-A' }
      );
      const values = await openModal({
        title: 'QR 기기 승인',
        message: preferredServer
          ? `${qrScanResult.request.clientId}\n선택한 PC와 1:1로 고정합니다.`
          : `${qrScanResult.request.clientId}\nWinSockServer가 아직 없어도 승인됩니다. PC가 연결되면 Relay가 빈 서버 한 대와 1:1로 결합합니다.`,
        fields,
        confirmLabel: '승인'
      });
      if (!values) return;
      const result = await api('/api/qr-auth/approve', { method: 'POST', body: {
        requestId: qrScanResult.request.requestId,
        approvalToken: qrScanResult.approvalToken,
        serverId: values.serverId || '',
        days: Number(values.days),
        accessType: values.accessType,
        memo: values.memo,
        tags: String(values.tags || '').split(',').map(x => x.trim()).filter(Boolean)
      }});
      qrScanResult = null;
      clearQrSelectedFile();
      toast(result.pairing?.status === 'DEFERRED' ? '승인 완료 · WinSockServer 연결 대기' : (result.delivered ? '승인 완료 · APK 즉시 인증됨' : '승인 완료 · APK 재접속 시 자동 인증'));
      await updateQrAuthBadge();
      await renderQrAuth();
      return;
    }
    if (event.target.id === 'qr-auth-clear-btn') {
      qrScanResult = null;
      clearQrSelectedFile();
      await renderQrAuth();
      return;
    }
    const qrReject = event.target.closest('[data-qr-reject]');
    if (qrReject) {
      const values = await openModal({ title: 'QR 인증 거절', message: `${qrReject.dataset.qrReject}\n해당 QR은 즉시 재사용할 수 없게 됩니다.`, fields: [{ name: 'reason', label: '거절 사유', value: 'ADMIN_REJECTED' }], danger: true, confirmLabel: '거절' });
      if (!values) return;
      await api('/api/qr-auth/reject', { method: 'POST', body: { requestId: qrReject.dataset.qrReject, reason: values.reason } });
      if (qrScanResult && qrScanResult.request.requestId === qrReject.dataset.qrReject) {
        qrScanResult = null;
        clearQrSelectedFile();
      }
      toast('QR 인증 요청 거절 완료');
      await updateQrAuthBadge();
      await renderQrAuth();
      return;
    }
    if (event.target.id === 'build-session-policy-save') {
      const ttlMinutes = Number(document.getElementById('build-session-ttl').value);
      await api('/api/build-sessions/policy', { method: 'POST', body: { ttlMinutes } });
      toast(`Build Session TTL ${ttlMinutes}분 저장`);
      await renderBuildSessions();
      return;
    }
    const buildRevoke = event.target.closest('[data-build-revoke]');
    if (buildRevoke) {
      const values = await openModal({
        title: 'Build Session 즉시 해제',
        message: `${buildRevoke.dataset.buildRevoke}\nAPK와 WinSockServer가 즉시 다시 잠기며 Build를 다시 수행해야 합니다.`,
        fields: [{ name: 'reason', label: '해제 사유', value: 'ADMIN_REVOKE' }],
        danger: true,
        confirmLabel: 'REVOKE NOW'
      });
      if (!values) return;
      await api(`/api/build-sessions/${encodeURIComponent(buildRevoke.dataset.buildRevoke)}/revoke`, { method: 'POST', body: { reason: values.reason } });
      toast('Build Session 해제 완료');
      await renderBuildSessions();
      return;
    }
    const buildRebind = event.target.closest('[data-build-rebind]');
    if (buildRebind) {
      const options = buildSessionServers.map(server => server.id);
      if (!options.length) throw new Error('등록된 WinSockServer가 없습니다.');
      const current = options.includes(buildRebind.dataset.currentServer) ? buildRebind.dataset.currentServer : options[0];
      const values = await openModal({
        title: 'APK ↔ WinSockServer Rebind',
        message: `${buildRebind.dataset.buildRebind}\n기존 활성 Build Session은 즉시 해제됩니다. 다른 Server를 선택하면 Client도 해당 Server로 안전하게 이동합니다.`,
        fields: [{ name: 'serverId', label: '새 WinSockServer', type: 'select', value: current, options }],
        danger: true,
        confirmLabel: 'REBIND'
      });
      if (!values) return;
      await api(`/api/build-bindings/${encodeURIComponent(buildRebind.dataset.buildRebind)}/rebind`, { method: 'POST', body: { serverId: values.serverId } });
      toast('Build 고정 바인딩 변경 완료');
      await renderBuildSessions();
      return;
    }
    if (event.target.id === 'processor-save-btn') {
      const result = await api('/api/processors/policy', { method: 'POST', body: {
        enabled: document.getElementById('processor-enabled').value === '1',
        processor: document.getElementById('processor-name').value,
        minValue: document.getElementById('processor-min').value.trim(),
        maxValue: document.getElementById('processor-max').value.trim(),
        blockedValues: document.getElementById('processor-blocked').value
      }});
      toast(`Processor Policy revision ${result.policy.revision} 배포`); await renderProcessors(); return;
    }
    if (event.target.id === 'processor-push-btn') {
      const result = await api('/api/processors/push', { method: 'POST', body: {} });
      toast(`${result.pushes.filter(x=>x.ok).length}개 ONLINE Server에 재전송`); await renderProcessors(); return;
    }
    if (event.target.id === 'processor-reset-stats-btn') {
      const v = await openModal({ title: 'Processor Statistics Reset', message: '누적 Processor 통계를 0으로 초기화합니다. Daily Report 이력은 유지됩니다.', danger: true, confirmLabel: 'RESET' });
      if (!v) return;
      await api('/api/processors/stats/reset', { method: 'POST', body: {} }); toast('Processor 통계 초기화 완료'); await renderProcessors(); return;
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
      toast('이 브라우저 Push 구독 완료'); await renderReports(); return;
    }
    if (event.target.id === 'push-disable-btn') {
      const subscription = await currentPushSubscription();
      if (subscription) {
        await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: subscription.endpoint } });
        await subscription.unsubscribe();
      }
      toast('이 브라우저 Push 구독 해제'); await renderReports(); return;
    }
    if (event.target.id === 'push-test-btn') {
      const result = await api('/api/push/test', { method: 'POST', body: {} });
      toast(`Test Push: ${result.sent} sent / ${result.failed} failed`); return;
    }
    if (event.target.id === 'report-generate-btn') {
      const result = await api('/api/reports/daily/generate', { method: 'POST', body: {} });
      toast(`${result.report.date} Daily Health 저장`); await renderReports(); return;
    }
    if (event.target.id === 'terminal-help-btn') { await executeTerminalCommand('help'); await renderTerminal(); return; }
    if (event.target.id === 'terminal-clear-btn') { terminalLines = []; await renderTerminal(); return; }
    if (event.target.id === 'danger-service-stop') {
      const v=await openModal({title:'Service Stop',message:'모든 Client 인증을 해제하고 Relay 서비스를 중지합니다.',danger:true,confirmLabel:'STOP SERVICE'});
      if(!v)return; await api('/api/system/service/stop',{method:'POST',body:{}}); toast('Service OFFLINE'); await renderDangerZone(); return;
    }
    if (event.target.id === 'danger-backup-restore') {
      const file=document.getElementById('danger-backup-file').value; const v=await openModal({title:'Backup Restore',message:`${file} 로 DB를 복원합니다. 현재 연결이 재설정될 수 있습니다.`,danger:true,confirmLabel:'RESTORE'}); if(!v)return;
      const verify=await api(`/api/backups/${encodeURIComponent(file)}/verify`); if(!verify.verification.ok) throw new Error('BACKUP_VERIFY_FAILED');
      await api(`/api/backups/${encodeURIComponent(file)}/restore`,{method:'POST',body:{}}); toast('Backup Restore 완료'); await renderDangerZone(); return;
    }
    if (event.target.id === 'danger-backup-delete') {
      const file=document.getElementById('danger-backup-file').value; const v=await openModal({title:'Backup Delete',message:`${file} 백업 파일을 삭제합니다.`,danger:true,confirmLabel:'DELETE'}); if(!v)return;
      await api(`/api/backups/${encodeURIComponent(file)}/delete`,{method:'POST',body:{}}); toast('Backup Delete 완료'); await renderDangerZone(); return;
    }
    if (event.target.id === 'danger-version-apply') {
      const protocol=Number(document.getElementById('danger-version-protocol').value), serverVersion=document.getElementById('danger-version-server').value.trim(), clientVersion=document.getElementById('danger-version-client').value.trim();
      const v=await openModal({title:'Version Policy',message:`Protocol >= ${protocol} // Server >= ${serverVersion} // Client >= ${clientVersion} 로 적용합니다. 기준 미달 연결이 종료될 수 있습니다.`,danger:true,confirmLabel:'APPLY'}); if(!v)return;
      await api('/api/system/version',{method:'POST',body:{protocol,serverVersion,clientVersion}}); toast('Version Policy 적용 완료'); await renderDangerZone(); return;
    }
    if (event.target.id === 'danger-license-delete') {
      const keys=document.getElementById('danger-license-keys').value.split(/[\s,;]+/).map(x=>x.trim()).filter(Boolean).slice(0,500); if(!keys.length) throw new Error('NO_KEYS');
      const v=await openModal({title:'Bulk License Delete',message:`${keys.length}개 License를 삭제합니다.`,danger:true,confirmLabel:'DELETE'}); if(!v)return;
      const r=await api('/api/licenses/bulk',{method:'POST',body:{action:'delete',keys}}); toast(`${r.success}/${r.total} License 삭제`); await renderDangerZone(); return;
    }
    if (event.target.id && event.target.id.startsWith('load-preset-')) {
      const name=event.target.id.replace('load-preset-','').toLowerCase(); const presets={smoke:[2,10,1],medium:[10,100,1],heavy:[100,1000,1]}; const v=presets[name]; if(v){document.getElementById('load-servers').value=v[0];document.getElementById('load-clients').value=v[1];document.getElementById('load-requests').value=v[2];} return;
    }
    if (event.target.id === 'load-command-btn') {
      const body={relayHost:document.getElementById('load-relay-host').value,relayPort:Number(document.getElementById('load-relay-port').value),webUrl:document.getElementById('load-web-url').value,mode:document.getElementById('load-mode').value,servers:Number(document.getElementById('load-servers').value),clients:Number(document.getElementById('load-clients').value),requestsPerClient:Number(document.getElementById('load-requests').value)};
      const r=await api('/api/load-simulator/command',{method:'POST',body}); document.getElementById('load-command-output').textContent=r.command; return;
    }
    if (event.target.id === 'load-copy-btn') { const t=document.getElementById('load-command-output')?.textContent||''; if(navigator.clipboard) await navigator.clipboard.writeText(t); toast('Command copied'); return; }
    if (event.target.id === 'storage-schema-btn') { const r=await api('/api/storage/migration/schema'); await openModal({title:`SQLite Schema v${r.schema.version}`,html:`<pre class="code-block schema-preview">${esc(r.schema.sql)}</pre>`,confirmLabel:'닫기'}); return; }
    if (event.target.id === 'storage-export-btn') { const v=await openModal({title:'Export SQLite Snapshot Bundle',message:'현재 SQLite 스냅샷을 schema/data/checksum 형식의 이식 가능한 번들로 내보냅니다.',confirmLabel:'EXPORT'}); if(!v)return; const r=await api('/api/storage/migration/export',{method:'POST',body:{}}); const out=document.getElementById('storage-export-result'); if(out)out.textContent=`${r.directory} // SHA256 ${r.checksum}`; toast('SQLite Snapshot Bundle 생성 완료'); return; }

    if (event.target.id === 'release-upload-btn') { await uploadRelease(); return; }
    const releaseRollout=event.target.closest('[data-release-rollout]');
    if(releaseRollout){
      const cur=await api('/api/releases'); const item=(cur.releases.releases||[]).find(x=>x.type===releaseRollout.dataset.type&&x.channel===releaseRollout.dataset.channel); const v=await openModal({title:'Canary Rollout',message:`${releaseRollout.dataset.type}/${releaseRollout.dataset.channel} 배포 비율`,fields:[{name:'percent',label:'Rollout %',type:'number',value:String(item?.rolloutPercent??100)}],confirmLabel:'APPLY'}); if(!v)return;
      await api('/api/releases/rollout',{method:'POST',body:{type:releaseRollout.dataset.type,channel:releaseRollout.dataset.channel,rolloutPercent:Number(v.percent)}}); toast('Canary rollout 적용'); await renderReleases(); return;
    }
    const releaseToggle=event.target.closest('[data-release-toggle]');
    if(releaseToggle){ await api('/api/releases/enabled',{method:'POST',body:{type:releaseToggle.dataset.type,channel:releaseToggle.dataset.channel,enabled:releaseToggle.dataset.enabled==='1'}}); toast('Release 상태 변경'); await renderReleases(); return; }
    const releasePush=event.target.closest('[data-release-push]');
    if(releasePush){ const r=await api('/api/releases/push',{method:'POST',body:{}}); toast(`Update check pushed: ${(r.results||[]).filter(x=>x.available).length}`); return; }
    const releaseDevicePush=event.target.closest('[data-release-device-push]');
    if(releaseDevicePush){ const r=await api('/api/releases/push',{method:'POST',body:{type:releaseDevicePush.dataset.type,id:releaseDevicePush.dataset.id}}); toast(r.result?.available?'UPDATE_AVAILABLE 전송':'대상 업데이트 없음'); return; }

    if (event.target.id === 'failover-policy-save') {
      const body={
        enabled:document.getElementById('failover-policy-enabled').value==='1',
        autoReturn:document.getElementById('failover-auto-return').value==='1',
        offlineGraceSeconds:Number(document.getElementById('failover-offline-grace').value),
        returnGraceSeconds:Number(document.getElementById('failover-return-grace').value),
        maxMovesPerCycle:Number(document.getElementById('failover-max-moves').value)
      };
      await api('/api/failover/policy',{method:'POST',body}); toast('Emergency Failover Policy 저장'); await renderFailover(); return;
    }
    if (event.target.id === 'failover-run-now') { const r=await api('/api/failover/run',{method:'POST',body:{}}); toast(`Failover moves ${r.result.moves||0} / returns ${r.result.returns||0}`); await renderFailover(); return; }
    const failoverToggle=event.target.closest('[data-failover-toggle]');
    if(failoverToggle){await api(`/api/failover/clients/${encodeURIComponent(failoverToggle.dataset.failoverToggle)}`,{method:'POST',body:{enabled:failoverToggle.dataset.enabled==='1'}});toast(`Client Failover ${failoverToggle.dataset.enabled==='1'?'ON':'OFF'}`);await renderFailover();return;}
    const failoverReturn=event.target.closest('[data-failover-return]');
    if(failoverReturn){const v=await openModal({title:'Return to Primary',message:`${failoverReturn.dataset.failoverReturn} Client를 원래 Primary Server로 복귀시킵니다. Primary가 준비되지 않았으면 실행되지 않습니다.`,confirmLabel:'RETURN'});if(!v)return;await api(`/api/failover/clients/${encodeURIComponent(failoverReturn.dataset.failoverReturn)}/return`,{method:'POST',body:{}});toast('Primary 복귀 완료');await renderFailover();return;}
    const bindingEdit=event.target.closest('[data-binding-edit]');
    if(bindingEdit){
      const c=failoverRows.get(bindingEdit.dataset.bindingEdit); if(!c)throw new Error('CLIENT_NOT_FOUND');
      const serverOptions=failoverServers.map(x=>({value:x.id,label:`${x.alias||x.id} // ${x.status}`}));
      const v=await openModal({title:'Primary / Backup Binding',message:'평상시에는 Primary만 사용하며 장애 시 지정 Backup을 우선합니다.',fields:[
        {name:'primary',label:'Primary Server',type:'select',value:c.primaryServerId,options:serverOptions},
        {name:'backup',label:'Backup Server',type:'select',value:c.backupServerId||'',options:[{value:'',label:'NONE'},...serverOptions]},
        {name:'fallback',label:'Backup 불가 시 자동 선택',type:'select',value:c.allowAutomaticFallback?'1':'0',options:[{value:'0',label:'OFF - 지정 Backup만 사용'},{value:'1',label:'ON - 다른 가용 Server 허용'}]}
      ],confirmLabel:'SAVE BINDING'}); if(!v)return;
      await api(`/api/failover/clients/${encodeURIComponent(c.clientId)}/binding`,{method:'POST',body:{primaryServerId:v.primary,backupServerId:v.backup,allowAutomaticFallback:v.fallback==='1'}});toast('Primary / Backup Binding 저장');await renderFailover();return;
    }
    const bindingClear=event.target.closest('[data-binding-clear]');
    if(bindingClear){const v=await openModal({title:'Clear Binding',message:'명시적 Primary / Backup 설정을 제거하고 현재 Server를 기본 바인딩으로 유지합니다.',confirmLabel:'CLEAR'});if(!v)return;await api(`/api/failover/clients/${encodeURIComponent(bindingClear.dataset.bindingClear)}/binding/clear`,{method:'POST',body:{}});toast('Binding 제거 완료');await renderFailover();return;}

    if(event.target.id==='queue-policy-save'){
      await api('/api/request-recovery/policy',{method:'POST',body:{enabled:document.getElementById('queue-policy-enabled').value==='1',maxItemsPerClient:Number(document.getElementById('queue-policy-max').value),ttlSeconds:Number(document.getElementById('queue-policy-ttl').value),maxDeliveryAttempts:Number(document.getElementById('queue-policy-attempts').value)}});toast('Offline Queue Policy 저장');await renderRecovery();return;
    }
    const queueToggle=event.target.closest('[data-queue-toggle]');
    if(queueToggle){await api(`/api/request-recovery/clients/${encodeURIComponent(queueToggle.dataset.queueToggle)}`,{method:'POST',body:{enabled:queueToggle.dataset.enabled==='1'}});toast(`Client Queue ${queueToggle.dataset.enabled==='1'?'ON':'OFF'}`);await renderRecovery();return;}
    const dlqRetry=event.target.closest('[data-dlq-retry]');
    if(dlqRetry){const v=await openModal({title:'Retry Dead Letter',message:'새 Request ID를 생성해 다시 전달합니다. 원본 Request ID는 추적 관계로만 보존됩니다.',confirmLabel:'RETRY'});if(!v)return;const r=await api(`/api/dead-letters/${encodeURIComponent(dlqRetry.dataset.dlqRetry)}/retry`,{method:'POST',body:{}});toast(`DLQ Replay ${r.deadLetter.lastReplayRequestId}`);await renderRecovery();return;}
    const dlqDiscard=event.target.closest('[data-dlq-discard]');
    if(dlqDiscard){const v=await openModal({title:'Discard Dead Letter',message:'이 요청을 폐기 상태로 전환합니다. Audit과 DLQ 이력은 유지됩니다.',danger:true,confirmLabel:'DISCARD'});if(!v)return;await api(`/api/dead-letters/${encodeURIComponent(dlqDiscard.dataset.dlqDiscard)}/discard`,{method:'POST',body:{}});toast('DLQ 폐기 완료');await renderRecovery();return;}
    if(event.target.id==='recovery-search-btn'){recoveryQuery=document.getElementById('recovery-search').value.trim();await renderRecovery();return;}

    const serverBtn = event.target.closest('[data-server-action]');
    if (serverBtn) { await serverAction(serverBtn.dataset.serverAction, serverBtn.dataset.id); return; }
    const clientBtn = event.target.closest('[data-client-action]');
    if (clientBtn) { await clientAction(clientBtn.dataset.clientAction, clientBtn.dataset.id); return; }
    const licBtn = event.target.closest('[data-license-action]');
    if (licBtn) { await licenseAction(licBtn.dataset.licenseAction, licBtn.dataset.key); return; }
    const backupBtn = event.target.closest('[data-backup-action]');
    if (backupBtn) { await backupAction(backupBtn.dataset.backupAction, backupBtn.dataset.file); return; }
    const statsBtn = event.target.closest('[data-stats-range]');
    if (statsBtn) { statsRange = statsBtn.dataset.statsRange || '1H'; await renderDashboard(); return; }
    if (event.target.id === 'integrity-run-btn') { await renderSystemHealth(); toast('Database Integrity 검사 완료'); return; }

    const expiryBtn = event.target.closest('[data-license-expiry]');
    if (expiryBtn) {
      licenseExpiry = expiryBtn.dataset.licenseExpiry || 'ALL';
      licenseStatus = licenseExpiry === 'EXPIRED' ? 'EXPIRED' : 'ALL';
      currentView = 'licenses';
      nav.querySelectorAll('button[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === 'licenses'));
      renderCurrent();
      return;
    }
    const notificationReadBtn = event.target.closest('[data-notification-read]');
    if (notificationReadBtn) {
      await api(`/api/notifications/${encodeURIComponent(notificationReadBtn.dataset.notificationRead)}/read`, { method: 'POST', body: { read: true } });
      await updateNotificationBadge();
      await renderNotifications();
      return;
    }

    if (event.target.id === 'activity-search-btn') { activityQuery = document.getElementById('activity-search').value.trim(); renderActivity(); return; }
    const sessionRevokeBtn = event.target.closest('[data-session-revoke]');
    if (sessionRevokeBtn) {
      const v = await openModal({ title: 'Session Terminate', message: `${sessionRevokeBtn.dataset.sessionRevoke} 세션을 강제 종료합니다.`, danger: true, confirmLabel: 'Terminate' });
      if (!v) return;
      await api(`/api/sessions/${encodeURIComponent(sessionRevokeBtn.dataset.sessionRevoke)}/revoke`, { method: 'POST', body: {} });
      toast('Session 종료 완료'); renderSessions(); return;
    }
    if (event.target.id === 'session-revoke-others-btn') {
      const v = await openModal({ title: 'Other Sessions', message: '현재 브라우저를 제외한 모든 Web Admin 세션을 종료합니다.', danger: true, confirmLabel: '종료' });
      if (!v) return;
      const r = await api('/api/sessions/revoke-others', { method: 'POST', body: {} }); toast(`${r.count}개 세션 종료`); renderSessions(); return;
    }
    if (event.target.id === 'session-revoke-all-btn') {
      const v = await openModal({ title: 'ALL Sessions', message: '현재 세션을 포함한 모든 Web Admin 세션을 종료합니다.', danger: true, confirmLabel: '전체 종료' });
      if (!v) return;
      await api('/api/sessions/revoke-all', { method: 'POST', body: {} }); showLogin(); return;
    }

    if (event.target.id === 'console-pause-btn') { consolePaused = !consolePaused; renderConsole(); return; }
    if (event.target.id === 'console-clear-btn') { liveConsoleEvents = []; consoleHistoryLoaded = true; renderConsole(); return; }
    if (event.target.id === 'trace-search-btn') { traceQuery = document.getElementById('trace-search').value.trim(); renderTrace(); return; }
    const traceBtn = event.target.closest('[data-trace-detail]');
    if (traceBtn) {
      const t = traceRows.get(traceBtn.dataset.traceDetail);
      if (t) await openModal({ title: `Trace ${t.requestId}`, html: `<div class="kv"><div>Status</div><div>${badge(t.status)}</div><div>Source</div><div>${esc(t.source||'CLIENT')}</div><div>Replay Of</div><div class="code">${esc(t.replayOf||'-')}</div><div>DLQ</div><div class="code">${esc(t.deadLetterId||'-')}</div><div>Client</div><div class="code">${esc(t.clientId)}</div><div>Server</div><div class="code">${esc(t.serverId)}</div><div>Number</div><div class="code">${esc(t.number)}</div><div>Queued</div><div>${esc(fmtTime(t.queuedAt))}</div><div>Forwarded</div><div>${esc(fmtTime(t.forwardedAt))}</div><div>ACK / Complete</div><div>${esc(fmtTime(t.completedAt))}</div><div>Duration</div><div>${t.completedAt ? `${t.durationMs} ms` : '-'}</div><div>Retries</div><div>${t.retries}</div><div>Reason</div><div>${esc(t.reason || '-')}</div></div>`, confirmLabel: '닫기' });
      return;
    }
    const traceReplay=event.target.closest('[data-trace-replay]');
    if(traceReplay){const t=traceRows.get(traceReplay.dataset.traceReplay);if(!t)throw new Error('TRACE_NOT_FOUND');const v=await openModal({title:'Replay Request',message:`${t.requestId} 요청을 새 Request ID로 다시 실행합니다.`,confirmLabel:'REPLAY'});if(!v)return;const r=await api('/api/request-traces/replay',{method:'POST',body:{key:t.key}});toast(`Replay ${r.requestId||r.item?.requestId}`);await renderTrace();return;}

    if (event.target.id === 'feature-global-save') {
      const flags = {};
      document.querySelectorAll('[data-global-flag]').forEach(el => flags[el.dataset.globalFlag] = el.value === 'ON');
      await api('/api/control/features/global', { method: 'POST', body: { flags } });
      toast('Global Feature Flags 저장'); await renderFeatureFlags(); return;
    }
    if (event.target.id === 'feature-device-save') {
      const btn=event.target, flags={};
      document.querySelectorAll('[data-flag-name]').forEach(el => { if(el.value==='ON') flags[el.dataset.flagName]=true; else if(el.value==='OFF') flags[el.dataset.flagName]=false; });
      await api('/api/control/features/device', { method:'POST', body:{ type:btn.dataset.type, id:btn.dataset.id, flags } });
      toast('Device Feature Override 저장'); await renderFeatureFlags(); return;
    }
    if (event.target.id === 'feature-device-clear') {
      const btn=event.target;
      await api('/api/control/features/device', { method:'POST', body:{ type:btn.dataset.type, id:btn.dataset.id, flags:{} } });
      toast('Device Feature Override 초기화'); await renderFeatureFlags(); return;
    }
    const securityChallenge = event.target.closest('[data-security-challenge]');
    if (securityChallenge) {
      await api('/api/control/security/challenge', { method:'POST', body:{ type:securityChallenge.dataset.type, id:securityChallenge.dataset.id } });
      toast('HMAC Challenge 전송'); setTimeout(()=>renderProtocolSecurity(),350); return;
    }
    const configRollback = event.target.closest('[data-config-rollback]');
    if (configRollback) {
      const v=await openModal({title:'Config Rollback',message:'선택한 설정 Snapshot을 새 revision으로 복원하고 온라인 기기에 즉시 Sync합니다.',danger:true,confirmLabel:'ROLLBACK'}); if(!v)return;
      const r=await api('/api/control/config-history/rollback',{method:'POST',body:{id:configRollback.dataset.configRollback}}); toast(`Rollback 완료 → revision ${r.currentRevision}`); await renderConfigHistory(); return;
    }
    if (event.target.id === 'enrollment-policy-btn') {
      const { enrollment:e }=await api('/api/enrollment'); const enabled=!e.policy.enabled;
      const v=await openModal({title:'Device Enrollment Policy',message:enabled?'새 Device Key를 승인 전 PENDING으로 전환합니다. 기존 등록 기기는 영향 없습니다.':'새 Device 자동 등록을 다시 허용합니다.',danger:enabled,confirmLabel:enabled?'ENABLE':'DISABLE'});if(!v)return;
      await api('/api/enrollment/policy',{method:'POST',body:{enabled}});toast(`Enrollment ${enabled?'ON':'OFF'}`);await renderEnrollment();return;
    }
    const enrollDecision=event.target.closest('[data-enroll-decision]');
    if(enrollDecision){await api('/api/enrollment/decision',{method:'POST',body:{requestId:enrollDecision.dataset.requestId,status:enrollDecision.dataset.enrollDecision}});toast(`Enrollment ${enrollDecision.dataset.enrollDecision}`);await renderEnrollment();return;}
    const enrollReset=event.target.closest('[data-enroll-reset]');
    if(enrollReset){await api('/api/enrollment/reset',{method:'POST',body:{requestId:enrollReset.dataset.enrollReset}});toast('Enrollment 기록 초기화');await renderEnrollment();return;}
    const securityRotate = event.target.closest('[data-security-rotate]');
    if (securityRotate) {
      const v=await openModal({title:'Zero-Downtime Secret Rotation',message:`${securityRotate.dataset.type} ${securityRotate.dataset.id}의 현재 Secret에서 새 Secret을 파생하고 2단계 Commit합니다. Secret 원문은 네트워크로 다시 보내지 않습니다.`,danger:true,confirmLabel:'ROTATE'});if(!v)return;
      const r=await api('/api/control/security/rotate',{method:'POST',body:{type:securityRotate.dataset.type,id:securityRotate.dataset.id}});toast(`Rotation ${r.rotation.rotationId} 시작`);setTimeout(()=>renderProtocolSecurity(),350);return;
    }
    const securityReset = event.target.closest('[data-security-reset]');
    if (securityReset) {
      const v=await openModal({title:'Re-enroll Device Secret',message:`${securityReset.dataset.type} ${securityReset.dataset.id}의 기존 Secret을 폐기하고 새 Secret을 다시 등록합니다. 연결 장애 복구용입니다.`,danger:true,confirmLabel:'RE-ENROLL'}); if(!v)return;
      await api('/api/control/security/reset', { method:'POST', body:{ type:securityReset.dataset.type, id:securityReset.dataset.id } });
      toast('Device Secret Re-enrollment 시작'); setTimeout(()=>renderProtocolSecurity(),350); return;
    }

    const networkTrust=event.target.closest('[data-network-trust]');
    if(networkTrust){
      const v=await openModal({title:'Trust Current Network',message:`${networkTrust.dataset.type} ${networkTrust.dataset.id}의 현재 IP / Subnet / Country를 새 기준점으로 승인합니다. 과거 Audit 기록은 유지됩니다.`,confirmLabel:'TRUST'}); if(!v)return;
      await api('/api/security/network/trust',{method:'POST',body:{type:networkTrust.dataset.type,id:networkTrust.dataset.id}});
      toast('Current network trusted'); await renderSecurityCenter(); return;
    }

    if (event.target.id === 'license-search-btn') {
      licenseQuery = document.getElementById('license-search').value.trim();
      licenseStatus = document.getElementById('license-status').value;
      licenseExpiry = document.getElementById('license-expiry').value;
      renderLicenses(); return;
    }
    if (event.target.id === 'license-bulk-btn') { await bulkLicense(); return; }
    if (event.target.id === 'license-check-all') {
      document.querySelectorAll('.license-check').forEach(x => { x.checked = event.target.checked; if (x.checked) selectedLicenses.add(x.dataset.key); else selectedLicenses.delete(x.dataset.key); });
      return;
    }
    if (event.target.classList.contains('license-check')) {
      if (event.target.checked) selectedLicenses.add(event.target.dataset.key); else selectedLicenses.delete(event.target.dataset.key);
      return;
    }
    if (event.target.id === 'notification-read-all-btn') {
      await api('/api/notifications/read-all', { method: 'POST', body: {} });
      await updateNotificationBadge();
      await renderNotifications();
      return;
    }
    if (event.target.id === 'notification-clear-btn') {
      const v = await openModal({ title: 'Notification Clear', message: '현재 알림 목록을 모두 지웁니다. Audit Log는 삭제되지 않습니다.', danger: true, confirmLabel: '지우기' });
      if (!v) return;
      await api('/api/notifications/clear', { method: 'POST', body: {} });
      await updateNotificationBadge();
      await renderNotifications();
      return;
    }

    if (event.target.id === 'audit-search-btn') {
      auditQuery = document.getElementById('audit-search').value.trim();
      auditType = document.getElementById('audit-type').value;
      renderAudit(); return;
    }
    if (event.target.id === 'backup-create-btn') {
      const r = await api('/api/backups/create', { method: 'POST', body: {} }); toast(`백업 생성: ${r.file}`); renderBackups(); return;
    }
    if (event.target.id === 'service-start-btn') { await api('/api/system/service/start', { method: 'POST', body: {} }); toast('Service ONLINE'); renderSystem(); return; }
    if (event.target.id === 'service-stop-btn') {
      const v = await openModal({ title: 'Service Stop', message: '현재 Client 인증을 해제하고 서비스를 중지합니다.', danger: true, confirmLabel: '중지' });
      if (!v) return; await api('/api/system/service/stop', { method: 'POST', body: {} }); toast('Service OFFLINE'); renderSystem(); return;
    }
    if (event.target.id === 'maint-on-btn') { await api('/api/system/maintenance/on', { method: 'POST', body: {} }); toast('Maintenance ON'); renderSystem(); return; }
    if (event.target.id === 'maint-off-btn') { await api('/api/system/maintenance/off', { method: 'POST', body: {} }); toast('Maintenance OFF'); renderSystem(); return; }
    if (event.target.id === 'version-apply-btn') { await applyVersion(); return; }
    if (event.target.id === 'schedule-create-btn') { await createSchedule(); return; }
    if (event.target.id === 'schedule-clear-btn') { await api('/api/system/maintenance/clear', { method: 'POST', body: {} }); toast('Maintenance 예약 제거'); renderSystem(); return; }
    if (event.target.id === 'notice-all-btn') { await sendNoticeAll(); return; }
  } catch (error) { toast(error.message, true); }
});


content.addEventListener('submit', async event => {
  if (event.target.id !== 'command-terminal-form') return;
  event.preventDefault();
  const input=document.getElementById('command-terminal-input');
  const line=input ? input.value : '';
  if(input) input.value='';
  await executeTerminalCommand(line);
  if(currentView==='terminal') await renderTerminal();
});

content.addEventListener('keydown', event => {
  if (event.target.id !== 'command-terminal-input') return;
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    terminalHistoryIndex=Math.max(0, terminalHistoryIndex-1);
    event.target.value=terminalHistory[terminalHistoryIndex] || '';
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    terminalHistoryIndex=Math.min(terminalHistory.length, terminalHistoryIndex+1);
    event.target.value=terminalHistoryIndex>=terminalHistory.length?'':(terminalHistory[terminalHistoryIndex]||'');
  }
});

async function serverAction(action, id) {
  const encodedId = encodeURIComponent(id);
  if (action === 'detail') {
    const { server } = await api(`/api/servers/${encodedId}`);
    const clients = server.clientsList.map(c => `<tr><td class="code">${esc(c.id)}</td><td>${badge(c.status)}</td><td>${badge(c.licenseStatus)}</td></tr>`).join('') || '<tr><td colspan="3">Client 없음</td></tr>';
    await openModal({ title: `Server ${id}`, html: `<div class="kv"><div>Alias</div><div>${esc(server.alias || '-')}</div><div>Note</div><div>${esc(server.note || '-')}</div><div>Device Key</div><div class="code">${esc(server.deviceKey)}</div><div>Status</div><div>${badge(server.status)}</div><div>Health</div><div>${badge(server.health)}</div><div>Accept Clients</div><div>${badge(server.acceptState || (server.canAcceptClients ? 'READY' : 'OFFLINE'))}</div><div>Live / Saved Clients</div><div>${server.clients} / ${server.savedClients}</div><div>RTT</div><div>${server.rttMs >= 0 ? `${server.rttMs} ms` : '-'}</div><div>Kick Until</div><div>${esc(fmtTime(server.kickedUntil))}</div><div>IP</div><div>${esc(server.lastIP || '-')}</div><div>Protocol / Version</div><div>${server.protocolVersion || '-'} / ${esc(server.appVersion || '-')}</div><div>Reconnect</div><div>${server.reconnectCount}</div><div>Last Seen</div><div>${esc(fmtTime(server.lastSeen))}</div></div><div class="table-wrap"><table><thead><tr><th>Client</th><th>Status</th><th>License</th></tr></thead><tbody>${clients}</tbody></table></div>`, confirmLabel: '닫기' });
    return;
  }

  if (action === 'alias') {
    const { server } = await api(`/api/servers/${encodedId}`);
    const v = await openModal({ title: 'Server Alias', message: `${id} 표시용 별칭입니다. 실제 SERVER-ID는 변경되지 않습니다.`, fields: [{ name: 'alias', label: 'Alias', value: server.alias || '', placeholder: 'OFFICE-PC-01' }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/servers/${encodedId}/alias`, { method: 'POST', body: v });
    toast('Server Alias 저장');
    await renderServers();
    return;
  }

  if (action === 'note') {
    const { server } = await api(`/api/servers/${encodedId}`);
    const v = await openModal({ title: 'Server Note', message: `${id} 운영 메모입니다.`, fields: [{ name: 'note', label: 'Note', type: 'textarea', value: server.note || '', placeholder: '고객사 / 위치 / 장비 교체 이력 등' }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/servers/${encodedId}/note`, { method: 'POST', body: v });
    toast('Server Note 저장'); await renderServers(); return;
  }

  if (action === 'delete') {
    const v = await openModal({ title: 'Server Delete', message: `${id}\nSERVER-ID, HMAC, 고정 Build 바인딩과 종속 설정을 삭제하고 이 설치의 자동 재등록을 차단합니다. 연결된 APK는 미배정 상태가 되며, RESTORE 전에는 같은 EXE가 새 ID를 만들 수 없습니다.`, danger: true, confirmLabel: 'DELETE' });
    if (!v) return;
    const r = await api(`/api/servers/${encodedId}`, { method: 'DELETE', body: {} });
    toast(`Server 삭제 및 재접속 차단 · released ${r.releasedClients}`);
    await renderServers();
    return;
  }

  let body = {};
  if (action === 'kick') {
    const v = await openModal({ title: 'Server Kick', message: `${id} 연결을 끊고 60초 동안 재등록을 차단합니다.`, confirmLabel: 'Kick' });
    if (!v) return;
  } else if (action === 'drain-on') {
    const v = await openModal({ title: 'Drain ON', message: `${id}에 신규 Client 배정을 중지합니다. 기존 Client는 유지됩니다.`, confirmLabel: '적용' });
    if (!v) return;
  } else if (action === 'disable') {
    const v = await openModal({ title: 'Server Disable', message: `${id} 서버를 비활성화하고 현재 연결을 종료합니다. 계속하시겠습니까?`, danger: true, confirmLabel: 'Disable' });
    if (!v) return;
  }

  await api(`/api/servers/${encodedId}/${action}`, { method: 'POST', body });
  toast(`Server ${action}: ${id}`);
  await renderServers();
}

async function clientAction(action, id) {
  const encodedId = encodeURIComponent(id);
  if (action === 'detail') {
    const { client } = await api(`/api/clients/${encodedId}`);
    await openModal({ title: `Client ${id}`, html: `<div class="kv"><div>Alias</div><div>${esc(client.alias || '-')}</div><div>Note</div><div>${esc(client.note || '-')}</div><div>Device Key</div><div class="code">${esc(client.deviceKey)}</div><div>Status</div><div>${badge(client.status)}</div><div>Health</div><div>${badge(client.health)}</div><div>Password</div><div>${badge(client.password?.locked ? 'LOCKED' : (client.password?.registered ? 'SET' : 'NONE'))} <span class="code">${esc(client.password?.masked || '-')}</span></div><div>Password Updated</div><div>${esc(fmtTime(client.password?.updatedAt))}</div><div>Password Lock</div><div>${esc(fmtTime(client.password?.lockUntil))}</div><div>Server</div><div class="code">${esc(client.serverAlias || client.serverId)}${client.serverAlias ? ` [${esc(client.serverId)}]` : ''}</div><div>License</div><div class="code">${esc(client.licenseKey || '-')}</div><div>License Status</div><div>${badge(client.licenseStatus)}</div><div>Expires</div><div>${esc(fmtTime(client.licenseExpiresAt))}</div><div>Kick Until</div><div>${esc(fmtTime(client.kickedUntil))}</div><div>IP</div><div>${esc(client.lastIP || '-')}</div><div>Protocol / Version</div><div>${client.protocolVersion || '-'} / ${esc(client.appVersion || '-')}</div><div>RTT</div><div>${client.rttMs >= 0 ? `${client.rttMs} ms` : '-'}</div><div>Auth / Send / Reconnect</div><div>${client.authCount} / ${client.sendCount} / ${client.reconnectCount}</div><div>Last Auth</div><div>${esc(fmtTime(client.lastAuthAt))}</div><div>Last Seen</div><div>${esc(fmtTime(client.lastSeenAt))}</div></div>`, confirmLabel: '닫기' });
    return;
  }

  if (action === 'password') {
    const { client } = await api(`/api/clients/${encodedId}`);
    let v = null;
    while (true) {
      v = await openModal({
        title: 'Client Password Reset',
        message: `${id}\n기존 비밀번호는 단방향 검증값으로만 저장되어 원문 조회가 불가능합니다. 새 PIN을 입력하면 즉시 교체되며, 온라인 APK는 다시 로그인해야 합니다.`,
        html: `<div class="password-status"><span>현재 상태</span>${badge(client.password?.locked ? 'LOCKED' : (client.password?.registered ? 'SET' : 'NONE'))}<span>마지막 변경</span><strong>${esc(fmtTime(client.password?.updatedAt))}</strong></div>`,
        fields: [
          { name: 'password', label: '새 PIN (6자리 숫자)', type: 'password', placeholder: '6자리 PIN', maxLength: 6 },
          { name: 'confirmPassword', label: '새 PIN 재확인', type: 'password', placeholder: '같은 6자리 PIN', maxLength: 6 }
        ],
        confirmLabel: '재설정'
      });
      if (!v) return;
      v.password = String(v.password || '').trim();
      v.confirmPassword = String(v.confirmPassword || '').trim();
      if (!/^\d{6}$/.test(v.password)) { toast('PIN은 정확히 6자리 숫자만 사용할 수 있습니다.', true); continue; }
      if (v.password !== v.confirmPassword) { toast('PIN 재확인이 일치하지 않습니다.', true); continue; }
      break;
    }
    await api(`/api/clients/${encodedId}/password/reset`, { method: 'POST', body: { password: v.password } });
    await openModal({ title: '비밀번호 재설정 완료', html: `<div class="password-once"><span>새 PIN · 이번 화면에서만 표시</span><strong>${esc(v.password)}</strong><small>서버에는 PIN 원문이 아닌 HMAC 검증값만 저장됩니다.</small></div>`, confirmLabel: '닫기' });
    toast('Client 비밀번호 재설정 완료');
    if (currentView === 'clientpasswords') await renderClientPasswords();
    else await renderClients();
    return;
  }

  if (action === 'alias') {
    const { client } = await api(`/api/clients/${encodedId}`);
    const v = await openModal({ title: 'Client Alias', message: `${id} 표시용 별칭입니다. 실제 CLIENT-ID는 변경되지 않습니다.`, fields: [{ name: 'alias', label: 'Alias', value: client.alias || '', placeholder: 'GALAXY-TEST' }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/alias`, { method: 'POST', body: v });
    toast('Client Alias 저장');
    await renderClients();
    return;
  }

  if (action === 'note') {
    const { client } = await api(`/api/clients/${encodedId}`);
    const v = await openModal({ title: 'Client Note', message: `${id} 운영 메모입니다.`, fields: [{ name: 'note', label: 'Note', type: 'textarea', value: client.note || '', placeholder: '사용자 / 장비 / 교체 이력 등' }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/note`, { method: 'POST', body: v });
    toast('Client Note 저장'); await renderClients(); return;
  }

  if (action === 'notice') {
    const v = await openModal({ title: 'Client Notice', message: id, fields: [{ name: 'message', label: '공지', type: 'textarea' }], confirmLabel: '전송' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/notice`, { method: 'POST', body: v });
    toast('공지 전송 완료');
    return;
  }

  if (action === 'delete') {
    const v = await openModal({ title: 'Client Delete', message: `${id}\nCLIENT-ID와 QR, PIN, License 결합, Build 바인딩 및 종속 데이터를 삭제하고 이 설치의 자동 재등록을 차단합니다. RESTORE 전에는 실행 중 APK가 새 ID를 만들 수 없습니다.`, danger: true, confirmLabel: 'DELETE' });
    if (!v) return;
    await api(`/api/clients/${encodedId}`, { method: 'DELETE', body: {} });
    toast(`Client 삭제: ${id}`);
    await renderClients();
    return;
  }

  if (action === 'move') {
    const [{ client }, { servers }] = await Promise.all([api(`/api/clients/${encodedId}`), api('/api/servers')]);
    const eligible = servers.filter(s => s.id !== client.serverId && s.canAcceptClients);
    if (!eligible.length) {
      toast('이동 가능한 ONLINE Server가 없습니다.', true);
      return;
    }
    const v = await openModal({ title: 'Client Move', message: `${id}
ONLINE이며 Drain/Disable/Kick 상태가 아닌 Server만 표시됩니다.`, fields: [{ name: 'serverId', label: '새 Server', type: 'select', options: eligible.map(s => ({ value: s.id, label: `${s.alias ? s.alias + ' · ' : ''}${s.id} · ${s.health} · ${s.clients}/${s.savedClients}` })) }], confirmLabel: '이동' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/move`, { method: 'POST', body: v });
    toast('Client 이동 완료');
    await renderClients();
    return;
  }

  let body = {};
  if (action === 'kick') {
    const v = await openModal({ title: 'Client Kick', message: `${id} 연결을 끊고 60초 동안 재접속을 차단합니다.`, confirmLabel: 'Kick' });
    if (!v) return;
  } else if (action === 'disable') {
    const v = await openModal({ title: 'Client Disable', message: `${id} Client를 비활성화하고 현재 연결을 종료합니다. 계속하시겠습니까?`, danger: true, confirmLabel: 'Disable' });
    if (!v) return;
  }

  await api(`/api/clients/${encodedId}/${action}`, { method: 'POST', body });
  toast(`Client ${action}: ${id}`);
  await renderClients();
}

async function licenseAction(action, key) {
  let body = {};
  if (action === 'tags') {
    const { licenses } = await api(`/api/licenses?query=${encodeURIComponent(key)}&status=ALL&expiry=ALL`);
    const current = licenses.find(x => x.key === key);
    const v = await openModal({ title: 'License Tags', message: key, fields: [{ name: 'tags', label: 'Tags', value: current ? (current.tags || []).join(', ') : '', placeholder: 'VIP, CUSTOMER-A, TEST' }], confirmLabel: '저장' });
    if (!v) return;
    const tags = String(v.tags || '').split(',').map(x => x.trim()).filter(Boolean);
    await api(`/api/licenses/${encodeURIComponent(key)}/tags`, { method: 'POST', body: { tags } });
    toast('License Tags 저장');
    renderLicenses();
    return;
  }
  if (action === 'extend') {
    const v = await openModal({ title: 'License 연장', message: key, fields: [{ name: 'days', label: '추가 일수', type: 'number', value: '30' }], confirmLabel: '연장' }); if (!v) return; body.days = Number(v.days);
  } else if (action === 'transfer') {
    const v = await openModal({ title: 'License Transfer', message: key, fields: [{ name: 'clientId', label: '대상 CLIENT-ID' }], confirmLabel: '이전' }); if (!v) return; body = v;
  } else if (action === 'delete') {
    const v = await openModal({ title: 'License Delete', message: `${key}\n이 License를 삭제합니다. 삭제 후에는 복구할 수 없습니다.`, danger: true, confirmLabel: '삭제' }); if (!v) return;
  } else {
    const v = await openModal({ title: `License ${action}`, message: `${key}\n계속하시겠습니까?`, danger: action === 'reissue', confirmLabel: '실행' }); if (!v) return;
  }
  const r = await api(`/api/licenses/${encodeURIComponent(key)}/${action}`, { method: 'POST', body });
  if (action === 'reissue') await openModal({ title: 'Reissue 완료', html: `<div class="kv"><div>Old</div><div class="code">${esc(r.oldKey)}</div><div>New</div><div class="code">${esc(r.newKey)}</div></div>`, confirmLabel: '닫기' });
  else toast(`License ${action} 완료`);
  renderLicenses();
}

async function bulkLicense() {
  const keys = [...selectedLicenses];
  if (!keys.length) { toast('선택된 License가 없습니다.', true); return; }
  const options = [{ value: 'extend', label: 'Extend' }, { value: 'unbind', label: 'Unbind' }, { value: 'suspend', label: 'Suspend' }, { value: 'resume', label: 'Resume' }];
  const v = await openModal({ title: `선택 License ${keys.length}개`, fields: [{ name: 'action', label: '작업', type: 'select', options }, { name: 'days', label: '연장 일수(Extend만)', type: 'number', value: '30' }], confirmLabel: '계속' });
  if (!v) return;
  if (v.action === 'delete') {
    const confirmed = await openModal({ title: 'Bulk License Delete', message: `선택한 License ${keys.length}개를 삭제합니다. 삭제 후에는 복구할 수 없습니다.`, danger: true, confirmLabel: '모두 삭제' });
    if (!confirmed) return;
  }
  const r = await api('/api/licenses/bulk', { method: 'POST', body: { action: v.action, keys, days: Number(v.days) } });
  toast(`${r.success}/${r.total} 처리 완료`); selectedLicenses.clear(); renderLicenses();
}

async function backupAction(action, file) {
  if (action === 'verify') {
    const { verification: v } = await api(`/api/backups/${encodeURIComponent(file)}/verify`);
    const issues = [...(v.errors || []).map(x=>({...x,severity:'ERROR'})), ...(v.warnings || []).map(x=>({...x,severity:'WARNING'}))];
    await openModal({ title: `Backup Verify // ${file}`, html: `<div class="kv"><div>Result</div><div>${badge(v.ok ? 'GOOD' : 'ERROR')}</div><div>Servers</div><div>${v.stats.servers || 0}</div><div>Clients</div><div>${v.stats.clients || 0}</div><div>Licenses</div><div>${v.stats.licenses || 0}</div><div>Errors</div><div>${(v.errors || []).length}</div><div>Warnings</div><div>${(v.warnings || []).length}</div></div>${issues.length ? `<div class="integrity-list">${issues.map(x=>`<div class="integrity-row">${badge(x.severity)}<span class="code">${esc(x.code)}</span><span>${esc(x.message)}</span><span class="code">${esc(x.entity || '-')}</span></div>`).join('')}</div>` : '<div class="integrity-ok">[ BACKUP_HEALTHY ] Restore structure verified.</div>'}`, confirmLabel: '닫기' });
    return;
  }
  const label = action === 'restore' ? 'Restore' : 'Delete';
  const v = await openModal({ title: `Backup ${label}`, message: `${file}\n${action === 'restore' ? 'DB 상태를 이 Backup으로 복원하며 연결이 재설정될 수 있습니다.' : '이 Backup 파일을 삭제합니다.'}`, danger: true, confirmLabel: label.toUpperCase() });
  if (!v) return;
  if (action === 'restore') { const verify=await api(`/api/backups/${encodeURIComponent(file)}/verify`); if(!verify.verification.ok) throw new Error('BACKUP_VERIFY_FAILED'); }
  await api(`/api/backups/${encodeURIComponent(file)}/${action}`, { method: 'POST', body: {} });
  toast(`Backup ${action} 완료`); renderBackups();
}

async function applyVersion() {
  const protocol = Number(document.getElementById('version-protocol').value);
  const serverVersion = document.getElementById('version-server').value.trim();
  const clientVersion = document.getElementById('version-client').value.trim();
  const v = await openModal({ title: 'Version Policy 적용', message: `Protocol >= ${protocol} // Server >= ${serverVersion} // Client >= ${clientVersion}. 기준 미달 연결이 종료될 수 있습니다.`, danger: true, confirmLabel: '적용' });
  if (!v) return;
  await api('/api/system/version', { method: 'POST', body: { protocol, serverVersion, clientVersion } });
  toast('Version Policy 적용 완료'); renderSystem();
}

async function createSchedule() {
  const now = new Date(Date.now() + 3600000);
  const later = new Date(Date.now() + 7200000);
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const v = await openModal({ title: 'Maintenance 예약', fields: [
    { name: 'start', label: '시작', type: 'datetime-local', value: local(now) },
    { name: 'end', label: '종료', type: 'datetime-local', value: local(later) },
    { name: 'message', label: '공지 메시지', value: 'Scheduled maintenance' },
    { name: 'autoDrain', label: 'Auto Drain', type: 'select', options: [{value:'1',label:'ON - 예약 전 Drain 시작'},{value:'0',label:'OFF'}] },
    { name: 'drainLeadMinutes', label: 'Drain 시작 전 시간(분)', type: 'number', value: '15' },
    { name: 'forceStart', label: 'Client 남아도 예약 시각에 Maintenance 시작', type: 'select', options: [{value:'0',label:'OFF - 0명까지 대기 (권장)'},{value:'1',label:'ON - 예약 시각 강제 시작'}] }
  ], confirmLabel: '예약' });
  if (!v) return;
  await api('/api/system/maintenance/schedule', { method: 'POST', body: { startAt: new Date(v.start).getTime(), endAt: new Date(v.end).getTime(), message: v.message, autoDrain: v.autoDrain === '1', drainLeadMinutes: Number(v.drainLeadMinutes)||0, forceStart: v.forceStart === '1' } });
  toast('Maintenance 예약 완료'); renderSystem();
}

async function sendNoticeAll() {
  const v = await openModal({ title: '전체 Notice', fields: [{ name: 'message', label: '공지', type: 'textarea' }], confirmLabel: '전송' });
  if (!v) return;
  const r = await api('/api/system/notice', { method: 'POST', body: v });
  toast(`${r.count}개 Client에 전송 완료`);
}


function ensurePalette() {
  let root = document.getElementById('command-palette');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'command-palette';
  root.className = 'command-palette hidden';
  root.innerHTML = `<div class="palette-backdrop" data-palette-close></div><div class="palette-card"><div class="palette-head"><span>&gt;_ GLOBAL_SEARCH</span><kbd>ESC</kbd></div><input id="palette-input" class="palette-input" placeholder="Server / Client / License / Request 검색"><div id="palette-results" class="palette-results"><div class="palette-hint">CTRL+K // TYPE TO SEARCH</div></div></div>`;
  document.body.appendChild(root);
  root.addEventListener('click', async event => {
    if (event.target.closest('[data-palette-close]')) { closePalette(); return; }
    const row = event.target.closest('[data-palette-kind]');
    if (!row) return;
    const kind = row.dataset.paletteKind;
    const id = row.dataset.paletteId;
    closePalette();
    try {
      if (kind === 'SERVER') { switchView('servers'); await renderCurrent(); await serverAction('detail', id); }
      else if (kind === 'CLIENT') { switchView('clients'); await renderCurrent(); await clientAction('detail', id); }
      else if (kind === 'LICENSE') { licenseQuery = id; licenseStatus = 'ALL'; licenseExpiry = 'ALL'; switchView('licenses'); await renderCurrent(); }
      else if (kind === 'REQUEST') { traceQuery = row.dataset.paletteLabel || id; switchView('trace'); await renderCurrent(); }
    } catch (error) { toast(error.message, true); }
  });
  root.querySelector('#palette-input').addEventListener('input', event => {
    clearTimeout(paletteTimer);
    paletteTimer = setTimeout(() => runPaletteSearch(event.target.value), 140);
  });
  return root;
}

function openPalette() {
  if (!session) return;
  const root = ensurePalette();
  root.classList.remove('hidden');
  const input = root.querySelector('#palette-input');
  input.value = '';
  root.querySelector('#palette-results').innerHTML = '<div class="palette-hint">Server ID / Alias / Client / License Tag / Request ID</div>';
  setTimeout(() => input.focus(), 10);
}

function closePalette() {
  const root = document.getElementById('command-palette');
  if (root) root.classList.add('hidden');
}

async function runPaletteSearch(query) {
  const resultsEl = document.getElementById('palette-results');
  if (!resultsEl) return;
  query = String(query || '').trim();
  if (!query) { resultsEl.innerHTML = '<div class="palette-hint">Server ID / Alias / Client / License Tag / Request ID</div>'; return; }
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(query)}`);
    resultsEl.innerHTML = results.map(r => `<button class="palette-row" data-palette-kind="${esc(r.kind)}" data-palette-id="${esc(r.id)}" data-palette-label="${esc(r.label)}"><span class="palette-kind">${esc(r.kind)}</span><span class="palette-main"><strong>${esc(r.label)}</strong><small>${esc(r.detail)}</small></span>${r.status ? badge(r.status) : ''}</button>`).join('') || '<div class="palette-hint">NO_MATCH</div>';
  } catch (error) { resultsEl.innerHTML = `<div class="palette-hint error-text">${esc(error.message)}</div>`; }
}

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') { event.preventDefault(); openPalette(); return; }
  if (event.key === 'Escape') closePalette();
});



content.addEventListener('change', async event => {
  try {
    const el=event.target.closest('[data-release-channel-select]');
    if(!el)return;
    await api('/api/releases/device-channel',{method:'POST',body:{type:el.dataset.type,id:el.dataset.id,channel:el.value}});
    toast(`${el.dataset.type} ${el.dataset.id} → ${el.value}`);
    await renderReleases();
  } catch(error) { toast(error.message,true); }
});

restoreSession();

// PWA: cache only the static application shell. Authenticated API responses are network-only.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker
    .register('/service-worker.js', { scope: '/', updateViaCache: 'none' })
    .then(registration => registration.update())
    .catch(() => {}));
}
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (installPwaBtn) installPwaBtn.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  if (installPwaBtn) installPwaBtn.classList.add('hidden');
});
if (installPwaBtn) installPwaBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try { await deferredInstallPrompt.userChoice; } catch (_) {}
  deferredInstallPrompt = null;
  installPwaBtn.classList.add('hidden');
});
