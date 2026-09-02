'use strict';

// OPERATIONS / SYSTEM PAGES

async function renderLicenses() {
  const q = encodeURIComponent(licenseQuery);
  const s = encodeURIComponent(licenseStatus);
  const e = encodeURIComponent(licenseExpiry);
  const { licenses } = await api(`/api/licenses?query=${q}&status=${s}&expiry=${e}`);
  const operator = roleCanOperate();
  const tagsHtml = tags => (tags || []).length ? tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join('') : '<span class="muted">-</span>';
  content.innerHTML = `
    <div class="toolbar">
      <input id="license-search" placeholder="Key / Client / Memo / Tag 검색 · tag:VIP" value="${esc(licenseQuery)}">
      <select id="license-status"><option>ALL</option><option>AVAILABLE</option><option>BOUND</option><option>SUSPENDED</option><option>EXPIRED</option></select>
      <select id="license-expiry"><option value="ALL">ALL EXPIRY</option><option value="EXPIRED">EXPIRED</option><option value="1D">≤ 24H</option><option value="3D">≤ 3D</option><option value="7D">≤ 7D</option><option value="30D">≤ 30D</option></select>
      <button id="license-search-btn">검색</button>
      ${operator ? '<button id="license-bulk-btn">선택 작업</button>' : ''}
    </div>
    <div class="table-wrap"><table><thead><tr><th><input id="license-check-all" type="checkbox"></th><th>KEY</th><th>Status</th><th>Client</th><th>Content</th><th>Expires</th><th>Tags</th><th>Memo</th><th>Auth</th><th>Send</th><th>Action</th></tr></thead><tbody>
      ${licenses.map(l => `<tr><td><input class="license-check" type="checkbox" data-key="${esc(l.key)}" ${selectedLicenses.has(l.key) ? 'checked' : ''}></td><td class="code">QR-${esc(l.key.slice(-8))}</td><td>${badge(l.status)}</td><td class="code">${esc(l.boundClient || '-')}</td><td>${accessTypeBadge(l.accessType || 'TYPE1')}</td><td>${esc(fmtTime(l.expiresAt))}</td><td><div class="tag-list">${tagsHtml(l.tags)}</div></td><td>${esc(l.memo || '-')}</td><td>${l.authCount}</td><td>${l.sendCount}</td><td><div class="actions">${operator ? `<button data-license-action="tags" data-key="${esc(l.key)}">Tags</button><button data-license-action="extend" data-key="${esc(l.key)}">연장</button><button data-license-action="unbind" data-key="${esc(l.key)}">Unbind</button><button data-license-action="suspend" data-key="${esc(l.key)}">Suspend</button><button data-license-action="resume" data-key="${esc(l.key)}">Resume</button><button data-license-action="transfer" data-key="${esc(l.key)}">Transfer</button>` : ''}${roleIsAdmin() ? `<button data-license-action="reissue" data-key="${esc(l.key)}">Reissue</button><button class="danger" data-license-action="delete" data-key="${esc(l.key)}">Delete</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="11" class="empty">License 없음</td></tr>'}
    </tbody></table></div>`;
  document.getElementById('license-status').value = licenseStatus;
  document.getElementById('license-expiry').value = licenseExpiry;
}


function flagSelect(name, value) {
  const v = value === true ? 'ON' : value === false ? 'OFF' : 'INHERIT';
  return `<select data-flag-name="${esc(name)}"><option value="INHERIT" ${v==='INHERIT'?'selected':''}>INHERIT</option><option value="ON" ${v==='ON'?'selected':''}>ON</option><option value="OFF" ${v==='OFF'?'selected':''}>OFF</option></select>`;
}


async function renderReleases() {
  const { releases:r } = await api('/api/releases');
  const relMap = new Map((r.releases || []).map(x => [`${x.type}:${x.channel}`, x]));
  const releaseRows = ['SERVER','CLIENT'].flatMap(type => ['STABLE','BETA','TEST'].map(channel => {
    const x=relMap.get(`${type}:${channel}`);
    return `<tr><td>${type}</td><td>${channel}</td><td>${x?esc(x.version):'-'}</td><td>${x?fmtBytes(x.size):'-'}</td><td>${x?`${x.rolloutPercent}%`:'-'}</td><td>${x?badge(x.enabled?'ONLINE':'OFFLINE'):'-'}</td><td>${x?`<code>${esc(String(x.sha256||'').slice(0,16))}...</code>`:'-'}</td><td>${x?`<div class="actions"><button data-release-rollout data-type="${type}" data-channel="${channel}">ROLLOUT</button><button data-release-toggle data-type="${type}" data-channel="${channel}" data-enabled="${x.enabled?'0':'1'}">${x.enabled?'PAUSE':'ENABLE'}</button><button data-release-push data-type="${type}" data-channel="${channel}">PUSH</button></div>`:'-'}</td></tr>`;
  })).join('');
  const assignments=(r.assignments||[]).map(d=>`<tr><td>${d.type}</td><td><code>${esc(d.id)}</code></td><td>${d.online?badge('ONLINE'):badge('OFFLINE')}</td><td>${esc(d.currentVersion||'-')}</td><td><select data-release-channel-select data-type="${d.type}" data-id="${d.id}">${['STABLE','BETA','TEST'].map(ch=>`<option value="${ch}" ${ch===d.channel?'selected':''}>${ch}</option>`).join('')}</select></td><td>${d.bucket}</td><td>${d.update&&d.update.available?badge('UPDATE'):esc(d.update&&d.update.reason||'-')}<div class="small-note code">${d.updateStatus?esc(`${d.updateStatus.version||''} ${d.updateStatus.status||''}`):''}</div></td><td><button data-release-device-push data-type="${d.type}" data-id="${d.id}">CHECK/PUSH</button></td></tr>`).join('');
  content.innerHTML=`
    <div class="section-card"><div class="section-head"><h3>Publish Release</h3><span class="small-note">Admin upload / SHA-256 / signed download URL</span></div><div class="section-body">
      <div class="form-grid release-upload-grid">
        <label>Target<select id="release-type"><option>SERVER</option><option>CLIENT</option></select></label>
        <label>Channel<select id="release-channel"><option>STABLE</option><option>BETA</option><option>TEST</option></select></label>
        <label>Version<input id="release-version" value="2.2.0" placeholder="2.2.0"></label>
        <label>Canary %<input id="release-rollout" type="number" min="0" max="100" value="100"></label>
        <label>Mandatory<select id="release-mandatory"><option value="0">NO</option><option value="1">YES</option></select></label>
        <label>Artifact<input id="release-file" type="file" accept=".zip,.exe,.apk"></label>
      </div>
      <label>Release Notes<input id="release-notes" placeholder="변경사항 / 주의사항"></label>
      <div class="actions"><button id="release-upload-btn" class="primary">UPLOAD & PUBLISH</button><span id="release-upload-status" class="muted"></span></div>
    </div></div>
    <div class="section-card"><div class="section-head"><h3>Release Matrix</h3></div><div class="table-wrap"><table><thead><tr><th>TYPE</th><th>CHANNEL</th><th>VERSION</th><th>SIZE</th><th>CANARY</th><th>STATE</th><th>SHA-256</th><th>ACTION</th></tr></thead><tbody>${releaseRows}</tbody></table></div></div>
    <div class="section-card"><div class="section-head"><h3>Device Release Channel</h3><span class="small-note">Deterministic Canary bucket 0-99</span></div><div class="table-wrap"><table><thead><tr><th>TYPE</th><th>ID</th><th>LINK</th><th>VERSION</th><th>CHANNEL</th><th>BUCKET</th><th>UPDATE</th><th>ACTION</th></tr></thead><tbody>${assignments||'<tr><td colspan="8">No devices</td></tr>'}</tbody></table></div></div>`;
}

async function uploadRelease() {
  const file=document.getElementById('release-file').files[0]; if(!file){toast('Release 파일을 선택하세요.',true);return;}
  const type=document.getElementById('release-type').value, channel=document.getElementById('release-channel').value, version=document.getElementById('release-version').value.trim();
  const rolloutPercent=Number(document.getElementById('release-rollout').value||100), mandatory=document.getElementById('release-mandatory').value;
  const notes=document.getElementById('release-notes').value.trim(); const status=document.getElementById('release-upload-status');
  const q=new URLSearchParams({type,channel,version,fileName:file.name,rolloutPercent:String(rolloutPercent),mandatory,notes});
  status.textContent=`UPLOADING ${fmtBytes(file.size)}...`;
  const response=await fetch(`/api/releases/upload?${q.toString()}`,{method:'POST',headers:{'X-CSRF-Token':session.csrf,'Content-Type':'application/octet-stream'},credentials:'same-origin',body:file});
  let data={}; try{data=await response.json();}catch(_){} if(!response.ok||data.ok===false)throw new Error(data.error||`HTTP_${response.status}`);
  toast(`${type}/${channel} ${version} published`); await renderReleases();
}

async function renderFeatureFlags() {
  if (!roleIsAdmin()) { content.innerHTML = '<div class="empty">FORBIDDEN</div>'; return; }
  const [{ defaults, global, serverOverrides, clientOverrides }, { devices }] = await Promise.all([api('/api/control/features'), api('/api/control/devices')]);
  const names = Object.keys(defaults || {});
  const globalRows = names.map(name => `<tr><td class="code">${esc(name)}</td><td>${badge(defaults[name] ? 'ON' : 'OFF')}</td><td><select data-global-flag="${esc(name)}"><option value="ON" ${global[name]?'selected':''}>ON</option><option value="OFF" ${!global[name]?'selected':''}>OFF</option></select></td></tr>`).join('');
  const deviceOptions = (devices || []).map(d => `<option value="${esc(d.type)}|${esc(d.id)}">${esc(d.type)} // ${esc(d.id)}${d.info && d.info.name ? ` // ${esc(d.info.name)}` : ''}${d.online ? ' // ONLINE' : ' // OFFLINE'}</option>`).join('');
  content.innerHTML = `<div class="panel-grid">
    <div class="section-card"><div class="section-head"><h3>Global Feature Flags</h3><span class="small-note">CONFIG SYNC // GLOBAL DEFAULT</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Flag</th><th>Default</th><th>Global</th></tr></thead><tbody>${globalRows}</tbody></table></div><div class="toolbar"><button id="feature-global-save" class="primary">SAVE GLOBAL FLAGS</button></div></div></div>
    <div class="section-card"><div class="section-head"><h3>Device Override</h3><span class="small-note">INHERIT = GLOBAL</span></div><div class="section-body"><label>Device<select id="feature-device-select"><option value="">SELECT DEVICE</option>${deviceOptions}</select></label><div id="feature-device-editor" class="empty">Server / Client를 선택하세요.</div></div></div>
  </div><div class="section-card"><div class="section-head"><h3>Flag Semantics</h3></div><div class="section-body"><div class="kv">${names.map(name=>`<div class="code">${esc(name)}</div><div>${badge(global[name]?'ON':'OFF')}</div>`).join('')}</div><p class="small-note">Runtime Config 저장과 Feature Flags 저장은 독립적입니다. Device Override는 해당 장비에만 적용되고 나머지는 Global 값을 상속합니다.</p></div></div>`;
  const select = document.getElementById('feature-device-select');
  if (select) select.onchange = () => renderFeatureDeviceEditor(names, serverOverrides || {}, clientOverrides || {});
}

function renderFeatureDeviceEditor(names, serverOverrides, clientOverrides) {
  const select = document.getElementById('feature-device-select');
  const editor = document.getElementById('feature-device-editor');
  if (!select || !editor || !select.value) { if (editor) editor.innerHTML='<div class="empty">Server / Client를 선택하세요.</div>'; return; }
  const [type,id] = select.value.split('|');
  const source = type === 'SERVER' ? serverOverrides : clientOverrides;
  const override = source[id] || {};
  editor.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Flag</th><th>Override</th></tr></thead><tbody>${names.map(name=>`<tr><td class="code">${esc(name)}</td><td>${flagSelect(name,Object.prototype.hasOwnProperty.call(override,name)?override[name]:null)}</td></tr>`).join('')}</tbody></table></div><div class="toolbar"><button id="feature-device-save" class="primary" data-type="${esc(type)}" data-id="${esc(id)}">SAVE OVERRIDE</button><button id="feature-device-clear" data-type="${esc(type)}" data-id="${esc(id)}">CLEAR OVERRIDE</button></div>`;
}


async function renderConfigHistory() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { current, history } = await api('/api/control/config-history?limit=100');
  const rows = (history || []).map(h => `<tr><td>${esc(fmtTime(h.at))}</td><td class="code">${esc(h.id)}</td><td>${esc(h.action)}</td><td>${esc(h.actor)}</td><td>${h.revision}</td><td>${esc(h.detail || '-')}</td><td>${h.action === 'ROLLBACK' ? '-' : `<button data-config-rollback="${esc(h.id)}">ROLLBACK</button>`}</td></tr>`).join('');
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">CURRENT REVISION</div><div class="stat-value">${current.revision}</div><div class="stat-sub">Runtime Config</div></div><div class="card"><div class="stat-label">HISTORY</div><div class="stat-value">${history.length}</div><div class="stat-sub">Max 100 snapshots</div></div></div><div class="section-card"><div class="section-head"><h3>Configuration Timeline</h3><div class="actions"><span class="small-note">현재 설정은 새 Baseline으로 보존</span><button class="danger" data-history-clean="CONFIG">CLEAN HISTORY</button></div></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Time</th><th>ID</th><th>Action</th><th>Actor</th><th>Rev</th><th>Detail</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">History 없음</td></tr>'}</tbody></table></div></div></div>`;
}

async function renderEnrollment() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { enrollment:e } = await api('/api/enrollment');
  const rows=(e.records||[]).map(r=>`<tr><td>${badge(r.type)}</td><td class="code">${esc(r.deviceKey)}</td><td>${badge(r.status)}</td><td class="code">${esc(r.requestId)}</td><td>${esc(r.appVersion||'-')}</td><td>${r.protocolVersion||'-'}</td><td class="code">${esc(r.ip||'-')}</td><td>${esc(fmtTime(r.lastSeenAt))}</td><td class="code">${esc(r.assignedId||'-')}</td><td><div class="actions">${r.status==='PENDING'?`<button class="primary" data-enroll-decision="APPROVED" data-request-id="${esc(r.requestId)}">APPROVE</button><button class="danger" data-enroll-decision="REJECTED" data-request-id="${esc(r.requestId)}">REJECT</button>`:''}<button data-enroll-reset="${esc(r.requestId)}">RESET</button></div></td></tr>`).join('');
  content.innerHTML=`<div class="cards"><div class="card"><div class="stat-label">POLICY</div><div class="stat-value">${e.policy.enabled?'ON':'OFF'}</div><div class="stat-sub">Existing devices are grandfathered</div></div><div class="card"><div class="stat-label">PENDING</div><div class="stat-value">${e.pending}</div></div><div class="card"><div class="stat-label">APPROVED</div><div class="stat-value">${e.approved}</div></div><div class="card"><div class="stat-label">REJECTED</div><div class="stat-value">${e.rejected}</div></div></div><div class="section-card"><div class="section-head"><h3>New Device Approval</h3><div class="actions"><button id="enrollment-policy-btn" class="${e.policy.enabled?'warning':'primary'}">${e.policy.enabled?'DISABLE POLICY':'ENABLE POLICY'}</button></div></div><div class="section-body"><p class="muted">정책 ON 이후 처음 보는 Device Key만 PENDING 처리됩니다. 이미 등록된 Server / Client는 재접속에 영향 없습니다.</p><div class="table-wrap"><table><thead><tr><th>Type</th><th>Device Key</th><th>Status</th><th>Request</th><th>App</th><th>Proto</th><th>IP</th><th>Last Seen</th><th>Assigned ID</th><th>Action</th></tr></thead><tbody>${rows||'<tr><td colspan="10" class="empty">Enrollment 기록 없음</td></tr>'}</tbody></table></div></div></div>`;
}

async function renderSecurityCenter() {
  const [{ security:s }, networkResult] = await Promise.all([
    api('/api/security/dashboard'),
    api('/api/security/network')
  ]);
  const network = networkResult.summary || { total:0, changed:0, critical:0, warning:0, info:0 };
  const geo = networkResult.geo || {};
  const alerts=(s.alerts||[]).map(a=>`<div class="integrity-row">${badge(a.severity)}<span class="code">${esc(a.code)}</span><span>COUNT ${a.count}</span><span>${esc(a.message||'')}</span></div>`).join('');
  const rows=(s.devices||[]).map(d=>{
    const age=d.hasSecret?(d.secretAgeUnknown?'UNKNOWN':`${d.secretAgeDays}d`):'-';
    const hmac=!d.capable?badge('LEGACY'):(d.verified?badge('VERIFIED'):badge(d.online?'UNVERIFIED':'OFFLINE'));
    const secret=!d.hasSecret?badge('NONE'):(d.secretStale?badge('STALE'):badge('OK'));
    return `<tr><td>${badge(d.type)}</td><td class="code">${esc(d.id)}</td><td>${d.online?badge('ONLINE'):badge('OFFLINE')}</td><td>${hmac}</td><td>${d.enforced?badge('ENFORCED'):badge('OPTIONAL')}</td><td>${secret}</td><td>${esc(age)}</td><td>${esc(d.authStatus||'-')}</td><td>${d.verifiedAt?esc(fmtTime(d.verifiedAt)):'-'}</td><td>${d.rotationStatus?badge(d.rotationStatus):'-'}</td></tr>`;
  }).join('');
  const networkRows=(networkResult.devices||[]).map(n=>{
    const current=n.current||{}, trusted=n.trusted||{};
    const location=[current.country,current.region,current.city].filter(Boolean).join(' / ')||'-';
    const trustedLocation=[trusted.country,trusted.region,trusted.city].filter(Boolean).join(' / ')||'-';
    const action=roleIsAdmin()?`<button data-network-trust data-type="${esc(n.type)}" data-id="${esc(n.id)}" ${n.changed?'':'disabled'}>TRUST CURRENT</button>`:'-';
    return `<tr><td>${badge(n.type)}</td><td class="code">${esc(n.id)}</td><td>${badge(n.status||'TRUSTED')}</td><td>${n.severity?badge(n.severity):badge('OK')}</td><td class="code">${esc(current.ip||'-')}</td><td class="code">${esc(trusted.ip||'-')}</td><td>${esc(location)}</td><td>${esc(trustedLocation)}</td><td class="code">${esc(current.subnet||'-')}</td><td class="code">${esc(trusted.subnet||'-')}</td><td>${n.changeCount||0}</td><td>${esc(fmtTime(n.lastChangeAt))}</td><td>${action}</td></tr>`;
  }).join('');
  content.innerHTML=`<div class="cards">
    <div class="card"><div class="stat-label">SECURITY SCORE</div><div class="stat-value">${s.score}</div><div class="stat-sub">${esc(s.label)}</div></div>
    <div class="card"><div class="stat-label">HMAC VERIFIED</div><div class="stat-value">${s.verified} / ${s.onlineHmacCapable}</div><div class="stat-sub">Online HMAC-capable</div></div>
    <div class="card"><div class="stat-label">NETWORK CHANGED</div><div class="stat-value">${network.changed}</div><div class="stat-sub">Critical ${network.critical} · Warn ${network.warning}</div></div>
    <div class="card"><div class="stat-label">GEOIP</div><div class="stat-value">${geo.available?'READY':'FALLBACK'}</div><div class="stat-sub">${esc(geo.provider||'none')} · no external API</div></div>
    <div class="card"><div class="stat-label">SECRET AGE</div><div class="stat-value">${s.staleSecrets}</div><div class="stat-sub">90d+ · Unknown ${s.unknownSecretAge}</div></div>
    <div class="card"><div class="stat-label">LEGACY</div><div class="stat-value">${s.legacy}</div><div class="stat-sub">Active rotations ${s.activeRotations}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>Security Alerts</h3>${badge(s.label)}</div><div class="section-body">${alerts||'<div class="integrity-ok">[ SECURITY_HEALTHY ] No active security warnings.</div>'}</div></div>
  <div class="section-card"><div class="section-head"><h3>Trusted Network Baseline</h3><span class="small-note">Country=CRITICAL · Subnet=WARNING · IP=INFO · 자동 차단 없음</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>ID</th><th>Status</th><th>Severity</th><th>Current IP</th><th>Trusted IP</th><th>Current Location</th><th>Trusted Location</th><th>Current Subnet</th><th>Trusted Subnet</th><th>Changes</th><th>Last Change</th><th>Action</th></tr></thead><tbody>${networkRows||'<tr><td colspan="13" class="empty">Network profile 없음</td></tr>'}</tbody></table></div></div></div>
  <div class="section-card"><div class="section-head"><h3>Device Security Matrix</h3><span class="small-note">HMAC / ENROLLMENT / SECRET AGE / ROTATION</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>ID</th><th>Link</th><th>HMAC</th><th>Policy</th><th>Secret</th><th>Age</th><th>Auth State</th><th>Last Verified</th><th>Rotation</th></tr></thead><tbody>${rows||'<tr><td colspan="10" class="empty">Device 없음</td></tr>'}</tbody></table></div></div></div>`;
}

async function renderProtocolSecurity() {
  const [{ readiness }, { devices: security }, { devices: sequences }, { rotations }] = await Promise.all([
    api('/api/control/protocol-readiness'), api('/api/control/security'), api('/api/control/sequences'), api('/api/control/security/rotations')
  ]);
  const secMap = new Map((security || []).map(x => [`${x.type}:${x.id}`, x]));
  const seqMap = new Map((sequences || []).map(x => [`${x.type}:${x.id}`, x]));
  const rotationMap = new Map((rotations || []).map(x => [`${x.type}:${x.id}`, x]));
  const rows = (readiness.devices || []).map(r => {
    const key = `${r.type}:${r.id}`;
    const sec = secMap.get(key) || {};
    const seq = seqMap.get(key) || {};
    const st = seq.stats || {};
    const rot = rotationMap.get(key) || null;
    const actions = roleIsAdmin() && sec.online ? `<div class="actions"><button data-security-challenge data-type="${esc(r.type)}" data-id="${esc(r.id)}">Challenge</button><button class="warning" data-security-rotate data-type="${esc(r.type)}" data-id="${esc(r.id)}">Rotate Secret</button><button class="danger" data-security-reset data-type="${esc(r.type)}" data-id="${esc(r.id)}">Re-enroll</button></div>` : '-';
    return `<tr><td>${badge(r.type)}</td><td class="code">${esc(r.id)}</td><td>${r.ready ? badge('READY') : badge('BLOCKED')}</td><td>${esc((r.profile && `${r.profile.current} → ${r.profile.candidate}`) || '-')}</td><td>${sec.hasSecret ? badge('ENROLLED') : badge('NONE')}</td><td>${sec.verified ? badge('VERIFIED') : badge(sec.online ? 'UNVERIFIED' : 'OFFLINE')}</td><td>${sec.enforced ? badge('ENFORCED') : badge('OPTIONAL')}</td><td>${rot ? badge(rot.status) : badge('NONE')}</td><td>${seq.capable ? badge(seq.enabled ? 'ON' : 'OFF') : badge('LEGACY')}</td><td>${st.rxLast || 0}</td><td>${st.rxMissing || 0}</td><td>${st.rxDuplicates || 0}</td><td>${st.rxOutOfOrder || 0}</td><td>${esc((r.blockers || []).join(', ') || '-')}</td><td>${actions}</td></tr>`;
  }).join('');
  const verified = (security || []).filter(x => x.verified).length;
  const enrolled = (security || []).filter(x => x.hasSecret).length;
  const missing = (sequences || []).reduce((a,x)=>a+Number(x.stats&&x.stats.rxMissing||0),0);
  const anomalies = (sequences || []).reduce((a,x)=>a+Number(x.stats&&x.stats.rxDuplicates||0)+Number(x.stats&&x.stats.rxOutOfOrder||0),0);
  content.innerHTML = `<div class="cards">
    <div class="card"><div class="stat-label">V3 READY</div><div class="stat-value">${readiness.ready} / ${readiness.total}</div><div class="stat-sub">Candidate Protocol ${readiness.candidateProtocol}</div></div>
    <div class="card"><div class="stat-label">HMAC VERIFIED</div><div class="stat-value">${verified}</div><div class="stat-sub">Enrolled ${enrolled}</div></div>
    <div class="card"><div class="stat-label">SEQ MISSING</div><div class="stat-value">${missing}</div><div class="stat-sub">Detected gaps</div></div>
    <div class="card"><div class="stat-label">SEQ ANOMALY</div><div class="stat-value">${anomalies}</div><div class="stat-sub">Duplicate / Out-of-order</div></div>
  </div><div class="section-card"><div class="section-head"><h3>Protocol v3 Readiness / Device Security / Sequence</h3><span class="small-note">Protocol 2 remains active. This page only measures readiness.</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>ID</th><th>V3</th><th>Profile</th><th>Secret</th><th>HMAC</th><th>Policy</th><th>Rotation</th><th>SEQ</th><th>RX Last</th><th>Missing</th><th>Dup</th><th>OOO</th><th>Blockers</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="15" class="empty">Device 없음</td></tr>'}</tbody></table></div></div></div>`;
}

async function renderAudit() {
  const { events } = await api(`/api/audit?query=${encodeURIComponent(auditQuery)}&type=${encodeURIComponent(auditType)}`);
  const types = [...new Set(events.map(x => x.type))].sort();
  content.innerHTML = `<div class="toolbar"><input id="audit-search" placeholder="이벤트 검색" value="${esc(auditQuery)}"><select id="audit-type"><option value="ALL">ALL</option>${types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select><button id="audit-search-btn">검색</button>${roleIsAdmin()?'<button class="danger" data-history-clean="AUDIT">CLEAN AUDIT</button>':''}</div>
  <div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Detail</th></tr></thead><tbody>${events.map(e => `<tr><td>${esc(fmtTime(e.time))}</td><td class="code">${esc(e.type)}</td><td>${esc(e.detail)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Audit 없음</td></tr>'}</tbody></table></div>`;
  const typeEl = document.getElementById('audit-type');
  if ([...typeEl.options].some(o => o.value === auditType)) typeEl.value = auditType;
}

async function renderActivity() {
  const { activities } = await api(`/api/admin-activity?query=${encodeURIComponent(activityQuery)}&limit=500`);
  content.innerHTML = `<div class="toolbar"><input id="activity-search" placeholder="Role / IP / API / Status 검색" value="${esc(activityQuery)}"><button id="activity-search-btn">검색</button><span class="small-note">비밀번호와 요청 본문은 기록하지 않습니다.</span></div>
  <div class="table-wrap"><table><thead><tr><th>Time</th><th>Role</th><th>IP</th><th>Method</th><th>API</th><th>Status</th><th>Action</th></tr></thead><tbody>${activities.map(a => `<tr><td>${esc(fmtTime(a.time))}</td><td>${badge(a.role)}</td><td class="code">${esc(a.ip || '-')}</td><td class="code">${esc(a.method)}</td><td class="code">${esc(a.path)}</td><td>${a.status >= 200 && a.status < 300 ? badge('OK') : badge('ERROR')} ${a.status}</td><td>${esc(a.action || '-')}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Activity 없음</td></tr>'}</tbody></table></div>`;
}

async function renderSessions() {
  const { sessions } = await api('/api/sessions');
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">ACTIVE SESSIONS</div><div class="stat-value">${sessions.length}</div><div class="stat-sub">Current session included</div></div><div class="card"><div class="stat-label">ADMIN</div><div class="stat-value">${sessions.filter(x => x.role === 'admin').length}</div><div class="stat-sub">Privileged sessions</div></div><div class="card"><div class="stat-label">OTHER ROLES</div><div class="stat-value">${sessions.filter(x => x.role !== 'admin').length}</div><div class="stat-sub">Operator / Viewer</div></div></div>
  <div class="toolbar"><button id="session-revoke-others-btn" class="warning">현재 세션 제외 전부 종료</button><button id="session-revoke-all-btn" class="danger">전체 세션 종료</button><span class="small-note">Session Token 원문은 화면/로그에 노출하지 않습니다.</span></div>
  <div class="table-wrap"><table><thead><tr><th>Session ID</th><th>Role</th><th>IP</th><th>Created</th><th>Last Active</th><th>Expires</th><th>Current</th><th>Action</th></tr></thead><tbody>${sessions.map(s => `<tr><td class="code">${esc(s.id)}</td><td>${badge(s.role)}</td><td class="code">${esc(s.ip || '-')}</td><td>${esc(fmtTime(s.createdAt))}</td><td>${esc(fmtTime(s.lastSeenAt))}</td><td>${esc(fmtTime(s.expiresAt))}</td><td>${s.current ? badge('CURRENT') : '-'}</td><td>${s.current ? '<span class="muted">현재 세션</span>' : `<button class="danger" data-session-revoke="${esc(s.id)}">Terminate</button>`}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Session 없음</td></tr>'}</tbody></table></div>`;
}

async function renderSystemHealth() {
  const [{ health: h }, { integrity }] = await Promise.all([api('/api/system/health'), api('/api/system/integrity')]);
  const o = h.overall;
  const db = h.database;
  const b = h.backup;
  const a = h.audit;
  const w = h.web;
  const n = h.node;
  const r = h.relay;
  content.innerHTML = `<div class="cards">
    <div class="card"><div class="stat-label">RELAY</div><div class="stat-value">${o.serviceEnabled ? 'ONLINE' : 'OFFLINE'}</div><div class="stat-sub">Uptime ${esc(fmtDuration(o.uptimeMs))}</div></div>
    <div class="card"><div class="stat-label">DATABASE</div><div class="stat-value">${db.exists && db.dataDirWritable && db.lastSaveOk ? 'OK' : 'CHECK'}</div><div class="stat-sub">${esc(fmtBytes(db.size))} · ${esc(fmtTime(db.lastSaveAt))}</div></div>
    <div class="card"><div class="stat-label">BACKUPS</div><div class="stat-value">${b.count}</div><div class="stat-sub">Latest ${esc(b.latest ? fmtTime(b.latest.mtimeMs) : '-')}</div></div>
    <div class="card"><div class="stat-label">WEB SESSIONS</div><div class="stat-value">${w.sessions.total}</div><div class="stat-sub">Admin ${w.sessions.roles.admin} · Operator ${w.sessions.roles.operator} · Viewer ${w.sessions.roles.viewer}</div></div>
    <div class="card"><div class="stat-label">DB INTEGRITY</div><div class="stat-value">${integrity.ok ? 'HEALTHY' : 'ERROR'}</div><div class="stat-sub">Errors ${integrity.errors.length} · Warnings ${integrity.warnings.length}</div></div>
  </div>
  <div class="panel-grid health-panels">
    <div class="section-card"><div class="section-head"><h3>Node Runtime</h3>${badge('ONLINE')}</div><div class="section-body"><div class="kv"><div>Node</div><div class="code">${esc(n.version)}</div><div>PID</div><div>${n.pid}</div><div>Platform</div><div>${esc(n.platform)} / ${esc(n.arch)}</div><div>Uptime</div><div>${esc(fmtDuration(n.uptimeMs))}</div><div>RSS</div><div>${esc(fmtBytes(n.rss))}</div><div>Heap</div><div>${esc(fmtBytes(n.heapUsed))} / ${esc(fmtBytes(n.heapTotal))}</div><div>CPU</div><div>${n.cpuCount} cores</div><div>Load 1/5/15m</div><div>${n.load1m} / ${n.load5m} / ${n.load15m}</div></div></div></div>
    <div class="section-card"><div class="section-head"><h3>Database</h3>${badge(db.exists && db.dataDirWritable && db.lastSaveOk ? 'GOOD' : 'WARNING')}</div><div class="section-body"><div class="kv"><div>File</div><div class="code">${esc(db.file)}</div><div>Exists</div><div>${badge(db.exists ? 'GOOD' : 'ERROR')}</div><div>Writable</div><div>${badge(db.dataDirWritable ? 'GOOD' : 'ERROR')}</div><div>Size</div><div>${esc(fmtBytes(db.size))}</div><div>Modified</div><div>${esc(fmtTime(db.mtimeMs))}</div><div>Last Save</div><div>${esc(fmtTime(db.lastSaveAt))}</div><div>Last Save Result</div><div>${badge(db.lastSaveOk ? 'GOOD' : 'ERROR')}</div></div></div></div>
    <div class="section-card"><div class="section-head"><h3>Backup / Audit</h3>${badge(b.writable && a.writable ? 'GOOD' : 'WARNING')}</div><div class="section-body"><div class="kv"><div>Backup Writable</div><div>${badge(b.writable ? 'GOOD' : 'ERROR')}</div><div>Backup Count</div><div>${b.count}</div><div>Latest Backup</div><div class="code">${esc(b.latest ? b.latest.file : '-')}</div><div>Latest Time</div><div>${esc(b.latest ? fmtTime(b.latest.mtimeMs) : '-')}</div><div>Audit Writable</div><div>${badge(a.writable ? 'GOOD' : 'ERROR')}</div><div>Audit Files</div><div>${a.count}</div><div>Latest Audit</div><div class="code">${esc(a.latest ? a.latest.file : '-')}</div></div></div></div>
    <div class="section-card"><div class="section-head"><h3>Relay Runtime</h3>${badge(o.serviceEnabled ? 'GOOD' : 'OFFLINE')}</div><div class="section-body"><div class="kv"><div>Servers</div><div>${r.serversOnline} online</div><div>Clients</div><div>${r.clientsOnline} online</div><div>Pending ACK</div><div>${r.pendingAcks}</div><div>Request Traces</div><div>${r.requestTraces}</div><div>Offline Queue</div><div>${r.offlineQueue||0}</div><div>Active DLQ</div><div>${r.activeDeadLetters||0}</div><div>Replayed</div><div>${r.replayedRequests||0}</div><div>Dequeued</div><div>${r.dequeuedRequests||0}</div><div>ACK OK</div><div>${r.ackOk}</div><div>ACK Error</div><div>${r.ackError}</div><div>ACK Timeout</div><div>${r.ackTimeout}</div><div>Retries</div><div>${r.ackRetries}</div><div>Connections</div><div>${r.connections}</div></div></div></div>
  </div><div class="section-card integrity-panel"><div class="section-head"><h3>Database Integrity</h3>${badge(integrity.ok ? 'GOOD' : 'ERROR')}</div><div class="section-body"><div class="stats-summary"><span>Servers <strong>${integrity.stats.servers || 0}</strong></span><span>Clients <strong>${integrity.stats.clients || 0}</strong></span><span>Licenses <strong>${integrity.stats.licenses || 0}</strong></span><span>Errors <strong>${integrity.errors.length}</strong></span><span>Warnings <strong>${integrity.warnings.length}</strong></span><button id="integrity-run-btn">RUN CHECK</button></div>${integrity.errors.length || integrity.warnings.length ? `<div class="integrity-list">${[...integrity.errors.map(x=>({...x,severity:'ERROR'})),...integrity.warnings.map(x=>({...x,severity:'WARNING'}))].map(x=>`<div class="integrity-row">${badge(x.severity)}<span class="code">${esc(x.code)}</span><span>${esc(x.message)}</span><span class="code">${esc(x.entity || '-')}</span></div>`).join('')}</div>` : '<div class="integrity-ok">[ DATABASE_HEALTHY ] No broken bindings or structural errors detected.</div>'}</div></div>`;
}

async function renderBackups() {
  const { backups } = await api('/api/backups');
  content.innerHTML = `<div class="toolbar">${roleIsAdmin() ? '<button id="backup-create-btn" class="primary">백업 생성</button>' : ''}<span class="small-note">Restore는 현재 Server/Client를 재접속시킵니다.</span></div>
  <div class="table-wrap"><table><thead><tr><th>File</th><th>Size</th><th>Created</th><th>Action</th></tr></thead><tbody>${backups.map(b => `<tr><td class="code">${esc(b.file)}</td><td>${esc(fmtBytes(b.size))}</td><td>${esc(fmtTime(b.mtimeMs))}</td><td><div class="actions"><button data-backup-action="verify" data-file="${esc(b.file)}">Verify</button>${roleIsAdmin() ? `<button data-open-view="danger" class="warning">Danger Zone</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Backup 없음</td></tr>'}</tbody></table></div>`;
}

async function renderLoadSimulator() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { simulator } = await api('/api/load-simulator');
  const p = simulator.presets || {};
  content.innerHTML = `<div class="section-card"><div class="section-head"><h3>External Load Simulator</h3>${badge('STAGING ONLY')}</div><div class="section-body">
    <p class="muted">운영 Relay 프로세스 내부에서 부하를 만들지 않습니다. 별도 PC/프로세스에서 <span class="code">tools/load-simulator.js</span>를 실행합니다.</p>
    <div class="warning-box">전용 Staging 배포에서 실행을 권장합니다. Simulator Client Identity는 테스트 DB에 남을 수 있습니다. FULL 모드는 임시 License를 생성하고 종료 시 자동 삭제합니다.</div>
    <div class="grid-2"><label>Relay Host<input id="load-relay-host" value="127.0.0.1"></label><label>Relay Port<input id="load-relay-port" type="number" value="3000"></label><label>Web Admin URL<input id="load-web-url" value="http://127.0.0.1:8080"></label><label>Mode<select id="load-mode"><option value="connect">CONNECT ONLY</option><option value="full">FULL LICENSE + SEND + ACK</option></select></label><label>Servers<input id="load-servers" type="number" min="1" max="500" value="${p.medium?.servers || 10}"></label><label>Clients<input id="load-clients" type="number" min="1" max="5000" value="${p.medium?.clients || 100}"></label><label>Requests / Client<input id="load-requests" type="number" min="0" max="100" value="${p.medium?.requestsPerClient || 1}"></label></div>
    <div class="actions"><button id="load-preset-smoke">SMOKE</button><button id="load-preset-medium">MEDIUM</button><button id="load-preset-heavy">HEAVY</button><button id="load-command-btn" class="primary">GENERATE COMMAND</button></div>
    <div class="terminal-box"><div class="small-note">COMMAND // FULL 모드에서는 마지막에 <span class="code">--admin-secret YOUR_SECRET</span>을 추가하거나 실행 환경에 ADMIN_SECRET을 설정하세요.</div><pre id="load-command-output" class="code-block">${esc(simulator.example || '')}</pre><button id="load-copy-btn">COPY</button></div>
  </div></div>`;
}

async function renderStorageMigration() {
  if (!roleIsAdmin()) throw new Error('FORBIDDEN');
  const { migration: m } = await api('/api/storage/migration/status');
  const s = m.sqlite || {};
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">ACTIVE STORAGE</div><div class="stat-value">${esc(m.activeProvider)}</div><div class="stat-sub">${m.switched ? 'AUTHORITATIVE' : 'COMPATIBILITY'}</div></div><div class="card"><div class="stat-label">SCHEMA</div><div class="stat-value">v${m.schemaVersion}</div><div class="stat-sub">Revision ${s.revision || 0}</div></div><div class="card"><div class="stat-label">INTEGRITY</div><div class="stat-value">${s.ok && m.ready ? 'GOOD' : 'CHECK'}</div><div class="stat-sub">${esc(s.file || '-')} · ${fmtBytes(s.size || 0)}</div></div><div class="card"><div class="stat-label">LICENSE REV</div><div class="stat-value">${m.licenseRevision}</div><div class="stat-sub">SQLite snapshot 기준</div></div></div>
    <div class="section-card"><div class="section-head"><h3>SQLite Primary Storage</h3>${badge(s.ok && m.ready ? 'GOOD' : 'WARNING')}</div><div class="section-body"><div class="kv"><div>Strategy</div><div class="code">${esc(m.strategy)}</div><div>Snapshot saved</div><div>${esc(fmtTime(s.savedAt))}</div><div>Source instance</div><div class="code">${esc(s.sourceInstance || '-')}</div><div>Servers</div><div>${m.counts.servers}</div><div>Clients</div><div>${m.counts.clients}</div><div>Licenses</div><div>${m.counts.licenses}</div><div>Device Secrets</div><div>${m.counts.deviceSecrets}</div><div>Data Dir</div><div class="code">${esc(m.dataDir)}</div></div>
    <p class="muted">SQLite가 실제 기본 저장소입니다. 기존 JSON은 최초 실행 시 자동 이관되며 이후에는 장애 복구용 미러로만 유지됩니다.</p>
    ${m.blockers?.length ? `<div class="warning-box">BLOCKERS: ${esc(m.blockers.join(', '))}</div>` : ''}
    <div class="actions"><button id="storage-schema-btn">VIEW SCHEMA</button><button id="storage-export-btn" class="primary" ${m.ready ? '' : 'disabled'}>CREATE MIGRATION BUNDLE</button></div><div id="storage-export-result" class="small-note"></div></div></div>`;
}

async function renderHA() {
  const { ha } = await api('/api/ha/status');
  const peer = ha.peer || {};
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">LOCAL ROLE</div><div class="stat-value">${esc(ha.role)}</div><div class="stat-sub">${esc(ha.instanceId)} · priority ${ha.priority}</div></div><div class="card"><div class="stat-label">TRAFFIC</div><div class="stat-value">${ha.acceptsTraffic ? 'ACTIVE' : 'BLOCKED'}</div><div class="stat-sub">Standby rejects TCP writes</div></div><div class="card"><div class="stat-label">PEER</div><div class="stat-value">${esc(peer.role || (ha.peerUrlConfigured ? 'WAITING' : 'NONE'))}</div><div class="stat-sub">${esc(peer.instanceId || '-')} · priority ${peer.priority || '-'}</div></div><div class="card"><div class="stat-label">REPLICATION</div><div class="stat-value">R${ha.lastReplicationRevision || 0}</div><div class="stat-sub">${esc(fmtTime(ha.lastReplicationAt))}</div></div></div>
    <div class="section-card"><div class="section-head"><h3>Active / Standby Coordinator</h3>${badge(ha.role)}</div><div class="section-body"><div class="kv"><div>Enabled / Configured</div><div>${badge(ha.enabled ? 'ONLINE' : 'DISABLED')} ${badge(ha.configured ? 'GOOD' : 'WARNING')}</div><div>Decision</div><div class="code">${esc(ha.reason)}</div><div>Last peer seen</div><div>${esc(fmtTime(ha.lastPeerSeenAt))}</div><div>Failover timeout</div><div>${ha.failoverTimeoutMs} ms</div><div>Last replication error</div><div class="code">${esc(ha.lastReplicationError || '-')}</div></div><div class="warning-box">두 Relay는 같은 <span class="code">HA_SHARED_SECRET</span>을 사용하고 서로의 Web Admin URL을 <span class="code">HA_PEER_URL</span>로 지정해야 합니다. 높은 priority가 Active이며 동률이면 instance ID가 작은 노드가 Active입니다.</div></div></div>`;
}

async function renderSystem() {
  const { system: s } = await api('/api/system');
  const schedule = s.maintenanceSchedule;
  content.innerHTML = `<div class="panel-grid">
    <div class="section-card"><div class="section-head"><h3>Service</h3>${badge(s.serviceEnabled ? 'ONLINE' : 'OFFLINE')}</div><div class="section-body"><div class="kv"><div>Maintenance</div><div>${badge(s.maintenanceMode ? 'ON' : 'OFF')}</div><div>Web Admin</div><div>v${esc(s.webAdminVersion || '-')}</div><div>Legacy TCP Admin</div><div>${badge(s.legacyTcpAdminEnabled ? 'ONLINE' : 'DISABLED')}</div><div>Data Dir</div><div class="code">${esc(s.dataDir)}</div><div>Max Clients / Server</div><div>${s.maxClientsPerServer}</div><div>Rate Limit</div><div>${s.rateLimit}/sec</div></div>${roleIsAdmin() ? `<div class="toolbar"><button id="service-start-btn">Service Start</button><button id="maint-on-btn" class="warning">Maintenance ON</button><button id="maint-off-btn">Maintenance OFF</button><button data-open-view="danger" class="danger">Danger Zone</button></div>` : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>Version Policy</h3></div><div class="section-body"><div class="form-grid"><label>Protocol<input id="version-protocol" type="number" min="1" max="${s.currentProtocolVersion}" value="${s.minProtocolVersion}"></label><label>Server<input id="version-server" value="${esc(s.minServerVersion)}"></label><label>Client<input id="version-client" value="${esc(s.minClientVersion)}"></label><label>Current Protocol<input disabled value="${s.currentProtocolVersion}"></label></div>${roleIsAdmin() ? '<button data-open-view="danger" class="warning">Danger Zone에서 변경</button>' : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>Maintenance Schedule / Auto Drain</h3>${s.maintenanceAutomation?.active ? badge(s.maintenanceAutomation.phase) : ''}</div><div class="section-body">${schedule ? `<div class="kv"><div>Start</div><div>${esc(fmtTime(schedule.startAt))}</div><div>End</div><div>${esc(fmtTime(schedule.endAt))}</div><div>Message</div><div>${esc(schedule.message)}</div><div>Auto Drain</div><div>${badge(schedule.autoDrain?'ON':'OFF')}</div><div>Drain Lead</div><div>${schedule.drainLeadMinutes||0} min</div><div>Force Start</div><div>${badge(schedule.forceStart?'ON':'OFF')}</div><div>Phase</div><div>${badge(s.maintenanceAutomation?.phase||'SCHEDULED')}</div><div>Live Clients</div><div>${s.maintenanceAutomation?.liveClients??0}</div><div>Auto-drained Servers</div><div>${s.maintenanceAutomation?.autoDrainedServers??0}</div></div>${s.maintenanceAutomation?.phase==='WAITING_FOR_DRAIN'?'<div class="warning-box">예약 시각이 지났지만 Client가 남아 있어 Maintenance 진입을 기다리고 있습니다. Drain은 Client를 강제 종료하지 않습니다.</div>':''}` : '<p class="muted">예약된 Maintenance가 없습니다.</p>'}${roleIsAdmin() ? '<div class="toolbar"><button id="schedule-create-btn">예약 설정</button><button id="schedule-clear-btn">예약 제거</button></div>' : ''}</div></div>
    <div class="section-card"><div class="section-head"><h3>Notice</h3></div><div class="section-body"><p class="muted">현재 온라인 Client 전체에 공지를 전송합니다.</p>${roleCanOperate() ? '<button id="notice-all-btn">전체 공지 보내기</button>' : ''}</div></div>
  </div>`;
}
