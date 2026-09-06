'use strict';

// EVENTS / ACTIONS / STARTUP

content.addEventListener('click', async event => {
  try {
    for (const handle of [handleAccessAction, handleOperationsAction, handleTrafficAction, handleDevicesAction, handlePolicyAction, handleSystemAction]) if (await handle(event)) return;
  } catch (error) { toast(readableApiError(error.message), true); }
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

async function backupAction(action, file) {
  if (action === 'verify') {
    const { verification: v } = await api(`/api/backups/${encodeURIComponent(file)}/verify`);
    const issues = [...(v.errors || []).map(x=>({...x,severity:'ERROR'})), ...(v.warnings || []).map(x=>({...x,severity:'WARNING'}))];
    await openModal({ title: `백업 검증 // ${file}`, html: `<div class="kv"><div>결과</div><div>${badge(v.ok ? 'GOOD' : 'ERROR')}</div><div>서버</div><div>${v.stats.servers || 0}</div><div>앱 기기</div><div>${v.stats.clients || 0}</div><div>라이선스</div><div>${v.stats.licenses || 0}</div><div>오류</div><div>${(v.errors || []).length}</div><div>경고</div><div>${(v.warnings || []).length}</div></div>${issues.length ? `<div class="integrity-list">${issues.map(x=>`<div class="integrity-row">${badge(x.severity)}<span class="code">${esc(x.code)}</span><span>${esc(x.message)}</span><span class="code">${esc(x.entity || '-')}</span></div>`).join('')}</div>` : "<div class=\"integrity-ok\">백업 구조 검증을 통과했습니다.</div>"}`, confirmLabel: '닫기' });
    return;
  }
  const label = action === 'restore' ? 'Restore' : 'Delete';
  const v = await openModal({ title: `백업 ${label}`, message: `${file}\n${action === 'restore' ? 'DB 상태를 이 Backup으로 복원하며 연결이 재설정될 수 있습니다.' : '이 Backup 파일을 삭제합니다.'}`, danger: true, confirmLabel: label.toUpperCase() });
  if (!v) return;
  if (action === 'restore') { const verify=await api(`/api/backups/${encodeURIComponent(file)}/verify`); if(!verify.verification.ok) throw new Error('BACKUP_VERIFY_FAILED'); }
  await api(`/api/backups/${encodeURIComponent(file)}/${action}`, { method: 'POST', body: {} });
  toast(`백업 ${action} 완료`); renderBackups();
}

async function applyVersion() {
  const protocol = Number(document.getElementById('version-protocol').value);
  const serverVersion = document.getElementById('version-server').value.trim();
  const clientVersion = document.getElementById('version-client').value.trim();
  const v = await openModal({ title: "버전 정책 적용", message: `프로토콜 >= ${protocol} // 서버 >= ${serverVersion} // 앱 기기 >= ${clientVersion}. 기준 미달 연결이 종료될 수 있습니다.`, danger: true, confirmLabel: '적용' });
  if (!v) return;
  await api('/api/system/version', { method: 'POST', body: { protocol, serverVersion, clientVersion } });
  toast("버전 정책 적용 완료"); renderSystem();
}

async function createSchedule() {
  const now = new Date(Date.now() + 3600000);
  const later = new Date(Date.now() + 7200000);
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const v = await openModal({ title: "점검 예약", fields: [
    { name: 'start', label: '시작', type: 'datetime-local', value: local(now) },
    { name: 'end', label: '종료', type: 'datetime-local', value: local(later) },
    { name: 'message', label: '공지 메시지', value: 'Scheduled maintenance' },
    { name: 'autoDrain', label: "자동 연결 정리", type: 'select', options: [{value:'1',label:"켜짐 - 예약 전 연결 정리 시작"},{value:'0',label:"꺼짐"}] },
    { name: 'drainLeadMinutes', label: "연결 정리 시작 전 시간(분)", type: 'number', value: '15' },
    { name: 'forceStart', label: "앱 기기 남아도 예약 시각에 점검 시작", type: 'select', options: [{value:'0',label:"꺼짐 - 연결이 모두 종료될 때까지 대기"},{value:'1',label:"켜짐 - 예약 시각 강제 시작"}] }
  ], confirmLabel: '예약' });
  if (!v) return;
  await api('/api/system/maintenance/schedule', { method: 'POST', body: { startAt: new Date(v.start).getTime(), endAt: new Date(v.end).getTime(), message: v.message, autoDrain: v.autoDrain === '1', drainLeadMinutes: Number(v.drainLeadMinutes)||0, forceStart: v.forceStart === '1' } });
  toast("점검 예약 완료"); renderSystem();
}

async function sendNoticeAll() {
  const v = await openModal({ title: "전체 공지", fields: [{ name: 'message', label: '공지', type: 'textarea' }], confirmLabel: '전송' });
  if (!v) return;
  const r = await api('/api/system/notice', { method: 'POST', body: v });
  toast(`${r.count}개 앱 기기에 전송 완료`);
}


