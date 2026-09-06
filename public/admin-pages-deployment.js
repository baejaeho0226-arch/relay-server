'use strict';

function flagSelect(name, value) {
  const v = value === true ? 'ON' : value === false ? 'OFF' : 'INHERIT';
  return `<select data-flag-name="${esc(name)}"><option value="INHERIT" ${v==='INHERIT'?'selected':''}>전체 설정 사용</option><option value="ON" ${v==='ON'?'selected':''}>켜짐</option><option value="OFF" ${v==='OFF'?'selected':''}>꺼짐</option></select>`;
}


async function renderReleases() {
  const { releases:r } = await api('/api/releases');
  const relMap = new Map((r.releases || []).map(x => [`${x.type}:${x.channel}`, x]));
  const releaseRows = ['SERVER','CLIENT'].flatMap(type => ['STABLE','BETA','TEST'].map(channel => {
    const x=relMap.get(`${type}:${channel}`);
    return `<tr><td>${uiText(type)}</td><td>${uiText(channel)}</td><td>${x?esc(x.version):'-'}</td><td>${x?fmtBytes(x.size):'-'}</td><td>${x?`${x.rolloutPercent}%`:'-'}</td><td>${x?badge(x.enabled?'ONLINE':'OFFLINE'):'-'}</td><td>${x?`<code>${esc(String(x.sha256||'').slice(0,16))}...</code>`:'-'}</td><td>${x?`<div class="actions"><button data-release-rollout data-type="${type}" data-channel="${channel}">배포 비율</button><button data-release-toggle data-type="${type}" data-channel="${channel}" data-enabled="${x.enabled?'0':'1'}">${x.enabled?"일시 중지":"활성화"}</button><button data-release-push data-type="${type}" data-channel="${channel}">푸시 알림</button></div>`:'-'}</td></tr>`;
  })).join('');
  const assignments=(r.assignments||[]).map(d=>`<tr><td>${esc(uiText(d.type))}</td><td><code>${esc(d.id)}</code></td><td>${d.online?badge('ONLINE'):badge('OFFLINE')}</td><td>${esc(d.currentVersion||'-')}</td><td><select data-release-channel-select data-type="${d.type}" data-id="${d.id}">${['STABLE','BETA','TEST'].map(ch=>`<option value="${ch}" ${ch===d.channel?'selected':''}>${uiText(ch)}</option>`).join('')}</select></td><td>${d.bucket}</td><td>${d.update&&d.update.available?badge('UPDATE'):esc(d.update&&d.update.reason||'-')}<div class="small-note code">${d.updateStatus?esc(`${d.updateStatus.version||''} ${d.updateStatus.status||''}`):''}</div></td><td><button data-release-device-push data-type="${d.type}" data-id="${d.id}">업데이트 확인·알림</button></td></tr>`).join('');
  content.innerHTML=`
    <div class="section-card"><div class="section-head"><h3>새 버전 배포</h3><span class="small-note">관리자 파일 등록 · 해시 검증 · 서명된 다운로드 주소</span></div><div class="section-body">
      <div class="form-grid release-upload-grid">
        <label>대상<select id="release-type"><option value="SERVER">서버</option><option value="CLIENT">앱 기기</option></select></label>
        <label>채널<select id="release-channel"><option value="STABLE">안정</option><option value="BETA">베타</option><option value="TEST">테스트</option></select></label>
        <label>버전<input id="release-version" value="2.2.0" placeholder="2.2.0"></label>
        <label>배포 비율 %<input id="release-rollout" type="number" min="0" max="100" value="100"></label>
        <label>필수 적용<select id="release-mandatory"><option value="0">아니요</option><option value="1">예</option></select></label>
        <label>배포 파일<input id="release-file" type="file" accept=".zip,.exe,.apk"></label>
      </div>
      <label>변경 사항<input id="release-notes" placeholder="변경사항 / 주의사항"></label>
      <div class="actions"><button id="release-upload-btn" class="primary">파일 등록·배포</button><span id="release-upload-status" class="muted"></span></div>
    </div></div>
    <div class="section-card"><div class="section-head"><h3>채널별 배포 현황</h3></div><div class="table-wrap"><table><thead><tr><th>유형</th><th>채널</th><th>버전</th><th>크기</th><th>배포 비율</th><th>상태</th><th>SHA-256</th><th>작업</th></tr></thead><tbody>${releaseRows}</tbody></table></div></div>
    <div class="section-card"><div class="section-head"><h3>기기별 배포 채널</h3><span class="small-note">기기별 고정 배포 그룹 (0~99)</span></div><div class="table-wrap"><table><thead><tr><th>유형</th><th>식별자</th><th>연결</th><th>버전</th><th>채널</th><th>배포 그룹</th><th>업데이트</th><th>작업</th></tr></thead><tbody>${assignments||"<tr><td colspan=\"8\">아니요 기기</td></tr>"}</tbody></table></div></div>`;
}

async function uploadRelease() {
  const file=document.getElementById('release-file').files[0]; if(!file){toast("배포 파일을 선택하세요.",true);return;}
  const type=document.getElementById('release-type').value, channel=document.getElementById('release-channel').value, version=document.getElementById('release-version').value.trim();
  const rolloutPercent=Number(document.getElementById('release-rollout').value||100), mandatory=document.getElementById('release-mandatory').value;
  const notes=document.getElementById('release-notes').value.trim(); const status=document.getElementById('release-upload-status');
  const q=new URLSearchParams({type,channel,version,fileName:file.name,rolloutPercent:String(rolloutPercent),mandatory,notes});
  status.textContent=`업로드 중 ${fmtBytes(file.size)}...`;
  const response=await fetch(`/api/releases/upload?${q.toString()}`,{method:'POST',headers:{'X-CSRF-Token':session.csrf,'Content-Type':'application/octet-stream'},credentials:'same-origin',body:file});
  let data={}; try{data=await response.json();}catch(_){} if(!response.ok||data.ok===false)throw new Error(data.error||`HTTP_${response.status}`);
  toast(`${type}/${channel} ${version} 배포됨`); await renderReleases();
}

async function renderFeatureFlags() {
  if (!roleIsAdmin()) { content.innerHTML = "<div class=\"empty\">접근 권한 없음</div>"; return; }
  const [{ defaults, global, serverOverrides, clientOverrides }, { devices }] = await Promise.all([api('/api/control/features'), api('/api/control/devices')]);
  const names = Object.keys(defaults || {});
  const globalRows = names.map(name => `<tr><td class="code">${esc(name)}</td><td>${badge(defaults[name] ? 'ON' : 'OFF')}</td><td><select data-global-flag="${esc(name)}"><option value="ON" ${global[name]?'selected':''}>켜짐</option><option value="OFF" ${!global[name]?'selected':''}>꺼짐</option></select></td></tr>`).join('');
  const deviceOptions = (devices || []).map(d => `<option value="${esc(d.type)}|${esc(d.id)}">${esc(uiText(d.type))} // ${esc(d.id)}${d.info && d.info.name ? ` // ${esc(d.info.name)}` : ''}${d.online ? " // 온라인" : " // 오프라인"}</option>`).join('');
  content.innerHTML = `<div class="panel-grid">
    <div class="section-card"><div class="section-head"><h3>전체 기능 설정</h3><span class="small-note">설정 동기화 // 전체 기본값</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>기능</th><th>기본값</th><th>전체</th></tr></thead><tbody>${globalRows}</tbody></table></div><div class="toolbar"><button id="feature-global-save" class="primary">저장 전체 기능 설정</button></div></div></div>
    <div class="section-card"><div class="section-head"><h3>기기 개별 설정</h3><span class="small-note">전체 설정 사용 = 전체</span></div><div class="section-body"><label>기기<select id="feature-device-select"><option value="">선택 기기</option>${deviceOptions}</select></label><div id="feature-device-editor" class="empty">서버 / 앱 기기를 선택하세요.</div></div></div>
  </div><div class="section-card"><div class="section-head"><h3>기능별 적용 상태</h3></div><div class="section-body"><div class="kv">${names.map(name=>`<div class="code">${esc(name)}</div><div>${badge(global[name]?'ON':'OFF')}</div>`).join('')}</div><p class="small-note">실행 설정 저장과 기능 설정 저장은 독립적입니다. 기기 개별 설정는 해당 장비에만 적용되고 나머지는 전체 값을 상속합니다.</p></div></div>`;
  const select = document.getElementById('feature-device-select');
  if (select) select.onchange = () => renderFeatureDeviceEditor(names, serverOverrides || {}, clientOverrides || {});
}

function renderFeatureDeviceEditor(names, serverOverrides, clientOverrides) {
  const select = document.getElementById('feature-device-select');
  const editor = document.getElementById('feature-device-editor');
  if (!select || !editor || !select.value) { if (editor) editor.innerHTML="<div class=\"empty\">서버 / 앱 기기를 선택하세요.</div>"; return; }
  const [type,id] = select.value.split('|');
  const source = type === 'SERVER' ? serverOverrides : clientOverrides;
  const override = source[id] || {};
  editor.innerHTML = `<div class="table-wrap"><table><thead><tr><th>기능</th><th>개별 설정</th></tr></thead><tbody>${names.map(name=>`<tr><td class="code">${esc(name)}</td><td>${flagSelect(name,Object.prototype.hasOwnProperty.call(override,name)?override[name]:null)}</td></tr>`).join('')}</tbody></table></div><div class="toolbar"><button id="feature-device-save" class="primary" data-type="${esc(type)}" data-id="${esc(id)}">저장 개별 설정</button><button id="feature-device-clear" data-type="${esc(type)}" data-id="${esc(id)}">기기별 설정 해제</button></div>`;
}


async function renderConfigHistory() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { current, history } = await api('/api/control/config-history?limit=100');
  const rows = (history || []).map(h => `<tr><td>${esc(fmtTime(h.at))}</td><td class="code">${esc(h.id)}</td><td>${esc(uiText(h.action))}</td><td>${esc(h.actor)}</td><td>${h.revision}</td><td>${esc(h.detail || '-')}</td><td>${h.action === 'ROLLBACK' ? '-' : `<button data-config-rollback="${esc(h.id)}">되돌리기</button>`}</td></tr>`).join('');
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">현재 개정 번호</div><div class="stat-value">${current.revision}</div><div class="stat-sub">실행 설정</div></div><div class="card"><div class="stat-label">이력</div><div class="stat-value">${history.length}</div><div class="stat-sub">최대 100 스냅샷</div></div></div><div class="section-card"><div class="section-head"><h3>설정 변경 이력</h3><div class="actions"><span class="small-note">현재 설정은 새 기준값으로 보존</span><button class="danger" data-history-clean="CONFIG">이력 정리</button></div></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>시각</th><th>식별자</th><th>작업</th><th>작업자</th><th>개정</th><th>상세</th><th>작업</th></tr></thead><tbody>${rows || "<tr><td colspan=\"7\" class=\"empty\">이력 없음</td></tr>"}</tbody></table></div></div></div>`;
}

