'use strict';
let qrRenderSerial=0,qrMemberQuery='';

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('QR_IMAGE_READ_FAILED'));
    reader.readAsDataURL(file);
  });
}

async function renderQrAuth() {
  if(currentView!=='qrauth')return;const serial=++qrRenderSerial;
  if (!roleIsAdmin()) { content.innerHTML = "<div class=\"empty\">접근 권한 없음</div>"; return; }
  const { requests, summary } = await api('/api/qr-auth');
  if(serial!==qrRenderSerial||currentView!=='qrauth')return;
  const scanned = qrScanResult && qrScanResult.request ? qrScanResult.request : null;
  const wallet=scanned?.purpose==='WALLET';
  const selectedFileName = qrSelectedFile ? `${qrSelectedFile.name} · ${fmtBytes(qrSelectedFile.size)}` : '모아플레이 화면을 촬영하거나 전달받은 사진을 올리세요.';
  const selectedPreview = qrSelectedPreviewDataUrl
    ? `<img id="qr-auth-preview" src="${esc(qrSelectedPreviewDataUrl)}" alt="선택한 QR 사진 미리보기">`
    : '<img id="qr-auth-preview" class="hidden" alt="선택한 QR 사진 미리보기">';
  const secretWarning = summary.durableSigningSecret ? '' : "<div class=\"warning-box\">QR_APPROVAL_SECRET가 설정되지 않아 현재 프로세스의 임시 서명키를 사용 중입니다. 운영·HA 배포 전에 모든 중계 서버에 같은 전용 비밀값을 설정하세요.</div>";
  const scannedCard = scanned ? `<div class="qr-approval-card">
    <div class="qr-approval-icon">✓</div>
    <div class="qr-approval-main"><span class="small-note">요청 서명 검증 완료</span><strong>${wallet?'잔액 충전 · '+esc(scanned.memberHandle||scanned.memberName):'출입증 · '+esc(scanned.memberHandle||scanned.clientId)}</strong><div class="code">${esc(scanned.requestId)}</div><div class="qr-approval-meta"><span>만료 ${esc(fmtTime(scanned.expiresAt))}</span><span>${wallet?'회원 '+esc(scanned.accountId):'기기 '+esc(scanned.clientId)}</span><span>${wallet?'충전 잔액은 기간 없음':'출입증은 기간 없음'}</span></div></div>
    <div class="qr-approval-actions"><button id="qr-auth-approve-btn" class="primary">${wallet?'잔액 충전':'출입증 승인'}</button><button id="qr-auth-clear-btn" class="ghost">지우기</button></div>
  </div>` : '<div class="qr-scan-empty">QR 사진을 선택하면 서버가 이미지, 서명, 일회용 토큰과 기기 결합을 모두 검증합니다.</div>';
  const query=qrMemberQuery.trim().toLowerCase();const matches=requests.filter(item=>!query||[item.memberHandle,item.memberName,item.clientId,item.requestId].some(value=>String(value||'').toLowerCase().includes(query)));
  const rows = matches.map(item => `<tr><td>${item.purpose==='WALLET'?'잔액 충전':'출입증'}</td><td>${badge(item.status)}</td><td class="code">${esc(item.requestId)}</td><td>${esc(item.memberHandle||item.memberName||item.clientId)}</td><td>${esc(fmtTime(item.issuedAt))}</td><td>${esc(fmtTime(item.expiresAt))}</td><td>${item.amount?Number(item.amount).toLocaleString('ko-KR')+'원':'—'}</td><td>${esc(item.approvedBy||item.rejectedBy||'-')}</td><td>${esc(item.memo||item.reason||'-')}</td><td>${item.status==='PENDING'?`<button class="danger" data-qr-reject="${esc(item.requestId)}" data-qr-purpose="${item.purpose}">거절</button>`:'—'}</td></tr>`).join('');
  content.innerHTML = `${secretWarning}<div class="cards qr-summary-cards">
    <div class="card"><div class="stat-label">대기 중</div><div class="stat-value">${summary.pending}</div><div class="stat-sub">관리자 스캔 대기</div></div>
    <div class="card"><div class="stat-label">승인됨</div><div class="stat-value">${summary.approved}</div><div class="stat-sub">일회용 승인 완료</div></div>
    <div class="card"><div class="stat-label">거절됨</div><div class="stat-value">${summary.rejected}</div><div class="stat-sub">관리자 거절</div></div>
    <div class="card"><div class="stat-label">QR 용도</div><div class="stat-value">2종</div><div class="stat-sub">출입증 · 잔액 충전</div></div>
  </div>
  <div class="qr-auth-layout">
    <div class="section-card qr-scan-panel"><div class="section-head"><h3>QR 사진 스캔</h3><span class="small-note">PNG / JPEG · 최대 ${fmtBytes(summary.maxImageBytes)} · 서버 내부 해독</span></div><div class="section-body">
      <input id="qr-auth-file" class="visually-hidden" type="file" accept="image/png,image/jpeg" capture="environment">
      <label for="qr-auth-file" class="qr-drop-zone"><div class="qr-drop-icon">▦</div><strong>${qrSelectedFile ? '선택한 사진 변경' : 'QR 사진 선택'}</strong><span id="qr-auth-file-name">${esc(selectedFileName)}</span>${selectedPreview}</label>
      <button id="qr-auth-scan-btn" class="primary qr-scan-button" data-max-bytes="${summary.maxImageBytes}">서버에서 QR 검증</button>
      <div class="qr-security-strip"><span>일회용</span><span>용도 자동 구분</span><span>HMAC 서명 적용</span><span>기기 연결됨</span></div>
    </div></div>
    <div class="section-card"><div class="section-head"><h3>검증 결과</h3><span class="small-note">출입증과 충전 QR을 같은 화면에서 확인합니다.</span></div><div class="section-body">${scannedCard}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>QR 인증 · 충전 이력</h3><form id="qr-member-search" class="member-filter"><input type="search" id="qr-member-query" value="${esc(qrMemberQuery)}" placeholder="@아이디 · 기기 · QR 코드" aria-label="QR 회원 검색"><button type="submit">검색</button><button type="button" id="qr-member-clear">전체 보기</button></form></div><div class="table-wrap"><table><thead><tr><th>용도</th><th>상태</th><th>요청</th><th>회원 · 기기</th><th>발급됨</th><th>QR 확인 기한</th><th>충전 금액</th><th>운영자</th><th>메모 · 사유</th><th>작업</th></tr></thead><tbody>${rows||'<tr><td colspan="10" class="empty">QR 요청이 없습니다.</td></tr>'}</tbody></table></div></div>`;

  document.getElementById('qr-member-search').onsubmit=event=>{event.preventDefault();qrMemberQuery=document.getElementById('qr-member-query').value;renderQrAuth().catch(e=>toast(e.message,true));};
  document.getElementById('qr-member-clear').onclick=()=>{qrMemberQuery='';renderQrAuth().catch(e=>toast(e.message,true));};
  const fileInput = document.getElementById('qr-auth-file');
  if (fileInput) fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    qrScanResult = null;
    try{await setQrSelectedFile(file);}catch(e){toast(e.message,true);}
    if(currentView==='qrauth')await renderQrAuth();
  };
}
