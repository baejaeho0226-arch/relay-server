'use strict';

async function serverAction(action, id) {
  const encodedId = encodeURIComponent(id);
  if (action === 'detail') {
    const { server } = await api(`/api/servers/${encodedId}`);
    const clients = server.clientsList.map(c => `<tr><td class="code">${esc(c.id)}</td><td>${badge(c.status)}</td><td>${badge(c.licenseStatus)}</td></tr>`).join('') || "<tr><td colspan=\"3\">앱 기기 없음</td></tr>";
    await openModal({ title: `서버 ${id}`, html: `<div class="kv"><div>별칭</div><div>${esc(server.alias || '-')}</div><div>메모</div><div>${esc(server.note || '-')}</div><div>기기 키</div><div class="code">${esc(server.deviceKey)}</div><div>상태</div><div>${badge(server.status)}</div><div>상태</div><div>${badge(server.health)}</div><div>수용 앱 기기</div><div>${badge(server.acceptState || (server.canAcceptClients ? 'READY' : 'OFFLINE'))}</div><div>실시간 연결 / 저장됨 앱 기기</div><div>${server.clients} / ${server.savedClients}</div><div>왕복 지연</div><div>${server.rttMs >= 0 ? `${server.rttMs} ms` : '-'}</div><div>연결 차단 해제 시각</div><div>${esc(fmtTime(server.kickedUntil))}</div><div>IP</div><div>${esc(server.lastIP || '-')}</div><div>프로토콜 / 버전</div><div>${server.protocolVersion || '-'} / ${esc(server.appVersion || '-')}</div><div>재연결 중</div><div>${server.reconnectCount}</div><div>마지막 확인</div><div>${esc(fmtTime(server.lastSeen))}</div></div><div class="table-wrap"><table><thead><tr><th>앱 기기</th><th>상태</th><th>라이선스</th></tr></thead><tbody>${clients}</tbody></table></div>`, confirmLabel: '닫기' });
    return;
  }

  if (action === 'alias') {
    const { server } = await api(`/api/servers/${encodedId}`);
    const v = await openModal({ title: "서버 별칭", message: `${id} 표시용 별칭입니다. 실제 서버 식별자는 변경되지 않습니다.`, fields: [{ name: 'alias', label: "별칭", value: server.alias || '', placeholder: 'OFFICE-PC-01' }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/servers/${encodedId}/alias`, { method: 'POST', body: v });
    toast("서버 별칭 저장");
    await renderServers();
    return;
  }

  if (action === 'note') {
    const { server } = await api(`/api/servers/${encodedId}`);
    const v = await openModal({ title: "서버 메모", message: `${id} 운영 메모입니다.`, fields: [{ name: 'note', label: "메모", type: 'textarea', value: server.note || '', placeholder: '고객사 / 위치 / 장비 교체 이력 등' }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/servers/${encodedId}/note`, { method: 'POST', body: v });
    toast("서버 메모 저장"); await renderServers(); return;
  }

  if (action === 'delete') {
    const v = await openModal({ title: "서버 삭제", message: `${id}\nSERVER-식별자, HMAC, 고정 실행 바인딩과 종속 설정을 삭제합니다. 연결된 모아플레이는 미배정 상태로 복구됩니다. 같은 EXE가 다시 접속하면 신규 서버 등록으로 처리됩니다.`, danger: true, confirmLabel: "삭제" });
    if (!v) return;
    const r = await api(`/api/servers/${encodedId}`, { method: 'DELETE', body: {} });
    toast(`서버 삭제 · released ${r.releasedClients} · reassigned ${r.reassignedClients}`);
    await renderServers();
    return;
  }

  let body = {};
  if (action === 'kick') {
    const v = await openModal({ title: "서버 연결 차단", message: `${id} 연결을 끊고 60초 동안 재등록을 차단합니다.`, confirmLabel: "연결 차단" });
    if (!v) return;
  } else if (action === 'drain-on') {
    const v = await openModal({ title: "연결 정리 켜짐", message: `${id}에 신규 앱 기기 배정을 중지합니다. 기존 앱 기기는 유지됩니다.`, confirmLabel: '적용' });
    if (!v) return;
  } else if (action === 'disable') {
    const v = await openModal({ title: "서버 비활성화", message: `${id} 서버를 비활성화하고 현재 연결을 종료합니다. 계속하시겠습니까?`, danger: true, confirmLabel: "비활성화" });
    if (!v) return;
  }

  await api(`/api/servers/${encodedId}/${action}`, { method: 'POST', body });
  toast(`서버 ${action}: ${id}`);
  await renderServers();
}

async function clientAction(action, id) {
  const encodedId = encodeURIComponent(id);
  if (action === 'detail') {
    const { client } = await api(`/api/clients/${encodedId}`);
    await openModal({ title: `앱 기기 ${id}`, html: `<div class="kv"><div>별칭</div><div>${esc(client.alias || '-')}</div><div>메모</div><div>${esc(client.note || '-')}</div><div>기기 키</div><div class="code">${esc(client.deviceKey)}</div><div>상태</div><div>${badge(client.status)}</div><div>상태</div><div>${badge(client.health)}</div><div>생체인증</div><div>${badge(client.biometric?.verified ? 'VERIFIED' : (client.biometric?.enrolled ? 'ENROLLED' : 'NONE'))}</div><div>생체인증 등록됨</div><div>${esc(fmtTime(client.biometric?.enrolledAt))}</div><div>마지막 검증됨</div><div>${esc(fmtTime(client.biometric?.verifiedAt))}</div><div>서버</div><div class="code">${esc(client.serverAlias || client.serverId)}${client.serverAlias ? ` [${esc(client.serverId)}]` : ''}</div><div>라이선스</div><div class="code">${esc(client.licenseKey || '-')}</div><div>라이선스 상태</div><div>${badge(client.licenseStatus)}</div><div>만료일</div><div>${esc(fmtTime(client.licenseExpiresAt))}</div><div>연결 차단 해제 시각</div><div>${esc(fmtTime(client.kickedUntil))}</div><div>IP</div><div>${esc(client.lastIP || '-')}</div><div>프로토콜 / 버전</div><div>${client.protocolVersion || '-'} / ${esc(client.appVersion || '-')}</div><div>왕복 지연</div><div>${client.rttMs >= 0 ? `${client.rttMs} ms` : '-'}</div><div>인증 / 전송 / 재연결 중</div><div>${client.authCount} / ${client.sendCount} / ${client.reconnectCount}</div><div>마지막 인증</div><div>${esc(fmtTime(client.lastAuthAt))}</div><div>마지막 확인</div><div>${esc(fmtTime(client.lastSeenAt))}</div></div>`, confirmLabel: '닫기' });
    return;
  }

  if (action === 'auth-recover') {
    const accepted = await openModal({ title: '기기 인증 복구', message: `${id}\n기기 통신 키를 다시 발급합니다. QR 승인, 기기 식별자, 생체인증 등록 및 PC 연결은 유지됩니다. 현재 연결된 모아플레이가 본인 기기인지 확인해주세요.`, confirmLabel: '기기 인증 복구' });
    if (!accepted) return;
    await api('/api/control/security/reset', { method: 'POST', body: { type: 'CLIENT', id } });
    toast('기기 인증 복구를 요청했습니다. 모아플레이에서 자동으로 인증을 이어갑니다.');
    await renderClients();
    return;
  }

  if (action === 'biometric') {
    const { client } = await api(`/api/clients/${encodedId}`);
    const v = await openModal({
      title: "앱 기기 생체인증 초기화",
      message: `${id}\n지문 데이터는 서버에 저장되지 않습니다. 초기화 후 온라인 모아플레이는 Android 시스템 생체인증을 다시 수행합니다.`,
      html: `<div class="biometric-status"><span>현재 상태</span>${badge(client.biometric?.verified ? 'VERIFIED' : (client.biometric?.enrolled ? 'ENROLLED' : 'NONE'))}<span>마지막 인증</span><strong>${esc(fmtTime(client.biometric?.verifiedAt))}</strong></div>`,
      confirmLabel: '초기화', danger: true
    });
    if (!v) return;
    await api(`/api/clients/${encodedId}/biometric/reset`, { method: 'POST', body: {} });
    toast("앱 기기 생체인증 초기화 완료");
    if (currentView === 'clientbiometrics') await renderClientBiometrics();
    else await renderClients();
    return;
  }

  if (action === 'alias') {
    const { client } = await api(`/api/clients/${encodedId}`);
    const v = await openModal({ title: "앱 기기 별칭", message: `${id} 표시용 별칭입니다. 실제 앱 식별자는 변경되지 않습니다.`, fields: [{ name: 'alias', label: "별칭", value: client.alias || '', placeholder: "GALAXY-테스트" }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/alias`, { method: 'POST', body: v });
    toast("앱 기기 별칭 저장");
    await renderClients();
    return;
  }

  if (action === 'note') {
    const { client } = await api(`/api/clients/${encodedId}`);
    const v = await openModal({ title: "앱 기기 메모", message: `${id} 운영 메모입니다.`, fields: [{ name: 'note', label: "메모", type: 'textarea', value: client.note || '', placeholder: '사용자 / 장비 / 교체 이력 등' }], confirmLabel: '저장' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/note`, { method: 'POST', body: v });
    toast("앱 기기 메모 저장"); await renderClients(); return;
  }

  if (action === 'notice') {
    const v = await openModal({ title: "앱 기기 공지", message: id, fields: [{ name: 'message', label: '공지', type: 'textarea' }], confirmLabel: '전송' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/notice`, { method: 'POST', body: v });
    toast('공지 전송 완료');
    return;
  }

  if (action === 'delete') {
    const v = await openModal({ title: "앱 기기 삭제", message: `${id}\nCLIENT-식별자와 QR, 생체인증 상태, 라이선스 결합, 실행 바인딩 및 종속 데이터를 삭제합니다. 모아플레이 재접속 시 신규 QR 승인부터 다시 진행됩니다.`, danger: true, confirmLabel: "삭제" });
    if (!v) return;
    await api(`/api/clients/${encodedId}`, { method: 'DELETE', body: {} });
    toast(`앱 기기 삭제: ${id}`);
    await renderClients();
    return;
  }

  if (action === 'move') {
    const [{ client }, { servers }] = await Promise.all([api(`/api/clients/${encodedId}`), api('/api/servers')]);
    const eligible = servers.filter(s => s.id !== client.serverId && s.canAcceptClients);
    if (!eligible.length) {
      toast("이동 가능한 온라인 서버가 없습니다.", true);
      return;
    }
    const v = await openModal({ title: "앱 기기 이동", message: `${id}
온라인이며 연결 정리/비활성화/연결 차단 상태가 아닌 서버만 표시됩니다.`, fields: [{ name: 'serverId', label: "새 서버", type: 'select', options: eligible.map(s => ({ value: s.id, label: `${s.alias ? s.alias + ' · ' : ''}${s.id} · ${s.health} · ${s.clients}/${s.savedClients}` })) }], confirmLabel: '이동' });
    if (!v) return;
    await api(`/api/clients/${encodedId}/move`, { method: 'POST', body: v });
    toast("앱 기기 이동 완료");
    await renderClients();
    return;
  }

  let body = {};
  if (action === 'kick') {
    const v = await openModal({ title: "앱 기기 연결 차단", message: `${id} 연결을 끊고 60초 동안 재접속을 차단합니다.`, confirmLabel: "연결 차단" });
    if (!v) return;
  } else if (action === 'disable') {
    const v = await openModal({ title: "앱 기기 비활성화", message: `${id} 앱 기기를 비활성화하고 현재 연결을 종료합니다. 계속하시겠습니까?`, danger: true, confirmLabel: "비활성화" });
    if (!v) return;
  }

  await api(`/api/clients/${encodedId}/${action}`, { method: 'POST', body });
  toast(`앱 기기 ${action}: ${id}`);
  await renderClients();
}

