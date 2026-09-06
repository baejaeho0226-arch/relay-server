'use strict';

function terminalWrite(kind, text) {
  terminalLines.push({ time: Date.now(), kind: String(kind || 'out'), text: kind === 'cmd' ? String(text || '') : uiText(text) });
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
  const commands = { '도움말':'help','상태':'status','서버':'server','앱':'client',
    '라이선스':'license','점검':'maintenance','백업':'backup','버전':'version','공지':'notice',
    '열기':'open','검색':'search','지우기':'clear' };
  const operations = { '목록':'list','보기':'show','차단':'kick','비활성':'disable','활성':'enable',
    '정리':'drain','켜기':'on','끄기':'off','이동':'move','검색':'find','상태':'status','생성':'create','전체':'all' };
  a[0] = commands[a[0]] || a[0];
  a[1] = operations[a[1]] || a[1];
  if (a[1] === 'drain') a[2] = operations[a[2]] || a[2];
  if (a[0] === 'open') a[1] = Object.keys(titles).find(k => titles[k][0] === a[1]) || a[1];
  const cmd = String(a[0] || '').toLowerCase();
  const sub = String(a[1] || '').toLowerCase();
  try {
    if (cmd === 'clear') { terminalLines = []; return; }
    if (cmd === 'help' || cmd === '?') {
      terminalWrite('ok', [
        '허용된 관리 명령만 실행합니다.',
        '상태', '서버 목록', '서버 보기 <식별자>', '서버 차단|비활성|활성 <식별자>',
        '서버 정리 켜기|끄기 <식별자>', '앱 목록', '앱 보기 <식별자>',
        '앱 차단|비활성|활성 <식별자>', '앱 이동 <앱식별자> <서버식별자>',
        '라이선스 검색 <검색어>', '점검 상태|켜기|끄기', '백업 목록|생성',
        '버전 상태', '공지 전체 <내용>', '열기 <메뉴>', '검색 <검색어>', '지우기'
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
  content.innerHTML = `<div class="terminal-panel command-terminal"><div class="terminal-head"><span>중계 서버 관리 명령 · 허용 목록 적용</span><div class="actions"><button id="terminal-help-btn">도움말</button><button id="terminal-clear-btn">지우기</button></div></div><div id="command-terminal-output" class="command-terminal-output">${terminalLines.map(x=>`<div class="terminal-output-line ${esc(x.kind)}"><span>${esc(fmtTime(x.time))}</span><pre>${esc(x.text)}</pre></div>`).join('')}</div><form id="command-terminal-form" class="command-terminal-form"><span>중계 서버-관리자 &gt;</span><input id="command-terminal-input" autocomplete="off" spellcheck="false" placeholder="도움말"><button class="primary" type="submit">실행</button></form><div class="terminal-safety">허용된 관리 명령만 실행하며 관리자 권한 정책을 적용합니다.</div></div>`;
  const output=document.getElementById('command-terminal-output'); if(output) output.scrollTop=output.scrollHeight;
  const input=document.getElementById('command-terminal-input'); if(input) setTimeout(()=>input.focus(),10);
}

