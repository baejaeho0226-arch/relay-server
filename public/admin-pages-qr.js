'use strict';

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('QR_IMAGE_READ_FAILED'));
    reader.readAsDataURL(file);
  });
}

async function renderQrAuth() {
  if (!roleIsAdmin()) { content.innerHTML = "<div class=\"empty\">접근 권한 없음</div>"; return; }
  const { requests, summary } = await api('/api/qr-auth');
  if (qrScanResult) qrScanResult.defaultDays = summary.defaultDays;
  const scanned = qrScanResult && qrScanResult.request ? qrScanResult.request : null;
  const selectedFileName = qrSelectedFile ? `${qrSelectedFile.name} · ${fmtBytes(qrSelectedFile.size)}` : 'APK 화면을 촬영하거나 전달받은 사진을 올리세요.';
  const selectedPreview = qrSelectedPreviewDataUrl
    ? `<img id="qr-auth-preview" src="${esc(qrSelectedPreviewDataUrl)}" alt="선택한 QR 사진 미리보기">`
    : '<img id="qr-auth-preview" class="hidden" alt="선택한 QR 사진 미리보기">';
  const secretWarning = summary.durableSigningSecret ? '' : "<div class=\"warning-box\">QR_APPROVAL_SECRET가 설정되지 않아 현재 프로세스의 임시 서명키를 사용 중입니다. 운영·HA 배포 전에 모든 중계 서버에 같은 전용 비밀값을 설정하세요.</div>";
  const scannedCard = scanned ? `<div class="qr-approval-card">
    <div class="qr-approval-icon">✓</div>
    <div class="qr-approval-main"><span class="small-note">요청 서명 검증 완료</span><strong>${esc(scanned.clientId)}</strong><div class="code">${esc(scanned.requestId)}</div><div class="qr-approval-meta"><span>만료 ${esc(fmtTime(scanned.expiresAt))}</span><span>IP ${esc(scanned.lastIP || '-')}</span><span>스캔 ${scanned.scanCount}</span><span>PC ${esc(scanned.serverId || 'APK 인증 후 연결')}</span></div></div>
    <div class="qr-approval-actions"><button id="qr-auth-approve-btn" class="primary">기기 승인</button><button id="qr-auth-clear-btn" class="ghost">지우기</button></div>
  </div>` : '<div class="qr-scan-empty">QR 사진을 선택하면 서버가 이미지, 서명, 일회용 토큰과 기기 결합을 모두 검증합니다.</div>';
  const rows = requests.map(item => `<tr><td>${badge(item.status)}</td><td class="code">${esc(item.requestId)}</td><td class="code">${esc(item.clientId)}</td><td>${accessTypeBadge(item.accessType || 'TYPE1')}</td><td>${esc(fmtTime(item.issuedAt))}</td><td>${esc(fmtTime(item.expiresAt))}</td><td>${esc(item.approvedBy || item.rejectedBy || '-')}</td><td>${esc(item.reason || '-')}</td><td>${item.status === 'PENDING' ? `<button class="danger" data-qr-reject="${esc(item.requestId)}">거절</button>` : '-'}</td></tr>`).join('');
  content.innerHTML = `${secretWarning}<div class="cards qr-summary-cards">
    <div class="card"><div class="stat-label">대기 중</div><div class="stat-value">${summary.pending}</div><div class="stat-sub">관리자 스캔 대기</div></div>
    <div class="card"><div class="stat-label">승인됨</div><div class="stat-value">${summary.approved}</div><div class="stat-sub">일회용 승인 완료</div></div>
    <div class="card"><div class="stat-label">거절됨</div><div class="stat-value">${summary.rejected}</div><div class="stat-sub">관리자 거절</div></div>
    <div class="card"><div class="stat-label">토큰 유효 시간</div><div class="stat-value">${Math.round(summary.ttlMs / 60000)}m</div><div class="stat-sub">서버 HMAC ${summary.durableSigningSecret ? "고정" : 'EPHEMERAL'}</div></div>
  </div>
  <div class="qr-auth-layout">
    <div class="section-card qr-scan-panel"><div class="section-head"><h3>QR 사진 스캔</h3><span class="small-note">PNG / JPEG · 최대 ${fmtBytes(summary.maxImageBytes)} · 서버 내부 해독</span></div><div class="section-body">
      <input id="qr-auth-file" class="visually-hidden" type="file" accept="image/png,image/jpeg" capture="environment">
      <label for="qr-auth-file" class="qr-drop-zone"><div class="qr-drop-icon">▦</div><strong>${qrSelectedFile ? '선택한 사진 변경' : 'QR 사진 선택'}</strong><span id="qr-auth-file-name">${esc(selectedFileName)}</span>${selectedPreview}</label>
      <button id="qr-auth-scan-btn" class="primary qr-scan-button" data-max-bytes="${summary.maxImageBytes}">서버에서 QR 검증</button>
      <div class="qr-security-strip"><span>일회용</span><span>${Math.round(summary.ttlMs / 60000)} 최소</span><span>HMAC 서명 적용</span><span>기기 연결됨</span></div>
    </div></div>
    <div class="section-card"><div class="section-head"><h3>검증 결과</h3><span class="small-note">승인 전에는 라이선스가 생성되지 않습니다.</span></div><div class="section-body">${scannedCard}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>QR 인증 요청 이력</h3><div class="actions"><span class="small-note">진행 중 요청 보존</span><button class="danger" data-history-clean="QR_AUTH">이력 정리</button></div></div><div class="table-wrap"><table><thead><tr><th>상태</th><th>요청</th><th>앱 기기</th><th>콘텐츠</th><th>발급됨</th><th>만료일</th><th>운영자</th><th>사유</th><th>작업</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="empty">QR 인증 요청 없음</td></tr>'}</tbody></table></div></div>`;

  const fileInput = document.getElementById('qr-auth-file');
  if (fileInput) fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    qrScanResult = null;
    await setQrSelectedFile(file);
    await renderQrAuth();
  };
}
