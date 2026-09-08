'use strict';

async function licenseAction(action, key) {
  let body = {};
  if (action === 'tags') {
    const { licenses } = await api(`/api/licenses?query=${encodeURIComponent(key)}&status=ALL&expiry=ALL`);
    const current = licenses.find(x => x.key === key);
    const v = await openModal({ title: "라이선스 태그", message: key, fields: [{ name: 'tags', label: "태그", value: current ? (current.tags || []).join(', ') : '', placeholder: "우수고객, 고객그룹, 테스트" }], confirmLabel: '저장' });
    if (!v) return;
    const tags = String(v.tags || '').split(',').map(x => x.trim()).filter(Boolean);
    await api(`/api/licenses/${encodeURIComponent(key)}/tags`, { method: 'POST', body: { tags } });
    toast("라이선스 태그 저장");
    renderLicenses();
    return;
  }
  if (action === 'extend') {
    const v = await openModal({ title: "라이선스 연장", message: key, fields: [{ name: 'days', label: '추가 일수', type: 'number', value: '30' }], confirmLabel: '연장' }); if (!v) return; body.days = Number(v.days);
  } else if (action === 'transfer') {
    const v = await openModal({ title: "라이선스 이전", message: key, fields: [{ name: 'clientId', label: "대상 앱 식별자" }], confirmLabel: '이전' }); if (!v) return; body = v;
  } else if (action === 'delete') {
    const v = await openModal({ title: "라이선스 삭제", message: `${key}\n이 라이선스를 삭제합니다. 삭제 후에는 복구할 수 없습니다.`, danger: true, confirmLabel: '삭제' }); if (!v) return;
  } else {
    const v = await openModal({ title: `라이선스 ${action}`, message: `${key}\n계속하시겠습니까?`, danger: action === 'reissue', confirmLabel: '실행' }); if (!v) return;
  }
  const r = await api(`/api/licenses/${encodeURIComponent(key)}/${action}`, { method: 'POST', body });
  if (action === 'reissue') await openModal({ title: "재발급 완료", html: `<div class="kv"><div>이전 항목</div><div class="code">${esc(r.oldKey)}</div><div>새 항목</div><div class="code">${esc(r.newKey)}</div></div>`, confirmLabel: '닫기' });
  else toast(`라이선스 ${action} 완료`);
  renderLicenses();
}

const LICENSE_ACTION_LABELS = Object.freeze({ extend: '기간 연장', unbind: '기기 연결 해제',
  suspend: '이용 정지', resume: '이용 재개', transfer: '다른 기기로 이전', tags: '태그 변경',
  reissue: '재발급', delete: '삭제' });

async function bulkLicense() {
  const keys = [...selectedLicenses];
  if (!keys.length) { toast('선택한 QR 라이선스가 없습니다.', true); return; }
  const options = Object.entries(LICENSE_ACTION_LABELS)
    .filter(([action]) => action!=='extend'&&(roleIsAdmin() || !['reissue', 'delete'].includes(action)))
    .map(([value, label]) => ({ value, label }));
  const choice = await openModal({ title: `QR 라이선스 ${keys.length}개 선택`,
    fields: [{ name: 'action', label: '선택 작업', type: 'select', options }], confirmLabel: '다음' });
  if (!choice) return;
  const action = choice.action, body = { action, keys };
  let fields = [], message = `선택한 QR 라이선스 ${keys.length}개에 적용합니다.`;
  if (action === 'extend') fields = [{ name: 'days', label: '추가 이용 일수', type: 'number', value: '30' }];
  if (action === 'tags') {
    fields = [{ name: 'tags', label: '태그 (쉼표로 구분)', placeholder: '우수고객, 테스트' }];
    message += ' 기존 태그를 입력한 태그로 바꿉니다. 비우면 모두 제거합니다.';
  }
  if (action === 'transfer') {
    const { clients } = await api('/api/clients');
    if (!clients.length) { toast('이전할 앱 기기가 없습니다.', true); return; }
    fields = keys.map((key, i) => ({ name: `target${i}`, label: `QR-${key.slice(-8)} 이전 대상`,
      type: 'select', value: '', options: [{ value: '', label: '대상 기기를 선택하세요' },
        ...clients.map(c => ({ value: c.id, label: `${c.alias || '앱 기기'} · ${c.id}` }))] }));
    message = '라이선스마다 서로 다른 기기를 선택하세요. 이미 다른 라이선스가 연결된 기기로는 이전할 수 없습니다.';
  }
  if (action === 'reissue') message += ' 기존 키는 폐기되고 새 키가 발급됩니다. 앱은 다시 인증해야 합니다.';
  if (action === 'delete') message += ' 연결된 앱의 인증도 해제되며 삭제한 라이선스는 복구할 수 없습니다.';
  if (action === 'unbind' || action === 'suspend') message += ' 연결된 앱의 현재 이용 인증이 해제됩니다.';
  const values = await openModal({ title: LICENSE_ACTION_LABELS[action], message, fields,
    danger: ['delete', 'reissue', 'suspend', 'unbind'].includes(action), confirmLabel: '선택 항목에 적용' });
  if (!values) return;
  if (action === 'extend') {
    body.days = Number(values.days);
    if (!Number.isInteger(body.days) || body.days < 1 || body.days > 36500) throw new Error('연장 일수는 1~36,500 사이의 정수로 입력하세요.');
  }
  if (action === 'tags') body.tags = String(values.tags || '').split(',').map(x => x.trim()).filter(Boolean);
  if (action === 'transfer') {
    body.transfers = keys.map((key, i) => ({ key, clientId: values[`target${i}`] }));
    if (body.transfers.some(x => !x.clientId) || new Set(body.transfers.map(x => x.clientId)).size !== keys.length)
      throw new Error('각 라이선스의 이전 대상을 서로 다른 기기로 선택하세요.');
  }
  const r = await api('/api/licenses/bulk', { method: 'POST', body });
  for (const item of r.results || []) if (item.ok) selectedLicenses.delete(item.key);
  toast(`${r.total}개 중 ${r.success}개 완료${r.failed ? ` · ${r.failed}개 실패` : ''}`, !!r.failed);
  await renderLicenses();
  if (r.failed || action === 'reissue') await openModal({ title: '선택 작업 결과',
    html: `<div class="table-wrap"><table><thead><tr><th>QR 라이선스</th><th>처리 결과</th></tr></thead><tbody>${(r.results || []).map(item =>
      `<tr><td class="code">QR-${esc(item.key.slice(-8))}</td><td>${item.ok ? (item.newKey ? `새 라이선스: <code>${esc(item.newKey)}</code>` : '완료') : esc(readableApiError(item.reason))}</td></tr>`).join('')}</tbody></table></div>`,
    message: r.failed ? '실패한 항목은 선택 상태로 남겨 두었습니다.' : '재발급된 키를 확인하세요.', confirmLabel: '닫기' });
}

