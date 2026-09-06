'use strict';
// Navigation/form state stays independent of page rendering and API actions.
const dirtyViews = new Set();
content.addEventListener('input', event => {
  const el = event.target;
  if (el.matches('input:not([type=search]),textarea,select') &&
      !el.matches('.license-check,#license-check-all') &&
      !/search|filter|query|draft/.test(el.id)) dirtyViews.add(currentView);
});
content.addEventListener('change', event => {
  if (event.target.matches('select') && !/status|filter|expiry/.test(event.target.id)) dirtyViews.add(currentView);
  if (event.target.matches('.license-check,#license-check-all')) queueMicrotask(updateLicenseSelection);
});
function updateLicenseSelection() {
  const boxes = [...content.querySelectorAll('.license-check')];
  const checked = boxes.filter(x => selectedLicenses.has(x.dataset.key)).length;
  const all = document.getElementById('license-check-all');
  if (all) { all.checked = boxes.length > 0 && checked === boxes.length; all.indeterminate = checked > 0 && checked < boxes.length; }
  const button = document.getElementById('license-bulk-btn');
  if (button) { button.textContent = `선택 작업 (${selectedLicenses.size})`; button.disabled = !selectedLicenses.size; }
  const status = document.getElementById('license-selection-status');
  if (status) status.textContent = `필터 결과 ${boxes.length}개 · 선택 ${selectedLicenses.size}개`;
}
function resetServiceUi() {
  dirtyViews.clear(); selectedLicenses.clear(); clearQrSelectedFile(); qrScanResult = null;
  liveConsoleEvents.length = 0; consoleHistoryLoaded = false; traceRows.clear(); failoverRows.clear();
  terminalLines.length = 0;
  if (typeof resetSupportUiState === 'function') resetSupportUiState();
  if (modalEl && !modalEl.classList.contains('hidden')) modalCancel.click();
}
// Remember expanded sections independently from search, and restore their
// previous state after clearing a search. Native wheel/keyboard scrolling is used.
let navBeforeSearch = null;
navFilter?.addEventListener('input', () => {
  if (navFilter.value.trim()) {
    if (!navBeforeSearch) navBeforeSearch = [...nav.querySelectorAll('.nav-group')].map(g => g.dataset.expanded === 'true');
  } else if (navBeforeSearch) {
    [...nav.querySelectorAll('.nav-group')].forEach((g, i) => g.open = navBeforeSearch[i]);
    navBeforeSearch = null;
  }
});
nav.querySelectorAll('.nav-group').forEach(group => {
  group.dataset.expanded = String(group.open);
  group.addEventListener('toggle', () => { if (!navFilter?.value.trim()) group.dataset.expanded = String(group.open); });
  const items = group.querySelector('.nav-items');
  items.tabIndex = 0;
  items.setAttribute('aria-label', `${group.querySelector('summary').textContent} 메뉴`);
});
