'use strict';
async function handleSystemAction(event) {
    if (event.target.id === 'license-search-btn') {
      licenseQuery = document.getElementById('license-search').value.trim();
      licenseStatus = document.getElementById('license-status').value;
      licenseExpiry = document.getElementById('license-expiry').value;
      renderLicenses(); return true;
    }
    if (event.target.id === 'license-clear-selection') { selectedLicenses.clear(); await renderLicenses(); return true; }
    if (event.target.id === 'license-bulk-btn') { await bulkLicense(); return true; }
    if (event.target.id === 'license-check-all') {
      document.querySelectorAll('.license-check').forEach(x => { x.checked = event.target.checked; if (x.checked) selectedLicenses.add(x.dataset.key); else selectedLicenses.delete(x.dataset.key); });
      updateLicenseSelection();
      return true;
    }
    if (event.target.classList.contains('license-check')) {
      if (event.target.checked) selectedLicenses.add(event.target.dataset.key); else selectedLicenses.delete(event.target.dataset.key);
      updateLicenseSelection();
      return true;
    }
    if (event.target.id === 'notification-read-all-btn') {
      await api('/api/notifications/read-all', { method: 'POST', body: {} });
      await updateNotificationBadge();
      await renderNotifications();
      return true;
    }
    if (event.target.id === 'notification-clear-btn') {
      const v = await openModal({ title: "알림 지우기", message: "현재 알림 목록을 모두 지웁니다. 감사 기록은 삭제되지 않습니다.", danger: true, confirmLabel: '지우기' });
      if (!v) return true;
      await api('/api/notifications/clear', { method: 'POST', body: {} });
      await updateNotificationBadge();
      await renderNotifications();
      return true;
    }

    if (event.target.id === 'audit-search-btn') {
      auditQuery = document.getElementById('audit-search').value.trim();
      auditType = document.getElementById('audit-type').value;
      renderAudit(); return true;
    }
    if (event.target.id === 'backup-create-btn') {
      const r = await api('/api/backups/create', { method: 'POST', body: {} }); toast(`백업 생성: ${r.file}`); renderBackups(); return true;
    }
    if (event.target.id === 'service-start-btn') { await api('/api/system/service/start', { method: 'POST', body: {} }); toast("서비스가 시작되었습니다."); renderSystem(); return true; }
    if (event.target.id === 'service-stop-btn') {
      const v = await openModal({ title: "서비스 종료", message: "서버·앱 등록 목록, QR 라이선스, 인증, 실행 세션, 기기 배정, 대화와 대기 요청을 삭제하고 서비스를 종료합니다. 관리자 로그인과 재시작, 운영 설정·배포 파일, 재설치 차단 기록은 유지됩니다.", danger: true, confirmLabel: '중지' });
      if (!v) return true; await api('/api/system/service/stop', { method: 'POST', body: {} }); toast("서비스가 종료되었습니다."); renderSystem(); return true;
    }
    if (event.target.id === 'maint-on-btn') { await api('/api/system/maintenance/on', { method: 'POST', body: {} }); toast("점검 켜짐"); renderSystem(); return true; }
    if (event.target.id === 'maint-off-btn') { await api('/api/system/maintenance/off', { method: 'POST', body: {} }); toast("점검 꺼짐"); renderSystem(); return true; }
    if (event.target.id === 'version-apply-btn') { await applyVersion(); return true; }
    if (event.target.id === 'schedule-create-btn') { await createSchedule(); return true; }
    if (event.target.id === 'schedule-clear-btn') { await api('/api/system/maintenance/clear', { method: 'POST', body: {} }); toast("점검 예약 제거"); renderSystem(); return true; }
    if (event.target.id === 'notice-all-btn') { await sendNoticeAll(); return true; }
  
  return false;
}
