'use strict';
const refreshButton = document.getElementById('ui-refresh-button');
const refreshStatus = document.getElementById('ui-refresh-status');
refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  refreshStatus.textContent = '웹 화면 파일을 확인 중입니다.';
  try {
    const response = await fetch(`/ui-version.json?t=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('서버를 확인하지 못했습니다. FIX7A 웹 폴더가 배포됐는지 확인해주세요.');
    const version = await response.json();
    if (!version.ready) throw new Error(`웹 화면 파일의 교체가 완료되지 않았습니다. FIX7A의 public 폴더 전체를 교체하고 다시 배포해주세요.\n확인할 파일: ${(version.issues || []).join(', ')}`);
    refreshStatus.textContent = '이전 화면 캐시를 정리하고 있습니다.';
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith('relay-admin-shell-')).map(name => caches.delete(name)));
    }
    // Updating, rather than unregistering, retains the existing Push subscription.
    // Never clear cookies, localStorage, sessionStorage or unrelated origin caches.
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
        const ours = workers.some(worker => {
          const script = new URL(worker.scriptURL);
          return script.origin === location.origin && script.pathname === '/service-worker.js';
        });
        if (ours) await registration.update();
      }
    }
    refreshStatus.textContent = '최신 화면을 여는 중입니다.';
    location.replace(`/?ui-refresh=${encodeURIComponent(version.uiRevision)}-${Date.now()}`);
  } catch (error) {
    refreshStatus.textContent = error.message || '새로 불러오지 못했습니다. 연결을 확인하고 다시 시도해주세요.';
    refreshButton.disabled = false;
  }
});
