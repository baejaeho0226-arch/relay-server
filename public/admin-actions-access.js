'use strict';
async function handleAccessAction(event) {
    const openViewBtn = event.target.closest('[data-open-view]');
    if (openViewBtn) { switchView(openViewBtn.dataset.openView); await renderCurrent(); return true; }
    if (event.target.id === 'pairing-repair-btn') {
      const v = await openModal({ title: "1:1 기기 연결 복구", message: "존재하지 않는 서버 바인딩과 중복 배정을 정리하고, 현재 온라인 상태인 빈 PC와 대기 APK를 다시 1:1로 연결합니다. 오프라인이지만 등록이 남아 있는 정상 고정 쌍은 임의로 이동하지 않습니다.", confirmLabel: "복구" });
      if (!v) return true;
      const r = await api('/api/pairing/repair', { method: 'POST', body: {} });
      toast(`1:1 복구 완료 · orphan ${r.repair.orphaned} · 중복 ${r.repair.duplicate} · 배정됨 ${r.repair.assigned}`);
      await renderCurrent();
      return true;
    }
    const historyClean = event.target.closest('[data-history-clean]');
    if (historyClean) {
      const scope = historyClean.dataset.historyClean;
      const v = await openModal({ title: "이력 이력 정리", message: `${scope} 종료 이력을 정리합니다. 진행 중인 요청, 활성 실행 세션, 대기 QR 및 활성 실패 보관함는 보존됩니다.`, danger: true, confirmLabel: "이력 정리" });
      if (!v) return true;
      await api('/api/history/clean', { method: 'POST', body: { scope } });
      toast(`${scope} 이력 정리 완료`);
      await renderCurrent();
      return true;
    }
    if (event.target.id === 'qr-auth-scan-btn') {
      const file = qrSelectedFile;
      if (!file) throw new Error('QR 사진을 먼저 선택하세요.');
      if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('PNG 또는 JPEG 사진만 사용할 수 있습니다.');
      const photoSerial=qrPhotoSerial;
      const scanButton = event.target;
      const maxBytes = Number(scanButton.dataset.maxBytes || 8 * 1024 * 1024);
      if (file.size > maxBytes) throw new Error(`QR 사진은 ${fmtBytes(maxBytes)} 이하여야 합니다.`);
      scanButton.disabled = true;
      scanButton.textContent = '검증 중...';
      try {
        const imageData = await fileAsDataUrl(file);
        const result=await api('/api/qr-auth/scan', { method: 'POST', body: { imageData } });
        if(photoSerial!==qrPhotoSerial||currentView!=='qrauth')return true;
        qrScanResult=result;
        toast(`${qrScanResult.request.clientId} 서명 검증 완료`);
        await renderQrAuth();
      } finally {
        if (document.body.contains(scanButton)) {
          scanButton.disabled = false;
          scanButton.textContent = '서버에서 QR 검증';
        }
      }
      return true;
    }
    if (event.target.id === 'qr-auth-approve-btn') {
      if (!qrScanResult || !qrScanResult.request || !qrScanResult.approvalToken) throw new Error('검증된 QR 요청이 없습니다.');
      const scanned=qrScanResult,wallet=scanned.purpose==='WALLET';
      const values=await openModal({
        title:wallet?'QR 잔액 충전':'QR 출입증 승인',
        message:wallet?`${scanned.request.memberName} · ${scanned.request.accountId}\n확인한 금액을 기간 없는 잔액에 적립합니다. 게임 이용 기간은 회원이 따로 구매합니다.`:`${scanned.request.clientId}\n기간과 게임 지정 없이 출입증을 승인합니다. 게임 이용권은 잔액 충전 후 앱에서 구매합니다.`,
        fields:wallet?[{name:'amount',label:'확인한 충전 금액 (원)',type:'number',value:''},{name:'memo',label:'확인 메모',type:'textarea',value:''}]:[{name:'memo',label:'메모',value:''},{name:'tags',label:'태그',value:'QR'}],
        confirmLabel:wallet?'잔액 충전':'출입증 승인'
      });
      if(!values)return true;
      const result=await api('/api/qr-auth/approve',{method:'POST',body:{
        purpose:wallet?'WALLET':'ENTRY',requestId:scanned.request.requestId,approvalToken:scanned.approvalToken,memo:values.memo,
        ...(wallet?{mode:'WALLET',amount:Number(values.amount)}:{tags:String(values.tags||'').split(',').map(x=>x.trim()).filter(Boolean)})
      }});
      qrScanResult = null;
      clearQrSelectedFile();
      toast(wallet?'잔액 충전 완료 · 앱에 자동 반영됩니다.':result.delivered?'출입증 승인 완료 · APK 인증을 계속합니다.':'출입증 승인 완료 · APK 연결 시 자동 인증됩니다.');
      await updateQrAuthBadge();
      await renderQrAuth();
      return true;
    }
    if (event.target.id === 'qr-auth-clear-btn') {
      qrScanResult = null;
      clearQrSelectedFile();
      await renderQrAuth();
      return true;
    }
    const qrReject = event.target.closest('[data-qr-reject]');
    if (qrReject) {
      const values = await openModal({ title: 'QR 인증 거절', message: `${qrReject.dataset.qrReject}\n해당 QR은 즉시 재사용할 수 없게 됩니다.`, fields: [{ name: 'reason', label: '거절 사유', value: '' }], danger: true, confirmLabel: '거절' });
      if (!values) return true;
      await api('/api/qr-auth/reject', { method: 'POST', body: { purpose:qrReject.dataset.qrPurpose, requestId: qrReject.dataset.qrReject, reason: values.reason } });
      if (qrScanResult && qrScanResult.request.requestId === qrReject.dataset.qrReject) {
        qrScanResult = null;
        clearQrSelectedFile();
      }
      toast('QR 인증 요청 거절 완료');
      await updateQrAuthBadge();
      await renderQrAuth();
      return true;
    }
    if (event.target.id === 'build-session-policy-save') {
      const ttlMinutes = Number(document.getElementById('build-session-ttl').value);
      await api('/api/build-sessions/policy', { method: 'POST', body: { ttlMinutes } });
      toast(`실행 세션 유효 시간 ${ttlMinutes}분 저장`);
      await renderBuildSessions();
      return true;
    }
    const buildRevoke = event.target.closest('[data-build-revoke]');
    if (buildRevoke) {
      const values = await openModal({
        title: "실행 세션 즉시 해제",
        message: `${buildRevoke.dataset.buildRevoke}\nAPK와 WinSockServer가 즉시 다시 잠기며 실행를 다시 수행해야 합니다.`,
        fields: [{ name: 'reason', label: '해제 사유', value: 'ADMIN_REVOKE' }],
        danger: true,
        confirmLabel: "해제 지금"
      });
      if (!values) return true;
      await api(`/api/build-sessions/${encodeURIComponent(buildRevoke.dataset.buildRevoke)}/revoke`, { method: 'POST', body: { reason: values.reason } });
      toast("실행 세션 해제 완료");
      await renderBuildSessions();
      return true;
    }
    const buildRebind = event.target.closest('[data-build-rebind]');
    if (buildRebind) {
      const options = buildSessionServers.map(server => server.id);
      if (!options.length) throw new Error('등록된 WinSockServer가 없습니다.');
      const current = options.includes(buildRebind.dataset.currentServer) ? buildRebind.dataset.currentServer : options[0];
      const values = await openModal({
        title: "APK ↔ WinSockServer 배정 변경",
        message: `${buildRebind.dataset.buildRebind}\n기존 활성 실행 세션은 즉시 해제됩니다. 다른 서버를 선택하면 앱 기기도 해당 서버로 안전하게 이동합니다.`,
        fields: [{ name: 'serverId', label: '새 WinSockServer', type: 'select', value: current, options }],
        danger: true,
        confirmLabel: "배정 변경"
      });
      if (!values) return true;
      await api(`/api/build-bindings/${encodeURIComponent(buildRebind.dataset.buildRebind)}/rebind`, { method: 'POST', body: { serverId: values.serverId } });
      toast("실행 고정 배정 변경 완료");
      await renderBuildSessions();
      return true;
    }
    
  return false;
}
