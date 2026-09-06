'use strict';
let supportSelectedClient = '';
const supportDrafts = new Map();
const supportRequestIds = new Map();
let supportReplySending = false;
let supportRenderSerial = 0;
function resetSupportUiState() {
  supportSelectedClient = '';
  supportDrafts.clear();
  supportRequestIds.clear();
  supportRenderSerial++;
  supportHistory.clear();
  supportAvailabilitySending = false;
}
const supportHistory = new Map();
let supportAvailabilitySending = false;
function supportStatusText(status) { return status === 'CLOSED' ? '상담 종료' : status === 'DELETED' ? '대화 삭제됨' : '상담 중'; }
function renderSupportAvailability(settings) {
  const group = document.getElementById('support-availability');
  if (!group) return;
  for (const button of group.querySelectorAll('[data-support-availability]')) {
    const selected = (button.dataset.supportAvailability === 'ONLINE') === (settings.adminOnline === true);
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = supportAvailabilitySending;
  }
  document.getElementById('support-availability-status').textContent = settings.adminOnline
    ? '온라인 · 모든 APK에 상담 가능으로 표시됩니다.'
    : '오프라인 · 모든 APK에서 문의를 남길 수 있습니다.';
}
async function setSupportAvailability(mode) {
  if (supportAvailabilitySending) return;
  supportAvailabilitySending = true;
  supportRenderSerial++; // Discard a GET that started before this choice.
  const buttons = content.querySelectorAll('[data-support-availability]');
  buttons.forEach(button => { button.disabled = true; });
  try {
    const { settings } = await api('/api/support/availability', { method: 'POST', body: { mode } });
    supportRenderSerial++;
    if (currentView === 'support') renderSupportAvailability(settings);
    toast(mode === 'ONLINE' ? '전체 상담 상태를 온라인으로 변경했습니다.' : '전체 상담 상태를 오프라인으로 변경했습니다.');
  } catch (error) { toast(error.message, true); }
  finally {
    supportAvailabilitySending = false;
    buttons.forEach(button => { button.disabled = false; });
    if (currentView === 'support') await renderSupportCenter();
  }
}
function supportSettingsForm(settings) {
  return `<details class="panel support-settings"><summary>상담 안내 설정</summary><form id="support-settings-form">${[['hours', '상담시간 (한국 시간 등 기준 포함)'], ['greeting', '인사말'], ['responseGuide', '답변 안내']].map(([key,label]) => `<label>${label}<input name="${key}" maxlength="160" required value="${esc(settings[key] || '')}"></label>`).join('')}<button type="submit">안내 저장</button><span id="support-settings-status" role="status"></span></form></details>`;
}
async function renderSupportCenter() {
  const serial = ++supportRenderSerial;
  const { threads, settings = {} } = await api('/api/support');
  if (currentView !== 'support' || serial !== supportRenderSerial) return;
  if (!content.querySelector('#support-workspace')) {
    content.innerHTML = `<section id="support-availability" class="panel support-availability"><div><h3>전체 상담 상태</h3><p>선택한 상태가 모든 상담에 적용됩니다. 다른 메뉴로 이동하거나 웹을 닫아도 유지됩니다.</p></div><div class="support-availability-options" role="group" aria-label="전체 상담 상태"><button type="button" data-support-availability="ONLINE" aria-pressed="false">온라인</button><button type="button" data-support-availability="OFFLINE" aria-pressed="false">오프라인</button></div><p id="support-availability-status" role="status"></p></section>${supportSettingsForm(settings)}<div id="support-workspace" class="support-workspace"><div id="support-threads" class="support-threads"></div><section class="support-conversation"><h3 id="support-heading">문의를 선택하세요</h3><div id="support-device-info" class="support-device-info"></div><div class="support-room-actions"><button id="support-close-room" type="button">상담 종료 / 나가기</button><button id="support-reopen-room" type="button">상담 다시 열기</button><button id="support-delete-room" type="button" class="danger">대화 영구 삭제</button></div><button id="support-history-more" type="button" hidden>이전 대화 불러오기</button><div id="support-transcript" class="support-transcript" aria-live="polite"></div><form id="support-reply-form"><label for="support-draft">관리자 답변</label><textarea id="support-draft" maxlength="1000" rows="3" placeholder="답변을 입력하세요"></textarea><button id="support-reply-send" type="submit" class="primary">답변 보내기</button><span id="support-reply-status" role="status"></span></form></section></div>`;
    document.getElementById('support-draft').value = supportDrafts.get(supportSelectedClient) || '';
    document.getElementById('support-draft').addEventListener('input', e => {
      supportDrafts.set(supportSelectedClient, e.target.value); supportRequestIds.delete(supportSelectedClient);
    });
    document.getElementById('support-reply-form').addEventListener('submit', sendSupportReply);
    document.getElementById('support-settings-form').addEventListener('submit', async e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try { await api('/api/support/settings', { method: 'POST', body }); document.getElementById('support-settings-status').textContent = 'APK 상담 안내에 반영했습니다.'; }
      catch (error) { toast(error.message, true); }
    });
    for (const button of content.querySelectorAll('[data-support-availability]'))
      button.addEventListener('click', () => setSupportAvailability(button.dataset.supportAvailability));
    for (const action of ['close', 'reopen', 'delete']) document.getElementById(`support-${action}-room`).addEventListener('click', () => changeSupportRoom(action));
    document.getElementById('support-history-more').addEventListener('click', loadOlderSupport);
  }
  if (!supportAvailabilitySending) renderSupportAvailability(settings);
  document.getElementById('support-threads').innerHTML = threads.length ? threads.map(t => `<button class="support-thread ${t.clientId === supportSelectedClient ? 'selected' : ''}" data-support-client="${esc(t.clientId)}"><strong>상담 ${esc(t.clientId)}</strong><span>${esc(t.device && (t.device.model || t.device.product) || '기기 정보 대기')} · ${supportStatusText(t.status)}</span><span>${t.online ? '접속 중' : '미접속'}${t.unreadAdmin ? ` · 새 문의 ${t.unreadAdmin}` : ''}</span><small>${esc(t.lastMessage)}</small></button>`).join('') : '<div class="empty">접수된 문의가 없습니다.</div>';
  const draft = document.getElementById('support-draft');
  draft.disabled = !supportSelectedClient || supportReplySending;
  document.getElementById('support-reply-send').disabled = draft.disabled;
  for (const action of ['close', 'reopen', 'delete']) document.getElementById(`support-${action}-room`).disabled = !supportSelectedClient || supportReplySending;
  if (!supportSelectedClient) return;
  const selected = supportSelectedClient;
  const { thread } = await api(`/api/support/${selected}`);
  if (currentView !== 'support' || selected !== supportSelectedClient || serial !== supportRenderSerial) return;
  let cached = supportHistory.get(selected);
  const gap = cached && cached.messages.length && thread.messages.length && thread.messages[0].seq > cached.messages.at(-1).seq + 1;
  if (!cached || cached.epoch !== thread.epoch || gap) cached = { epoch: thread.epoch, messages: [], hasMore: thread.hasMore };
  const wasEmpty = !cached.messages.length;
  const messages = new Map(cached.messages.map(m => [m.seq, m]));
  for (const m of thread.messages) messages.set(m.seq, m);
  Object.assign(cached, { revision: thread.revision, status: thread.status, messages: [...messages.values()].sort((a,b) => a.seq-b.seq) });
  if (wasEmpty) cached.hasMore = thread.hasMore;
  supportHistory.set(selected, cached);
  document.getElementById('support-heading').textContent = `상담 ${selected} · ${supportStatusText(thread.status)} · ${thread.online ? '접속 중' : '미접속 / 답변 보관'}`;
  const d = thread.device || {};
  document.getElementById('support-device-info').innerHTML = `<details><summary>휴대전화 정보 · 고정 상담번호</summary><dl>${[['고정 상담번호', selected], ['현재 CLIENT', thread.currentClientId], ['제조사', d.manufacturer], ['제품명', d.product], ['모델명', d.model], ['OS', d.os], ['전화번호', d.phone || d.phoneStatus], ['시리얼', d.serial || d.serialStatus], ['IMEI', d.imei || d.imeiStatus]].map(([k,v]) => `<dt>${k}</dt><dd>${esc(v || '미제공')}</dd>`).join('')}</dl><p>번호·모델명은 표시용 정보입니다. 대화는 검증된 설치 정보에 연결됩니다.</p></details>`;
  draft.disabled = supportReplySending || thread.status !== 'OPEN';
  document.getElementById('support-reply-send').disabled = draft.disabled;
  document.getElementById('support-close-room').hidden = thread.status !== 'OPEN';
  document.getElementById('support-reopen-room').hidden = thread.status !== 'CLOSED';
  document.getElementById('support-delete-room').disabled = supportReplySending || thread.status === 'DELETED';
  renderSupportMessages(selected);
  const lastSeq = thread.messages.length ? thread.messages.at(-1).seq : 0;
  if (lastSeq) await api(`/api/support/${selected}/read`, { method: 'POST', body: { throughSeq: lastSeq, revision: thread.revision } });
}
function renderSupportMessages(selected, prepend = false) {
  const cached = supportHistory.get(selected); if (!cached) return;
  const transcript = document.getElementById('support-transcript');
  const signature = `${selected}:${cached.epoch}:${cached.messages.length}:${cached.messages.at(-1)?.seq || 0}`;
  document.getElementById('support-history-more').hidden = !cached.hasMore;
  if (transcript.dataset.signature === signature) return;
  const oldScroll = transcript.scrollTop, oldHeight = transcript.scrollHeight;
  const atBottom = oldHeight - oldScroll - transcript.clientHeight < 48;
  const changedClient = transcript.dataset.client !== selected;
  transcript.innerHTML = cached.messages.map(m => `<article class="support-message ${m.role === 'SYSTEM' ? 'from-system' : m.role === 'ADMIN' ? 'from-admin' : 'from-client'}"><small>${m.role === 'SYSTEM' ? '상담 안내' : m.role === 'ADMIN' ? '관리자' : '사용자'} · ${esc(new Date(m.at).toLocaleString())}</small><p>${esc(m.text)}</p></article>`).join('') || '<div class="empty">대화가 없습니다.</div>';
  transcript.dataset.signature = signature; transcript.dataset.client = selected;
  transcript.scrollTop = prepend ? oldScroll + transcript.scrollHeight - oldHeight : changedClient || atBottom ? transcript.scrollHeight : oldScroll;
}
async function loadOlderSupport() {
  const id = supportSelectedClient, cached = supportHistory.get(id);
  if (!cached || !cached.hasMore) return;
  const button = document.getElementById('support-history-more'); button.disabled = true;
  try {
    const { thread } = await api(`/api/support/${id}?before=${cached.messages[0]?.seq || 0}`);
    if (currentView !== 'support' || id !== supportSelectedClient) return;
    if (cached.epoch !== thread.epoch) { supportHistory.delete(id); await renderSupportCenter(); return; }
    const rows = new Map([...thread.messages, ...cached.messages].map(m => [m.seq,m]));
    cached.messages = [...rows.values()].sort((a,b) => a.seq-b.seq); cached.hasMore = thread.hasMore;
    renderSupportMessages(id, true);
  } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
}
async function changeSupportRoom(action) {
  const id = supportSelectedClient, cached = supportHistory.get(id);
  if (!id || !cached || supportReplySending) return;
  const label = { close: '상담 종료 / 나가기', reopen: '상담 다시 열기', delete: '대화 영구 삭제' }[action];
  try {
    if (!await openModal({ title: label, message: action === 'delete' ? '이 기기의 대화 내용을 서버에서 삭제하고 APK에서도 지웁니다. 고정 상담번호는 유지됩니다. 삭제한 대화는 되돌릴 수 없습니다.' : action === 'close' ? '상담을 종료합니다. 기록은 보관되며 사용자가 새 문의를 보내면 다시 열립니다.' : '이 상담을 다시 열겠습니까?', confirmLabel: label })) return;
    supportReplySending = true; supportRenderSerial++;
    await api(`/api/support/${id}/${action}`, { method: 'POST', body: { revision: cached.revision } });
    supportHistory.delete(id);
    if (action === 'delete') {
      supportDrafts.delete(id); supportRequestIds.delete(id); supportSelectedClient = '';
      if (currentView === 'support') content.innerHTML = '';
    }
    toast(action === 'delete' ? '서버와 APK의 대화를 삭제했습니다.' : '상담 상태를 변경했습니다.');
  } catch (error) { toast(error.message, true); }
  finally { supportReplySending = false; if (currentView === 'support') await renderSupportCenter(); }
}
async function sendSupportReply(event) {
  event.preventDefault();
  const id = supportSelectedClient;
  const draft = document.getElementById('support-draft');
  const text = draft.value;
  if (!id || !text.trim() || supportReplySending) return;
  if (!supportRequestIds.has(id)) supportRequestIds.set(id, (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`));
  supportReplySending = true;
  draft.disabled = true;
  document.getElementById('support-reply-send').disabled = true;
  try {
    await api(`/api/support/${id}/reply`, { method: 'POST', body: { text, requestId: supportRequestIds.get(id), revision: supportHistory.get(id)?.revision } });
    supportDrafts.delete(id);
    supportRequestIds.delete(id);
    if (currentView === 'support' && supportSelectedClient === id) {
      draft.value = '';
      document.getElementById('support-reply-status').textContent = '답변을 보냈습니다.';
    }
  } catch (error) { toast(error.message, true); }
  finally { supportReplySending = false; if (currentView === 'support') await renderSupportCenter(); }
}
async function renderReinstallBlocks() {
  const { blocks } = await api('/api/reinstall-blocks');
  if (currentView !== 'reinstallblocks') return;
  content.innerHTML = `<div class="panel"><p>차단 해제 시 이전 설치의 CLIENT 등록과 인증을 초기화합니다. APK를 켜두면 차단 해제를 자동으로 확인하고 알림을 보냅니다. 이후 QR 승인을 다시 진행하세요.</p><div class="table-wrap"><table><thead><tr><th>기존 CLIENT</th><th>차단 시각</th><th>상태</th><th>관리</th></tr></thead><tbody>${blocks.map(b => `<tr><td>${b.clientIds.map(esc).join('<br>') || '등록 삭제됨'}<small class="muted">${esc(b.key.slice(0, 12))}</small></td><td>${esc(new Date(b.blockedAt).toLocaleString())}</td><td>${badge('BLOCKED')}</td><td><button data-reinstall-release="${esc(b.key)}">재설치 차단 해제</button></td></tr>`).join('') || '<tr><td colspan="4">재설치 차단 기기가 없습니다.</td></tr>'}</tbody></table></div></div>`;
}
content.addEventListener('click', async event => {
  const selected = event.target.closest('[data-support-client]');
  if (selected && !supportReplySending) {
    supportSelectedClient = selected.dataset.supportClient;
    const input = document.getElementById('support-draft');
    if (input) input.value = supportDrafts.get(supportSelectedClient) || '';
    try { await renderSupportCenter(); } catch (error) { toast(error.message, true); }
  }
  const release = event.target.closest('[data-reinstall-release]');
  if (!release) return;
  try {
    const accepted = await openModal({ title: '재설치 차단 해제', message: '이 기기의 이전 CLIENT 등록·인증을 초기화하고 재설치를 허용합니다. 이후 새 QR 승인과 지문 인증이 필요합니다.', confirmLabel: '차단 해제' });
    if (!accepted) return;
    await api(`/api/reinstall-blocks/${release.dataset.reinstallRelease}/release`, { method: 'POST', body: {} });
    toast('차단을 해제했습니다. APK가 자동 확인 후 알림을 보냅니다.');
    if (currentView === 'reinstallblocks') await renderReinstallBlocks();
  } catch (error) { toast(error.message, true); }
});
