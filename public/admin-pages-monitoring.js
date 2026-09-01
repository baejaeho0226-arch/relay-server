'use strict';

// MONITORING PAGES

function renderStatsPanel(stats) {
  const rows = stats.buckets || [];
  return `<div class="section-card stats-panel"><div class="section-head"><h3>Traffic Statistics</h3><div class="actions"><button data-stats-range="1H" class="${statsRange==='1H'?'primary':''}">1H</button><button data-stats-range="6H" class="${statsRange==='6H'?'primary':''}">6H</button><button data-stats-range="24H" class="${statsRange==='24H'?'primary':''}">24H</button><button data-stats-range="7D" class="${statsRange==='7D'?'primary':''}">7D</button></div></div><div class="stats-grid"><div class="chart-box"><div class="chart-title">CONNECTION / SEND</div>${svgLineChart(rows,[{key:'connections',label:'Connections'},{key:'sends',label:'SEND'}])}</div><div class="chart-box"><div class="chart-title">ACK RESULT</div>${svgLineChart(rows,[{key:'ackOk',label:'ACK OK'},{key:'ackError',label:'ACK ERROR'},{key:'ackTimeout',label:'TIMEOUT'}])}</div></div><div class="stats-summary"><span>Connections <strong>${stats.totals.connections}</strong></span><span>SEND <strong>${stats.totals.sends}</strong></span><span>ACK OK <strong>${stats.totals.ackOk}</strong></span><span>Error <strong>${stats.totals.ackError}</strong></span><span>Timeout <strong>${stats.totals.ackTimeout}</strong></span><span>Success <strong>${stats.totals.ackSuccessRate}%</strong></span></div></div>`;
}

async function renderDashboard() {
  const [{ dashboard: d }, { statistics: stats }] = await Promise.all([api('/api/dashboard'), api(`/api/statistics?range=${encodeURIComponent(statsRange)}`)]);
  content.innerHTML = `
    <div class="cards">
      <div class="card"><div class="stat-label">SERVERS</div><div class="stat-value">${d.servers.online} / ${d.servers.total}</div><div class="stat-sub">Disabled ${d.servers.disabled} · Draining ${d.servers.draining}</div></div>
      <div class="card"><div class="stat-label">CLIENTS</div><div class="stat-value">${d.clients.online} / ${d.clients.total}</div><div class="stat-sub">Disabled ${d.clients.disabled}</div></div>
      <div class="card"><div class="stat-label">QR AUTH PENDING</div><div class="stat-value">${d.qrAuth.pending}</div><div class="stat-sub">Approved ${d.qrAuth.approved} · Rejected ${d.qrAuth.rejected}</div></div>
      <div class="card"><div class="stat-label">QR LICENSES</div><div class="stat-value">${d.licenses.bound}</div><div class="stat-sub">Available ${d.licenses.available} · Expired ${d.licenses.expired}</div></div>
      <div class="card"><div class="stat-label">ACK SUCCESS</div><div class="stat-value">${d.ack.successRate}%</div><div class="stat-sub">Pending ${d.ack.pending} · Timeout ${d.ack.timeout}</div></div>
      <div class="card"><div class="stat-label">ALERTS</div><div class="stat-value">${d.notifications.unread}</div><div class="stat-sub">Critical ${d.notifications.critical} · Warning ${d.notifications.warning}</div></div>
      <div class="card"><div class="stat-label">SERVICE</div><div class="stat-value">${d.serviceEnabled ? 'ONLINE' : 'OFFLINE'}</div><div class="stat-sub">Maintenance ${d.maintenanceMode ? 'ON' : 'OFF'}</div></div>
      <div class="card"><div class="stat-label">UPTIME</div><div class="stat-value">${esc(fmtDuration(d.uptimeMs))}</div><div class="stat-sub">Connections ${d.totalConnections}</div></div>
      <div class="card"><div class="stat-label">VERSION</div><div class="stat-value">P${d.versions.protocol}</div><div class="stat-sub">Server ${esc(d.versions.server)} · Client ${esc(d.versions.client)}</div></div>
      <div class="card"><div class="stat-label">RECOVERY</div><div class="stat-value">${d.recovery.queued} / ${d.recovery.deadLetters}</div><div class="stat-sub">Queue / Active DLQ · Replay ${d.recovery.replayed}</div></div>
      <div class="card"><div class="stat-label">RELAY HA</div><div class="stat-value">${esc(d.ha.role)}</div><div class="stat-sub">${esc(d.ha.instanceId)} · ${d.ha.acceptsTraffic ? 'TRAFFIC ON' : 'READ ONLY'}</div></div>
    </div>
    ${renderStatsPanel(stats)}
    <div class="section-card"><div class="section-head"><h3>Server Distribution</h3><button data-open-view="distribution">OPEN DISTRIBUTION</button></div><div class="section-body"><p class="muted">Server별 Live/Binding Client 부하와 Graceful Drain 진행률을 확인합니다.</p></div></div>
    <div class="section-card"><div class="section-head"><h3>License Expiry Radar</h3><span class="small-note">CLICK TO FILTER</span></div><div class="section-body"><div class="expiry-grid">
      <button class="expiry-card critical" data-license-expiry="EXPIRED"><span>EXPIRED</span><strong>${d.licenseExpiry.expired}</strong></button>
      <button class="expiry-card critical" data-license-expiry="1D"><span>≤ 24 HOURS</span><strong>${d.licenseExpiry.within1d}</strong></button>
      <button class="expiry-card warning" data-license-expiry="3D"><span>≤ 3 DAYS</span><strong>${d.licenseExpiry.within3d}</strong></button>
      <button class="expiry-card warning" data-license-expiry="7D"><span>≤ 7 DAYS</span><strong>${d.licenseExpiry.within7d}</strong></button>
      <button class="expiry-card" data-license-expiry="30D"><span>≤ 30 DAYS</span><strong>${d.licenseExpiry.within30d}</strong></button>
    </div></div></div>
    <div class="grid-2">
      <div class="section-card"><div class="section-head"><h3>최근 이벤트</h3><span class="small-note">최근 30건</span></div><div class="section-body"><div class="event-list">
        ${d.recentEvents.length ? d.recentEvents.map(e => `<div class="event"><span>${esc(fmtTime(e.time))}</span><span class="type">${esc(e.type)}</span><span>${esc(e.detail)}</span></div>`).join('') : '<div class="empty">이벤트 없음</div>'}
      </div></div></div>
      <div class="section-card"><div class="section-head"><h3>License 상태</h3></div><div class="section-body"><div class="kv">
        <div>Available</div><div>${d.licenses.available}</div><div>Bound</div><div>${d.licenses.bound}</div><div>Suspended</div><div>${d.licenses.suspended}</div><div>Expired</div><div>${d.licenses.expired}</div><div>Total</div><div>${d.licenses.total}</div>
      </div></div></div>
    </div>`;
}

async function renderConsole() {
  if (!consoleHistoryLoaded) {
    const { events } = await api('/api/audit');
    if (!liveConsoleEvents.length) liveConsoleEvents = events.slice(-300);
    consoleHistoryLoaded = true;
  }
  content.innerHTML = `<div class="terminal-panel"><div class="terminal-head"><span>LIVE_EVENT_STREAM</span><div class="actions"><button id="console-pause-btn">${consolePaused ? 'Resume' : 'Pause'}</button><button id="console-clear-btn">Clear</button></div></div><div id="live-console-list" class="live-console">${liveConsoleEvents.slice(-300).map(e => `<div class="console-line"><span class="console-time">${esc(fmtTime(e.time))}</span><span class="console-type">${esc(e.type)}</span><span class="console-detail">${esc(e.detail)}</span></div>`).join('') || '<div class="empty">이벤트 없음</div>'}</div></div>`;
  const list = document.getElementById('live-console-list');
  if (list) list.scrollTop = list.scrollHeight;
}

async function renderTrace() {
  const { traces } = await api(`/api/request-traces?query=${encodeURIComponent(traceQuery)}`);
  traceRows = new Map(traces.map(t => [t.key, t]));
  content.innerHTML = `<div class="toolbar"><input id="trace-search" placeholder="Request ID / Client / Server / Number" value="${esc(traceQuery)}"><button id="trace-search-btn">Trace</button><span class="small-note">최근 10분 / Replay는 반드시 새 Request ID 사용</span></div><div class="table-wrap"><table><thead><tr><th>Request ID</th><th>Source</th><th>Client</th><th>Server</th><th>Number</th><th>Status</th><th>Retry</th><th>Duration</th><th>Forwarded</th><th>Action</th></tr></thead><tbody>${traces.map(t => `<tr><td class="code">${esc(t.requestId)}</td><td>${esc(t.source||'CLIENT')}</td><td class="code">${esc(t.clientId)}</td><td class="code">${esc(t.serverId)}</td><td class="code">${esc(t.number)}</td><td>${badge(t.status)}</td><td>${t.retries}</td><td>${t.completedAt ? `${t.durationMs} ms` : '-'}</td><td>${esc(fmtTime(t.forwardedAt))}</td><td><div class="actions"><button data-trace-detail="${esc(t.key)}">상세</button>${roleIsAdmin()&&['ERROR','TIMEOUT','DLQ'].includes(String(t.status||'').toUpperCase())?`<button class="warning" data-trace-replay="${esc(t.key)}">REPLAY</button>`:''}</div></td></tr>`).join('') || '<tr><td colspan="10" class="empty">Trace 없음</td></tr>'}</tbody></table></div>`;
}

async function renderMonitor() {
  const [{ servers }, { clients }] = await Promise.all([api('/api/servers'), api('/api/clients')]);
  const serverGood = servers.filter(x => x.health === 'GOOD').length;
  const clientGood = clients.filter(x => x.health === 'GOOD').length;
  const problemServers = servers.filter(x => !['GOOD', 'OFFLINE'].includes(x.health)).length;
  const problemClients = clients.filter(x => !['GOOD', 'OFFLINE'].includes(x.health)).length;
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">SERVER GOOD</div><div class="stat-value">${serverGood}</div><div class="stat-sub">Problems ${problemServers}</div></div><div class="card"><div class="stat-label">CLIENT GOOD</div><div class="stat-value">${clientGood}</div><div class="stat-sub">Problems ${problemClients}</div></div><div class="card"><div class="stat-label">SERVER ONLINE</div><div class="stat-value">${servers.filter(x => x.online).length}</div><div class="stat-sub">Total ${servers.length}</div></div><div class="card"><div class="stat-label">CLIENT ONLINE</div><div class="stat-value">${clients.filter(x => x.online).length}</div><div class="stat-sub">Total ${clients.length}</div></div></div><div class="section-card monitor-section"><div class="section-head"><h3>Server Health</h3><span class="small-note">AUTO REFRESH // 3 SEC</span></div><div class="table-wrap"><table><thead><tr><th>Alias</th><th>SERVER-ID</th><th>Status</th><th>Health</th><th>RTT</th><th>ACK</th><th>Clients</th><th>Reconnect</th><th>Last Seen</th></tr></thead><tbody>${servers.map(x => `<tr><td>${esc(x.alias || '-')}</td><td class="code">${esc(x.id)}</td><td>${badge(x.status)}</td><td>${badge(x.health)}</td><td>${x.rttMs >= 0 ? `${x.rttMs} ms` : '-'}</td><td>${x.ack.successRate}% <span class="muted">(${x.ack.ok}/${x.ack.error}/${x.ack.timeout})</span></td><td>${x.clients} / ${x.savedClients}</td><td>${x.reconnectCount}</td><td>${esc(fmtTime(x.lastSeen))}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Server 없음</td></tr>'}</tbody></table></div></div><div class="section-card monitor-section"><div class="section-head"><h3>Client Health</h3><span class="small-note">AUTO REFRESH // 3 SEC</span></div><div class="table-wrap"><table><thead><tr><th>Alias</th><th>CLIENT-ID</th><th>Status</th><th>Health</th><th>RTT</th><th>ACK</th><th>Server</th><th>Send</th><th>Reconnect</th></tr></thead><tbody>${clients.map(x => `<tr><td>${esc(x.alias || '-')}</td><td class="code">${esc(x.id)}</td><td>${badge(x.status)}</td><td>${badge(x.health)}</td><td>${x.rttMs >= 0 ? `${x.rttMs} ms` : '-'}</td><td>${x.ack.successRate}% <span class="muted">(${x.ack.ok}/${x.ack.error}/${x.ack.timeout})</span></td><td class="code">${esc(x.serverAlias || x.serverId)}</td><td>${x.sendCount}</td><td>${x.reconnectCount}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Client 없음</td></tr>'}</tbody></table></div></div>`;
}


function terminalWrite(kind, text) {
  terminalLines.push({ time: Date.now(), kind: String(kind || 'out'), text: String(text || '') });
  if (terminalLines.length > 500) terminalLines = terminalLines.slice(-500);
}

function terminalTokenize(line) {
  const out = [];
  String(line || '').replace(/"([^"]*)"|'([^']*)'|([^\s]+)/g, (_, a, b, c) => { out.push(a ?? b ?? c ?? ''); return ''; });
  return out;
}

function terminalObjectLines(items, formatter, limit = 30) {
  const rows = (items || []).slice(0, limit).map(formatter);
  if ((items || []).length > limit) rows.push(`... ${(items || []).length - limit} more`);
  return rows.join('\n') || '(empty)';
}

async function executeTerminalCommand(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) return;
  terminalHistory.push(line);
  if (terminalHistory.length > 100) terminalHistory.shift();
  terminalHistoryIndex = terminalHistory.length;
  terminalWrite('cmd', `relay-admin > ${line}`);
  const a = terminalTokenize(line);
  const cmd = String(a[0] || '').toLowerCase();
  const sub = String(a[1] || '').toLowerCase();
  try {
    if (cmd === 'clear') { terminalLines = []; return; }
    if (cmd === 'help' || cmd === '?') {
      terminalWrite('ok', [
        'SAFE COMMAND SET // no OS shell',
        'status', 'server list', 'server show <id>', 'server kick|disable|enable <id>', 'server drain on|off <id>',
        'client list', 'client show <id>', 'client kick|disable|enable <id>', 'client move <clientId> <serverId>',
        'license find <query>', 'maintenance status|on|off', 'backup list|create', 'version status',
        'notice all <message>', 'open <dashboard|servers|clients|licenses|backups|health|system|danger>', 'search <query>', 'clear'
      ].join('\n'));
      return;
    }
    if (cmd === 'status') {
      const { dashboard: d } = await api('/api/dashboard');
      terminalWrite('ok', `SERVICE=${d.serviceEnabled ? 'ONLINE' : 'OFFLINE'} MAINT=${d.maintenanceMode ? 'ON' : 'OFF'} SERVERS=${d.servers.online}/${d.servers.total} CLIENTS=${d.clients.online}/${d.clients.total} ACK=${d.ack.successRate}% PENDING=${d.ack.pending}`);
      return;
    }
    if (cmd === 'server' && sub === 'list') {
      const { servers } = await api('/api/servers');
      terminalWrite('ok', terminalObjectLines(servers, s => `${s.alias || '-'} ${s.id} ${s.status}/${s.health} CLIENTS=${s.clients}/${s.savedClients}${s.drain && s.drain.active ? ` DRAIN=${s.drain.progress}%` : ''}`)); return;
    }
    if (cmd === 'server' && sub === 'show' && a[2]) {
      const { server: s } = await api(`/api/servers/${encodeURIComponent(a[2])}`);
      terminalWrite('ok', JSON.stringify({ id:s.id, alias:s.alias, status:s.status, health:s.health, clients:s.clients, savedClients:s.savedClients, rttMs:s.rttMs, drain:s.drain }, null, 2)); return;
    }
    if (cmd === 'server' && ['kick','disable','enable'].includes(sub) && a[2]) { await serverAction(sub, a[2]); terminalWrite('ok', `SERVER ${sub.toUpperCase()} OK ${a[2]}`); return; }
    if (cmd === 'server' && sub === 'drain' && ['on','off'].includes(String(a[2]||'').toLowerCase()) && a[3]) { await serverAction(`drain-${String(a[2]).toLowerCase()}`, a[3]); terminalWrite('ok', `SERVER DRAIN ${String(a[2]).toUpperCase()} OK ${a[3]}`); return; }
    if (cmd === 'client' && sub === 'list') {
      const { clients } = await api('/api/clients');
      terminalWrite('ok', terminalObjectLines(clients, c => `${c.alias || '-'} ${c.id} ${c.status}/${c.health} SERVER=${c.serverAlias || c.serverId} LICENSE=${c.licenseStatus}`)); return;
    }
    if (cmd === 'client' && sub === 'show' && a[2]) {
      const { client: c } = await api(`/api/clients/${encodeURIComponent(a[2])}`);
      terminalWrite('ok', JSON.stringify({ id:c.id, alias:c.alias, status:c.status, health:c.health, serverId:c.serverId, licenseStatus:c.licenseStatus, rttMs:c.rttMs }, null, 2)); return;
    }
    if (cmd === 'client' && ['kick','disable','enable'].includes(sub) && a[2]) { await clientAction(sub, a[2]); terminalWrite('ok', `CLIENT ${sub.toUpperCase()} OK ${a[2]}`); return; }
    if (cmd === 'client' && sub === 'move' && a[2] && a[3]) { await api(`/api/clients/${encodeURIComponent(a[2])}/move`, { method:'POST', body:{ serverId:a[3] } }); terminalWrite('ok', `CLIENT MOVE OK ${a[2]} -> ${a[3]}`); return; }
    if (cmd === 'license' && sub === 'find') {
      const q = a.slice(2).join(' '); const { licenses } = await api(`/api/licenses?query=${encodeURIComponent(q)}&status=ALL&expiry=ALL`);
      terminalWrite('ok', terminalObjectLines(licenses, x => `${x.key} ${x.status} CLIENT=${x.boundClient || '-'} TAGS=${(x.tags||[]).join(',') || '-'}`)); return;
    }
    if (cmd === 'maintenance' && sub === 'status') { const { system:s }=await api('/api/system'); terminalWrite('ok', `MAINTENANCE=${s.maintenanceMode?'ON':'OFF'} SERVICE=${s.serviceEnabled?'ONLINE':'OFFLINE'} SCHEDULE=${s.maintenanceSchedule?`${fmtTime(s.maintenanceSchedule.startAt)} -> ${fmtTime(s.maintenanceSchedule.endAt)}`:'NONE'}`); return; }
    if (cmd === 'maintenance' && ['on','off'].includes(sub)) { await api(`/api/system/maintenance/${sub}`, {method:'POST',body:{}}); terminalWrite('ok', `MAINTENANCE ${sub.toUpperCase()} OK`); return; }
    if (cmd === 'backup' && sub === 'list') { const {backups}=await api('/api/backups'); terminalWrite('ok', terminalObjectLines(backups, b=>`${b.file} ${fmtBytes(b.size)} ${fmtTime(b.mtimeMs)}`)); return; }
    if (cmd === 'backup' && sub === 'create') { const r=await api('/api/backups/create',{method:'POST',body:{}}); terminalWrite('ok', `BACKUP CREATED ${r.file}`); return; }
    if (cmd === 'version' && sub === 'status') { const {system:s}=await api('/api/system'); terminalWrite('ok', `PROTOCOL=${s.minProtocolVersion}/${s.currentProtocolVersion} SERVER>=${s.minServerVersion} CLIENT>=${s.minClientVersion} WEB=${s.webAdminVersion}`); return; }
    if (cmd === 'notice' && sub === 'all' && a.length >= 3) { const message=a.slice(2).join(' '); const r=await api('/api/system/notice',{method:'POST',body:{message}}); terminalWrite('ok', `NOTICE SENT ${r.count}`); return; }
    if (cmd === 'open' && a[1]) { const view=String(a[1]).toLowerCase(); if (!titles[view]) throw new Error('UNKNOWN_VIEW'); if (view==='danger'&&!roleIsAdmin()) throw new Error('FORBIDDEN'); switchView(view); await renderCurrent(); return; }
    if (cmd === 'search' && a.length >= 2) { openPalette(); const q=a.slice(1).join(' '); const input=document.getElementById('palette-input'); if(input){input.value=q; await runPaletteSearch(q);} return; }
    throw new Error('UNKNOWN_COMMAND // type help');
  } catch (error) {
    terminalWrite('error', error.message || String(error));
  }
}

async function renderTerminal() {
  if (!terminalLines.length) terminalWrite('ok', 'RELAY SAFE COMMAND TERMINAL // type help // OS SHELL DISABLED');
  content.innerHTML = `<div class="terminal-panel command-terminal"><div class="terminal-head"><span>RELAY_COMMAND_CHANNEL // ALLOWLIST ONLY</span><div class="actions"><button id="terminal-help-btn">Help</button><button id="terminal-clear-btn">Clear</button></div></div><div id="command-terminal-output" class="command-terminal-output">${terminalLines.map(x=>`<div class="terminal-output-line ${esc(x.kind)}"><span>${esc(fmtTime(x.time))}</span><pre>${esc(x.text)}</pre></div>`).join('')}</div><form id="command-terminal-form" class="command-terminal-form"><span>relay-admin &gt;</span><input id="command-terminal-input" autocomplete="off" spellcheck="false" placeholder="help"><button class="primary" type="submit">EXEC</button></form><div class="terminal-safety">ALLOWLIST COMMANDS ONLY // NO PROCESS EXEC // NO SHELL // API PERMISSIONS STILL ENFORCED</div></div>`;
  const output=document.getElementById('command-terminal-output'); if(output) output.scrollTop=output.scrollHeight;
  const input=document.getElementById('command-terminal-input'); if(input) setTimeout(()=>input.focus(),10);
}

function distributionBar(value, max, cls='live') {
  const pct = Math.max(0, Math.min(100, max > 0 ? (Number(value||0)/max)*100 : 0));
  return `<div class="distribution-meter"><i class="${esc(cls)}" style="width:${pct.toFixed(1)}%"></i></div><span class="distribution-pct">${pct.toFixed(1)}%</span>`;
}

async function renderDistribution() {
  const [{ servers }, { system }] = await Promise.all([api('/api/servers'), api('/api/system')]);
  const max = Number(system.maxClientsPerServer || 1);
  const sorted = [...servers].sort((a,b)=>b.savedClients-a.savedClients || b.clients-a.clients);
  const totalLive=sorted.reduce((n,x)=>n+x.clients,0), totalSaved=sorted.reduce((n,x)=>n+x.savedClients,0);
  content.innerHTML = `<div class="cards"><div class="card"><div class="stat-label">TOTAL LIVE</div><div class="stat-value">${totalLive}</div><div class="stat-sub">Active Client sockets</div></div><div class="card"><div class="stat-label">TOTAL BINDINGS</div><div class="stat-value">${totalSaved}</div><div class="stat-sub">Persistent Client → Server</div></div><div class="card"><div class="stat-label">CAPACITY</div><div class="stat-value">${sorted.length*max}</div><div class="stat-sub">${max} / Server</div></div><div class="card"><div class="stat-label">DRAINING</div><div class="stat-value">${sorted.filter(x=>x.drain&&x.drain.active).length}</div><div class="stat-sub">Ready ${sorted.filter(x=>x.drain&&x.drain.ready).length}</div></div></div><div class="section-card"><div class="section-head"><h3>Server Client Distribution</h3><span class="small-note">AUTO REFRESH // 3 SEC</span></div><div class="distribution-list">${sorted.map(s=>`<div class="distribution-row"><div class="distribution-id"><strong>${esc(s.alias||s.id)}</strong><small>${esc(s.id)}</small>${badge(s.status)} ${badge(s.health)}</div><div class="distribution-load"><label>LIVE <b>${s.clients}/${max}</b></label>${distributionBar(s.clients,max,'live')}<label>BINDINGS <b>${s.savedClients}/${max}</b></label>${distributionBar(s.savedClients,max,'saved')}</div><div class="distribution-drain">${s.drain&&s.drain.active?`<div class="drain-label">DRAIN // ${s.drain.ready?'<strong>READY FOR MAINTENANCE</strong>':`${s.drain.currentClients} ACTIVE`}</div><div class="drain-progress"><i style="width:${s.drain.progress}%"></i></div><div class="small-note">${s.drain.progress}% // start ${esc(fmtTime(s.drain.startedAt))} // initial ${s.drain.initialClients}</div>`:`<span class="small-note">ACCEPT CLIENTS: ${s.canAcceptClients?'YES':'NO'}</span>`}</div>${roleIsAdmin()?`<div class="actions">${s.drain&&s.drain.active?`<button data-server-action="drain-off" data-id="${esc(s.id)}">Drain OFF</button>`:`<button data-server-action="drain-on" data-id="${esc(s.id)}">Drain ON</button>`}</div>`:''}</div>`).join('')||'<div class="empty">Server 없음</div>'}</div></div>`;
}


async function renderFailover() {
  const [{ failover:f }, { servers }] = await Promise.all([api('/api/failover'), api('/api/servers')]);
  failoverServers = servers || [];
  failoverRows = new Map((f.clients||[]).map(x=>[x.clientId,x]));
  const p=f.policy||{}, sum=f.summary||{};
  const rows=(f.clients||[]).map(c=>{
    const stateLabel=c.failedOver?'FAILED_OVER':(c.enabled?'ARMED':'OFF');
    const action=roleIsAdmin()?`<div class="actions"><button data-binding-edit="${esc(c.clientId)}">Binding</button>${c.bindingConfigured?`<button data-binding-clear="${esc(c.clientId)}">Clear</button>`:''}<button data-failover-toggle="${esc(c.clientId)}" data-enabled="${c.enabled?'0':'1'}">${c.enabled?'Opt-out':'Opt-in'}</button>${c.failedOver?`<button class="warning" data-failover-return="${esc(c.clientId)}">Return Primary</button>`:''}</div>`:'-';
    return `<tr><td class="code">${esc(c.clientId)}</td><td>${badge(stateLabel)}</td><td>${c.bindingConfigured?badge('CONFIGURED'):badge('AUTO')}</td><td class="code">${esc(c.primaryServerId||'-')}</td><td class="code">${esc(c.backupServerId||'-')}</td><td class="code">${esc(c.currentServerId||'-')}</td><td>${badge(c.primaryStatus||'UNKNOWN')}</td><td>${badge(c.backupStatus||'NOT_CONFIGURED')}</td><td>${c.allowAutomaticFallback?'YES':'NO'}</td><td>${c.moveCount||0}</td><td>${esc(c.selectedBy||c.reason||'-')}</td><td>${esc(fmtTime(c.failedOverAt))}</td><td>${action}</td></tr>`;
  }).join('');
  content.innerHTML=`<div class="cards">
    <div class="card"><div class="stat-label">GLOBAL POLICY</div><div class="stat-value">${p.enabled?'ON':'OFF'}</div><div class="stat-sub">기본 OFF · opt-in only</div></div>
    <div class="card"><div class="stat-label">OPT-IN CLIENTS</div><div class="stat-value">${sum.optedIn||0}</div><div class="stat-sub">Total ${sum.totalClients||0}</div></div>
    <div class="card"><div class="stat-label">FAILED OVER</div><div class="stat-value">${sum.failedOver||0}</div><div class="stat-sub">temporary bindings</div></div>
    <div class="card"><div class="stat-label">PRIMARY DOWN</div><div class="stat-value">${sum.primaryUnavailable||0}</div><div class="stat-sub">armed / waiting grace</div></div>
    <div class="card"><div class="stat-label">EXPLICIT BINDINGS</div><div class="stat-value">${sum.configuredBindings||0}</div><div class="stat-sub">Primary + Backup policy</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>Emergency Failover Policy</h3><span class="small-note">Primary binding preserved // Drain does not trigger failover</span></div><div class="section-body">
    <div class="form-grid">
      <label>Global<select id="failover-policy-enabled"><option value="0" ${p.enabled?'':'selected'}>OFF</option><option value="1" ${p.enabled?'selected':''}>ON</option></select></label>
      <label>Auto Return<select id="failover-auto-return"><option value="1" ${p.autoReturn?'selected':''}>ON</option><option value="0" ${p.autoReturn?'':'selected'}>OFF</option></select></label>
      <label>Offline Grace (sec)<input id="failover-offline-grace" type="number" min="0" max="3600" value="${Number(p.offlineGraceSeconds||15)}"></label>
      <label>Return Grace (sec)<input id="failover-return-grace" type="number" min="0" max="3600" value="${Number(p.returnGraceSeconds||30)}"></label>
      <label>Max Moves / Cycle<input id="failover-max-moves" type="number" min="1" max="1000" value="${Number(p.maxMovesPerCycle||50)}"></label>
    </div>
    ${roleIsAdmin()?'<div class="toolbar"><button id="failover-policy-save" class="primary">SAVE POLICY</button><button id="failover-run-now">EVALUATE NOW</button></div>':''}
    <div class="warning-box">Emergency Failover는 기존 고정 SERVER-ID를 삭제하지 않습니다. Failover record에 Primary를 보존하고, 장애 시에만 임시 Binding으로 이동합니다. Maintenance 중에는 자동 이동을 멈춥니다.</div>
  </div></div>
  <div class="section-card"><div class="section-head"><h3>Primary / Backup Binding Matrix</h3><span class="small-note">명시적 Backup 우선 · 선택적으로 자동 대체</span></div><div class="section-body"><div class="table-wrap"><table><thead><tr><th>Client</th><th>Mode</th><th>Binding</th><th>Primary</th><th>Backup</th><th>Current</th><th>Primary Status</th><th>Backup Status</th><th>Auto Fallback</th><th>Moves</th><th>Selection</th><th>Failed At</th><th>Action</th></tr></thead><tbody>${rows||'<tr><td colspan="13" class="empty">Client 없음</td></tr>'}</tbody></table></div></div></div>`;
}

async function renderRecovery() {
  const { recovery:r } = await api(`/api/request-recovery?query=${encodeURIComponent(recoveryQuery)}`);
  const p=r.policy||{}, s=r.summary||{};
  const clientRows=(r.clients||[]).map(x=>`<tr><td class="code">${esc(x.clientId)}</td><td class="code">${esc(x.serverId)}</td><td>${badge(x.enabled?'ON':'OFF')}</td><td>${x.queued}</td><td>${x.deadLetters}</td><td>${roleIsAdmin()?`<button data-queue-toggle="${esc(x.clientId)}" data-enabled="${x.enabled?'0':'1'}">${x.enabled?'Disable':'Enable'}</button>`:'-'}</td></tr>`).join('');
  const queueRows=(r.queue||[]).map(x=>`<tr><td class="code">${esc(x.queueId)}</td><td class="code">${esc(x.requestId)}</td><td class="code">${esc(x.clientId)}</td><td class="code">${esc(x.serverId||'-')}</td><td class="code">${esc(x.number)}</td><td>${x.attempts}</td><td>${esc(x.reason)}</td><td>${esc(fmtTime(x.queuedAt))}</td><td>${esc(fmtTime(x.expiresAt))}</td></tr>`).join('');
  const dlqRows=(r.deadLetters||[]).map(x=>`<tr><td class="code">${esc(x.deadLetterId)}</td><td>${badge(x.status)}</td><td class="code">${esc(x.originalRequestId)}</td><td class="code">${esc(x.clientId)}</td><td class="code">${esc(x.serverId||'-')}</td><td class="code">${esc(x.number)}</td><td>${esc(x.reason)}</td><td>${x.attempts}</td><td>${esc(fmtTime(x.failedAt))}</td><td>${x.status==='ACTIVE'&&roleIsAdmin()?`<div class="actions"><button class="warning" data-dlq-retry="${esc(x.deadLetterId)}">RETRY</button><button data-dlq-discard="${esc(x.deadLetterId)}">DISCARD</button></div>`:(x.lastReplayRequestId?`<span class="code">${esc(x.lastReplayRequestId)}</span>`:'-')}</td></tr>`).join('');
  content.innerHTML=`<div class="cards">
    <div class="card"><div class="stat-label">OFFLINE QUEUE</div><div class="stat-value">${p.enabled?'ON':'OFF'}</div><div class="stat-sub">opt-in clients ${s.enabledClients||0}</div></div>
    <div class="card"><div class="stat-label">QUEUED</div><div class="stat-value">${s.queued||0}</div><div class="stat-sub">ordered per Client</div></div>
    <div class="card"><div class="stat-label">ACTIVE DLQ</div><div class="stat-value">${s.activeDeadLetters||0}</div><div class="stat-sub">operator action required</div></div>
    <div class="card"><div class="stat-label">RESOLVED DLQ</div><div class="stat-value">${(s.replayedDeadLetters||0)+(s.discardedDeadLetters||0)}</div><div class="stat-sub">Replay ${s.replayedDeadLetters||0} · Discard ${s.discardedDeadLetters||0}</div></div>
  </div>
  <div class="section-card"><div class="section-head"><h3>Offline Queue Policy</h3><span class="small-note">기본 OFF · Client별 opt-in · FIFO</span></div><div class="section-body"><div class="form-grid">
    <label>Global<select id="queue-policy-enabled"><option value="0" ${p.enabled?'':'selected'}>OFF</option><option value="1" ${p.enabled?'selected':''}>ON</option></select></label>
    <label>Max / Client<input id="queue-policy-max" type="number" min="1" max="1000" value="${Number(p.maxItemsPerClient||100)}"></label>
    <label>TTL (sec)<input id="queue-policy-ttl" type="number" min="30" max="604800" value="${Number(p.ttlSeconds||3600)}"></label>
    <label>Delivery Attempts<input id="queue-policy-attempts" type="number" min="1" max="50" value="${Number(p.maxDeliveryAttempts||5)}"></label>
  </div>${roleIsAdmin()?'<div class="toolbar"><button id="queue-policy-save" class="primary">SAVE POLICY</button></div>':''}<div class="warning-box">Queue는 Client별 입력 순서를 보존합니다. 재전송에는 동일 Request ID를 사용해 WinSockServer RequestCache의 중복 처리 방지를 유지합니다.</div></div></div>
  <div class="section-card"><div class="section-head"><h3>Client Queue Opt-in</h3></div><div class="table-wrap"><table><thead><tr><th>Client</th><th>Current Server</th><th>Queue</th><th>Queued</th><th>Active DLQ</th><th>Action</th></tr></thead><tbody>${clientRows||'<tr><td colspan="6" class="empty">Client 없음</td></tr>'}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>Offline Queue</h3><span class="small-note">서버 복구 후 자동 전달</span></div><div class="table-wrap"><table><thead><tr><th>Queue ID</th><th>Request</th><th>Client</th><th>Target</th><th>Number</th><th>Attempts</th><th>Reason</th><th>Queued At</th><th>Expires</th></tr></thead><tbody>${queueRows||'<tr><td colspan="9" class="empty">Queued Request 없음</td></tr>'}</tbody></table></div></div>
  <div class="section-card"><div class="section-head"><h3>Dead Letter Queue</h3><div class="actions"><input id="recovery-search" placeholder="DLQ / Request / Client / Reason" value="${esc(recoveryQuery)}"><button id="recovery-search-btn">SEARCH</button></div></div><div class="table-wrap"><table><thead><tr><th>DLQ ID</th><th>Status</th><th>Original Request</th><th>Client</th><th>Server</th><th>Number</th><th>Reason</th><th>Attempts</th><th>Failed At</th><th>Action / Replay</th></tr></thead><tbody>${dlqRows||'<tr><td colspan="10" class="empty">Dead Letter 없음</td></tr>'}</tbody></table></div></div>`;
}

async function renderDangerZone() {
  if (!roleIsAdmin()) { content.innerHTML='<div class="empty">FORBIDDEN</div>'; return; }
  const [{ system:s }, { backups }, { licenses }] = await Promise.all([api('/api/system'), api('/api/backups'), api('/api/licenses?status=ALL&expiry=ALL')]);
  content.innerHTML = `<div class="danger-banner"><strong>!! DANGER ZONE !!</strong><span>위험 작업은 영향 범위를 확인한 뒤 Web 모달에서 한 번 더 승인합니다. 별도 확인 문구 입력은 사용하지 않습니다.</span></div><div class="danger-grid">
    <div class="section-card danger-card"><div class="section-head"><h3>Service Stop</h3>${badge(s.serviceEnabled?'ONLINE':'OFFLINE')}</div><div class="section-body"><p class="muted">모든 Client 인증을 해제하고 Relay 서비스를 중지합니다.</p><button id="danger-service-stop" class="danger">STOP SERVICE</button></div></div>
    <div class="section-card danger-card"><div class="section-head"><h3>Backup Restore / Delete</h3><span class="small-note">${backups.length} FILES</span></div><div class="section-body"><label>Backup<select id="danger-backup-file">${backups.map(b=>`<option value="${esc(b.file)}">${esc(b.file)} // ${esc(fmtBytes(b.size))}</option>`).join('')}</select></label><div class="actions"><button id="danger-backup-restore" class="danger" ${backups.length?'':'disabled'}>RESTORE BACKUP</button><button id="danger-backup-delete" class="danger" ${backups.length?'':'disabled'}>DELETE BACKUP</button></div></div></div>
    <div class="section-card danger-card"><div class="section-head"><h3>Version Force Apply</h3><span class="small-note">CURRENT P${s.currentProtocolVersion}</span></div><div class="section-body"><div class="form-grid"><label>Protocol<input id="danger-version-protocol" type="number" min="1" max="${s.currentProtocolVersion}" value="${s.minProtocolVersion}"></label><label>Server<input id="danger-version-server" value="${esc(s.minServerVersion)}"></label><label>Client<input id="danger-version-client" value="${esc(s.minClientVersion)}"></label></div><button id="danger-version-apply" class="danger">APPLY VERSION POLICY</button></div></div>
    <div class="section-card danger-card"><div class="section-head"><h3>Bulk License Delete</h3><span class="small-note">${licenses.length} TOTAL</span></div><div class="section-body"><p class="muted">License Key를 줄바꿈/쉼표로 입력합니다. 최대 500개.</p><label>License Keys<textarea id="danger-license-keys" placeholder="KEY1\nKEY2"></textarea></label><button id="danger-license-delete" class="danger">DELETE LICENSES</button></div></div>
  </div><div class="section-card danger-card future-danger"><div class="section-head"><h3>Database Reset</h3>${badge('DISABLED')}</div><div class="section-body"><p class="muted">의도적으로 구현하지 않았습니다. DB 삭제/초기화는 Web Admin에서 제공하지 않습니다.</p></div></div>`;
}

async function updateNotificationBadge() {
  if (!session || !notificationBadge) return;
  try {
    const { summary } = await api('/api/notifications?limit=1');
    notificationBadge.textContent = summary.unread > 99 ? '99+' : String(summary.unread);
    notificationBadge.classList.toggle('hidden', summary.unread <= 0);
    notificationBadge.classList.toggle('critical', summary.critical > 0);
  } catch (_) {}
}

async function updateQrAuthBadge() {
  if (!session || session.role !== 'admin' || !qrAuthBadge) return;
  try {
    const { summary } = await api('/api/qr-auth');
    qrAuthBadge.textContent = summary.pending > 99 ? '99+' : String(summary.pending);
    qrAuthBadge.classList.toggle('hidden', summary.pending <= 0);
    qrAuthBadge.classList.toggle('critical', summary.pending > 0);
  } catch (_) {}
}

