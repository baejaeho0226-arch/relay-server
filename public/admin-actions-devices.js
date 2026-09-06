'use strict';
async function handleDevicesAction(event) {
    const serverBtn = event.target.closest('[data-server-action]');
    if (serverBtn) { await serverAction(serverBtn.dataset.serverAction, serverBtn.dataset.id); return true; }
    const clientBtn = event.target.closest('[data-client-action]');
    if (clientBtn) { await clientAction(clientBtn.dataset.clientAction, clientBtn.dataset.id); return true; }
    const licBtn = event.target.closest('[data-license-action]');
    if (licBtn) { await licenseAction(licBtn.dataset.licenseAction, licBtn.dataset.key); return true; }
    const backupBtn = event.target.closest('[data-backup-action]');
    if (backupBtn) { await backupAction(backupBtn.dataset.backupAction, backupBtn.dataset.file); return true; }
    const statsBtn = event.target.closest('[data-stats-range]');
    if (statsBtn) { statsRange = statsBtn.dataset.statsRange || '1H'; await renderDashboard(); return true; }
    if (event.target.id === 'integrity-run-btn') { await renderSystemHealth(); toast("데이터베이스 무결성 검사 완료"); return true; }

    const expiryBtn = event.target.closest('[data-license-expiry]');
    if (expiryBtn) {
      licenseExpiry = expiryBtn.dataset.licenseExpiry || 'ALL';
      licenseStatus = licenseExpiry === 'EXPIRED' ? 'EXPIRED' : 'ALL';
      currentView = 'licenses';
      nav.querySelectorAll('button[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === 'licenses'));
      renderCurrent();
      return true;
    }
    const notificationReadBtn = event.target.closest('[data-notification-read]');
    if (notificationReadBtn) {
      await api(`/api/notifications/${encodeURIComponent(notificationReadBtn.dataset.notificationRead)}/read`, { method: 'POST', body: { read: true } });
      await updateNotificationBadge();
      await renderNotifications();
      return true;
    }

    if (event.target.id === 'activity-search-btn') { activityQuery = document.getElementById('activity-search').value.trim(); renderActivity(); return true; }
    const sessionRevokeBtn = event.target.closest('[data-session-revoke]');
    if (sessionRevokeBtn) {
      const v = await openModal({ title: "세션 종료", message: `${sessionRevokeBtn.dataset.sessionRevoke} 세션을 강제 종료합니다.`, danger: true, confirmLabel: "종료" });
      if (!v) return true;
      await api(`/api/sessions/${encodeURIComponent(sessionRevokeBtn.dataset.sessionRevoke)}/revoke`, { method: 'POST', body: {} });
      toast("세션 종료 완료"); renderSessions(); return true;
    }
    if (event.target.id === 'session-revoke-others-btn') {
      const v = await openModal({ title: "다른 세션", message: "현재 브라우저를 제외한 모든 웹 관리자 세션을 종료합니다.", danger: true, confirmLabel: '종료' });
      if (!v) return true;
      const r = await api('/api/sessions/revoke-others', { method: 'POST', body: {} }); toast(`${r.count}개 세션 종료`); renderSessions(); return true;
    }
    if (event.target.id === 'session-revoke-all-btn') {
      const v = await openModal({ title: "전체 세션", message: "현재 세션을 포함한 모든 웹 관리자 세션을 종료합니다.", danger: true, confirmLabel: '전체 종료' });
      if (!v) return true;
      await api('/api/sessions/revoke-all', { method: 'POST', body: {} }); showLogin(); return true;
    }

    if (event.target.id === 'console-pause-btn') { consolePaused = !consolePaused; renderConsole(); return true; }
    if (event.target.id === 'console-clear-btn') { liveConsoleEvents = []; consoleHistoryLoaded = true; renderConsole(); return true; }
    if (event.target.id === 'trace-search-btn') { traceQuery = document.getElementById('trace-search').value.trim(); renderTrace(); return true; }
    const traceBtn = event.target.closest('[data-trace-detail]');
    if (traceBtn) {
      const t = traceRows.get(traceBtn.dataset.traceDetail);
      if (t) await openModal({ title: `요청 추적 ${t.requestId}`, html: `<div class="kv"><div>상태</div><div>${badge(t.status)}</div><div>소스</div><div>${esc(t.source||'CLIENT')}</div><div>재전송 원본</div><div class="code">${esc(t.replayOf||'-')}</div><div>실패 보관함</div><div class="code">${esc(t.deadLetterId||'-')}</div><div>앱 기기</div><div class="code">${esc(t.clientId)}</div><div>서버</div><div class="code">${esc(t.serverId)}</div><div>입력값</div><div class="code">${esc(t.number)}</div><div>대기 중</div><div>${esc(fmtTime(t.queuedAt))}</div><div>전달됨</div><div>${esc(fmtTime(t.forwardedAt))}</div><div>처리 응답 / 완료</div><div>${esc(fmtTime(t.completedAt))}</div><div>기간</div><div>${t.completedAt ? `${t.durationMs} ms` : '-'}</div><div>재시도</div><div>${t.retries}</div><div>사유</div><div>${esc(t.reason || '-')}</div></div>`, confirmLabel: '닫기' });
      return true;
    }
    const traceReplay=event.target.closest('[data-trace-replay]');
    if(traceReplay){const t=traceRows.get(traceReplay.dataset.traceReplay);if(!t)throw new Error('TRACE_NOT_FOUND');const v=await openModal({title:"재전송 요청",message:`${t.requestId} 요청을 새 요청 식별자로 다시 실행합니다.`,confirmLabel:"재전송"});if(!v)return true;const r=await api('/api/request-traces/replay',{method:'POST',body:{key:t.key}});toast(`재전송 ${r.requestId||r.item?.requestId}`);await renderTrace();return true;}

    
  return false;
}
