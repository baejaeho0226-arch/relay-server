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
}
async function renderSupportCenter() {
  const serial = ++supportRenderSerial;
  const { threads } = await api('/api/support');
  if (currentView !== 'support' || serial !== supportRenderSerial) return;
  if (!content.querySelector('#support-workspace')) {
    content.innerHTML = `<div id="support-workspace" class="support-workspace"><div id="support-threads" class="support-threads"></div><section class="support-conversation"><h3 id="support-heading">문의를 선택하세요</h3><div id="support-transcript" class="support-transcript" aria-live="polite"></div><form id="support-reply-form"><label for="support-draft">관리자 답변</label><textarea id="support-draft" maxlength="1000" rows="3" placeholder="답변을 입력하세요"></textarea><button id="support-reply-send" type="submit" class="primary">답변 보내기</button><span id="support-reply-status" role="status"></span></form></section></div>`;
    document.getElementById('support-draft').value = supportDrafts.get(supportSelectedClient) || '';
    document.getElementById('support-draft').addEventListener('input', e => {
      supportDrafts.set(supportSelectedClient, e.target.value);
      supportRequestIds.delete(supportSelectedClient);
    });
    document.getElementById('support-reply-form').addEventListener('submit', sendSupportReply);
  }
  document.getElementById('support-threads').innerHTML = threads.length ? threads.map(t => `<button class="support-thread ${t.clientId === supportSelectedClient ? 'selected' : ''}" data-support-client="${esc(t.clientId)}"><strong>${esc(t.clientId)}</strong><span>${t.online ? '접속 중' : '미접속'}${t.unreadAdmin ? ` · 새 문의 ${t.unreadAdmin}` : ''}</span><small>${esc(t.lastMessage)}</small></button>`).join('') : '<div class="empty">접수된 문의가 없습니다.</div>';
  const draft = document.getElementById('support-draft');
  draft.disabled = !supportSelectedClient || supportReplySending;
  document.getElementById('support-reply-send').disabled = !supportSelectedClient || supportReplySending;
  if (!supportSelectedClient) return;
  const selected = supportSelectedClient;
  const { thread } = await api(`/api/support/${selected}`);
  if (currentView !== 'support' || selected !== supportSelectedClient || serial !== supportRenderSerial) return;
  document.getElementById('support-heading').textContent = `${selected} · ${thread.online ? '접속 중' : '미접속 / 답변 보관'}`;
  const transcript = document.getElementById('support-transcript');
  const lastSeq = thread.messages.length ? thread.messages[thread.messages.length - 1].seq : 0;
  const signature = `${selected}:${lastSeq}`;
  if (transcript.dataset.signature !== signature) {
    const oldScroll = transcript.scrollTop;
    const atBottom = transcript.scrollHeight - oldScroll - transcript.clientHeight < 48;
    const changedClient = transcript.dataset.client !== selected;
    transcript.innerHTML = thread.messages.map(m => `<article class="support-message ${m.role === 'ADMIN' ? 'from-admin' : 'from-client'}"><small>${m.role === 'ADMIN' ? '관리자' : '사용자'} · ${esc(new Date(m.at).toLocaleString())}</small><p>${esc(m.text)}</p></article>`).join('') || '<div class="empty">대화가 없습니다.</div>';
    transcript.dataset.signature = signature;
    transcript.dataset.client = selected;
    transcript.scrollTop = changedClient || atBottom ? transcript.scrollHeight : oldScroll;
    await api(`/api/support/${selected}/read`, { method: 'POST', body: { throughSeq: lastSeq } });
  }
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
    await api(`/api/support/${id}/reply`, { method: 'POST', body: { text, requestId: supportRequestIds.get(id) } });
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
  content.innerHTML = `<div class="panel"><p>차단 해제 시 이전 설치의 CLIENT 등록과 인증을 초기화합니다. APK에서 ‘차단 해제 확인’을 누른 뒤 QR 승인을 다시 진행하세요.</p><div class="table-wrap"><table><thead><tr><th>기존 CLIENT</th><th>차단 시각</th><th>상태</th><th>관리</th></tr></thead><tbody>${blocks.map(b => `<tr><td>${b.clientIds.map(esc).join('<br>') || '등록 삭제됨'}<small class="muted">${esc(b.key.slice(0, 12))}</small></td><td>${esc(new Date(b.blockedAt).toLocaleString())}</td><td>${badge('BLOCKED')}</td><td><button data-reinstall-release="${esc(b.key)}">재설치 차단 해제</button></td></tr>`).join('') || '<tr><td colspan="4">재설치 차단 기기가 없습니다.</td></tr>'}</tbody></table></div></div>`;
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
    toast('차단을 해제했습니다. APK에서 차단 해제 확인을 눌러주세요.');
    if (currentView === 'reinstallblocks') await renderReinstallBlocks();
  } catch (error) { toast(error.message, true); }
});
