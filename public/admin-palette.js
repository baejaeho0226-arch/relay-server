'use strict';

function ensurePalette() {
  let root = document.getElementById('command-palette');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'command-palette';
  root.className = 'command-palette hidden';
  root.innerHTML = `<div class="palette-backdrop" data-palette-close></div><div class="palette-card"><div class="palette-head"><span>&gt;_ 전체 검색</span><kbd>ESC</kbd></div><input id="palette-input" class="palette-input" placeholder="서버 / 앱 기기 / 라이선스 / 요청 검색"><div id="palette-results" class="palette-results"><div class="palette-hint">Ctrl+K · 기능과 기기를 검색하세요</div></div></div>`;
  document.body.appendChild(root);
  root.addEventListener('click', async event => {
    if (event.target.closest('[data-palette-close]')) { closePalette(); return; }
    const row = event.target.closest('[data-palette-kind]');
    if (!row) return;
    const kind = row.dataset.paletteKind;
    const id = row.dataset.paletteId;
    closePalette();
    try {
      if (kind === 'SERVER') { switchView('servers'); await renderCurrent(); await serverAction('detail', id); }
      else if (kind === 'CLIENT') { switchView('clients'); await renderCurrent(); await clientAction('detail', id); }
      else if (kind === 'LICENSE') { licenseQuery = id; licenseStatus = 'ALL'; licenseExpiry = 'ALL'; switchView('licenses'); await renderCurrent(); }
      else if (kind === 'REQUEST') { traceQuery = row.dataset.paletteLabel || id; switchView('trace'); await renderCurrent(); }
    } catch (error) { toast(error.message, true); }
  });
  root.querySelector('#palette-input').addEventListener('input', event => {
    clearTimeout(paletteTimer);
    paletteTimer = setTimeout(() => runPaletteSearch(event.target.value), 140);
  });
  return root;
}

function openPalette() {
  if (!session) return;
  const root = ensurePalette();
  root.classList.remove('hidden');
  const input = root.querySelector('#palette-input');
  input.value = '';
  root.querySelector('#palette-results').innerHTML = "<div class=\"palette-hint\">서버 식별자 / 별칭 / 앱 기기 / 라이선스 태그 / 요청 식별자</div>";
  setTimeout(() => input.focus(), 10);
}

function closePalette() {
  const root = document.getElementById('command-palette');
  if (root) root.classList.add('hidden');
}

async function runPaletteSearch(query) {
  const resultsEl = document.getElementById('palette-results');
  if (!resultsEl) return;
  query = String(query || '').trim();
  if (!query) { resultsEl.innerHTML = "<div class=\"palette-hint\">서버 식별자 / 별칭 / 앱 기기 / 라이선스 태그 / 요청 식별자</div>"; return; }
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(query)}`);
    resultsEl.innerHTML = results.map(r => `<button class="palette-row" data-palette-kind="${esc(r.kind)}" data-palette-id="${esc(r.id)}" data-palette-label="${esc(r.label)}"><span class="palette-kind">${esc(r.kind)}</span><span class="palette-main"><strong>${esc(r.label)}</strong><small>${esc(r.detail)}</small></span>${r.status ? badge(r.status) : ''}</button>`).join('') || "<div class=\"palette-hint\">검색 결과 없음</div>";
  } catch (error) { resultsEl.innerHTML = `<div class="palette-hint error-text">${esc(error.message)}</div>`; }
}

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') { event.preventDefault(); openPalette(); return; }
  if (event.key === 'Escape') closePalette();
});



content.addEventListener('change', async event => {
  try {
    const el=event.target.closest('[data-release-channel-select]');
    if(!el)return;
    await api('/api/releases/device-channel',{method:'POST',body:{type:el.dataset.type,id:el.dataset.id,channel:el.value}});
    toast(`${el.dataset.type} ${el.dataset.id} → ${el.value}`);
    await renderReleases();
  } catch(error) { toast(error.message,true); }
});

restoreSession();

// PWA: cache only the static application shell. Authenticated API responses are network-only.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker
    .register('/service-worker.js', { scope: '/', updateViaCache: 'none' })
    .then(registration => registration.update())
    .catch(() => {}));
}
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (installPwaBtn) installPwaBtn.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  if (installPwaBtn) installPwaBtn.classList.add('hidden');
});
if (installPwaBtn) installPwaBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try { await deferredInstallPrompt.userChoice; } catch (_) {}
  deferredInstallPrompt = null;
  installPwaBtn.classList.add('hidden');
});
