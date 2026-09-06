'use strict';

async function currentPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(x => x.charCodeAt(0)));
}

async function renderReports() {
  const [{ push }, { daily }] = await Promise.all([api('/api/push/status'), api('/api/reports/daily?limit=120')]);
  let ownSubscription = null;
  try { ownSubscription = await currentPushSubscription(); } catch (_) {}
  const c = daily.current;
  content.innerHTML = `<div class="cards">
    <div class="card"><div class="stat-label">푸시 알림 서비스</div><div class="stat-value compact">${push.available?"준비됨":"꺼짐"}</div><div class="stat-sub">${push.available?`${push.subscriptions} subscription(s)`:esc(uiText(push.reason))}</div></div>
    <div class="card"><div class="stat-label">현재 브라우저</div><div class="stat-value compact">${ownSubscription?"켜짐":"꺼짐"}</div><div class="stat-sub">권한: ${esc(('Notification' in window)?Notification.permission:'unsupported')}</div></div>
    <div class="card"><div class="stat-label">보고서 날짜</div><div class="stat-value compact">${esc(c.date)}</div><div class="stat-sub">${esc(daily.timezone)}</div></div>
    <div class="card"><div class="stat-label">응답 성공</div><div class="stat-value">${c.ack.successRate}%</div><div class="stat-sub">시간 초과 ${c.ack.timeout}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>웹 앱 푸시 알림</h3>${roleIsAdmin()?`<div class="actions"><button id="push-enable-btn" class="primary" ${push.available&&!ownSubscription?'':'disabled'}>이 브라우저 구독</button><button id="push-disable-btn" ${ownSubscription?'':'disabled'}>구독 해제</button><button id="push-test-btn">테스트 푸시 알림</button></div>`:''}</div><div class="section-body"><p class="muted">관리자이 구독한 브라우저에 주의 / 긴급 운영 알림을 웹 관리자이 닫힌 상태에서도 전달합니다. 일일 상태 보고서 완료 알림도 하루 한 번 전송됩니다.</p>${push.available?'':`<div class="integrity-row">${badge('WARNING')}<span class="code">${esc(uiText(push.reason))}</span><span>Railway 환경변수 VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT를 설정하세요.</span></div>`}</div></div>
  <div class="section-card"><div class="section-head"><h3>오늘 상태 미리보기</h3>${roleIsAdmin()?'<button id="report-generate-btn" class="primary">현재 리포트 저장</button>':''}</div><div class="section-body"><div class="kv"><div>서버</div><div>${c.servers.online} / ${c.servers.total} (Peak ${c.servers.peak})</div><div>앱 기기</div><div>${c.clients.online} / ${c.clients.total} (Peak ${c.clients.peak})</div><div>접속 수 / 전송</div><div>${c.connections} / ${c.sends}</div><div>응답 성공 / 오류 / 시간 초과</div><div>${c.ack.ok} / ${c.ack.error} / ${c.ack.timeout}</div><div>연결 반복</div><div>${c.flapping}</div><div>라이선스 7일 이내</div><div>${c.licensesExpiring7d}</div><div>백업</div><div>${badge(c.backup.ok?'GOOD':'WARNING')} ${esc(fmtTime(c.backup.lastAt))}</div><div>데이터베이스</div><div>${badge(c.database.ok?'GOOD':'CRITICAL')} ${esc(fmtTime(c.database.lastSaveAt))}</div></div></div></div>
  <div class="section-card"><div class="section-head"><h3>일일 이력</h3><div class="actions"><span class="small-note">보관 기간 ${daily.reports.length} / 365</span>${roleIsAdmin()?"<button class=\"danger\" data-history-clean=\"DAILY_REPORTS\">이력 정리</button>":''}</div></div><div class="table-wrap"><table><thead><tr><th>날짜</th><th>서버</th><th>앱 기기</th><th>접속 수</th><th>전송</th><th>응답 성공</th><th>오류</th><th>시간 초과</th><th>연결 반복</th><th>라이선스 7일 이내</th><th>백업</th><th>데이터베이스</th><th>생성됨</th></tr></thead><tbody>${daily.reports.map(r=>`<tr><td class="code">${esc(r.date)}</td><td>${r.servers.online}/${r.servers.total}</td><td>${r.clients.online}/${r.clients.total}</td><td>${r.connections}</td><td>${r.sends}</td><td>${r.ack.successRate}%</td><td>${r.ack.error}</td><td>${r.ack.timeout}</td><td>${r.flapping}</td><td>${r.licensesExpiring7d}</td><td>${badge(r.backup.ok?'GOOD':'WARNING')}</td><td>${badge(r.database.ok?'GOOD':'CRITICAL')}</td><td>${esc(fmtTime(r.generatedAt))}</td></tr>`).join('')||"<tr><td colspan=\"13\" class=\"empty\">저장된 일일 보고서 없음</td></tr>"}</tbody></table></div></div>`;
}

