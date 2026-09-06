'use strict';

async function renderLicenses() {
  const q = encodeURIComponent(licenseQuery);
  const s = encodeURIComponent(licenseStatus);
  const e = encodeURIComponent(licenseExpiry);
  const { licenses } = await api(`/api/licenses?query=${q}&status=${s}&expiry=${e}`);
  const operator = roleCanOperate();
  const tagsHtml = tags => (tags || []).length ? tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join('') : '<span class="muted">-</span>';
  content.innerHTML = `
    <div class="toolbar">
      <input id="license-search" placeholder="키 / 앱 기기 / 메모 / 태그 검색 · 태그:VIP" value="${esc(licenseQuery)}">
      <select id="license-status"><option value="ALL">전체</option><option value="AVAILABLE">사용 가능</option><option value="BOUND">연결됨</option><option value="SUSPENDED">이용 정지</option><option value="EXPIRED">만료</option></select>
      <select id="license-expiry"><option value="ALL">전체 이용 기간</option><option value="EXPIRED">만료</option><option value="1D">24시간 이내</option><option value="3D">3일 이내</option><option value="7D">7일 이내</option><option value="30D">30일 이내</option></select>
      <button id="license-search-btn">검색</button>
      ${operator ? `<button id="license-bulk-btn">선택 작업 (${selectedLicenses.size})</button><button id="license-clear-selection" class="ghost">선택 해제</button>` : ''}
    </div>
    <p id="license-selection-status" class="small-note" aria-live="polite">필터 결과 ${licenses.length}개 · 선택 ${selectedLicenses.size}개</p>
    <div class="table-wrap"><table><thead><tr><th><input aria-label="현재 목록 전체 선택" id="license-check-all" type="checkbox"></th><th>키</th><th>상태</th><th>앱 기기</th><th>콘텐츠</th><th>만료일</th><th>태그</th><th>메모</th><th>인증</th><th>전송</th><th>작업</th></tr></thead><tbody>
      ${licenses.map(l => `<tr><td><input class="license-check" type="checkbox" data-key="${esc(l.key)}" ${selectedLicenses.has(l.key) ? 'checked' : ''}></td><td class="code">QR-${esc(l.key.slice(-8))}</td><td>${badge(l.status)}</td><td class="code">${esc(l.boundClient || '-')}</td><td>${accessTypeBadge(l.accessType || 'TYPE1')}</td><td>${esc(fmtTime(l.expiresAt))}</td><td><div class="tag-list">${tagsHtml(l.tags)}</div></td><td>${esc(l.memo || '-')}</td><td>${l.authCount}</td><td>${l.sendCount}</td><td><div class="actions">${operator ? `<button data-license-action="tags" data-key="${esc(l.key)}">태그</button><button data-license-action="extend" data-key="${esc(l.key)}">연장</button><button data-license-action="unbind" data-key="${esc(l.key)}">연결 해제</button><button data-license-action="suspend" data-key="${esc(l.key)}">이용 정지</button><button data-license-action="resume" data-key="${esc(l.key)}">이용 재개</button><button data-license-action="transfer" data-key="${esc(l.key)}">이전</button>` : ''}${roleIsAdmin() ? `<button data-license-action="reissue" data-key="${esc(l.key)}">재발급</button><button class="danger" data-license-action="delete" data-key="${esc(l.key)}">삭제</button>` : ''}</div></td></tr>`).join('') || "<tr><td colspan=\"11\" class=\"empty\">라이선스 없음</td></tr>"}
    </tbody></table></div>`;
  updateLicenseSelection();
  document.getElementById('license-status').value = licenseStatus;
  document.getElementById('license-expiry').value = licenseExpiry;
}


