"use strict";
const crypto = require('crypto');
const state = require('../core/state');
const { Now, SendLine } = require('../core/utils');
const identity = require('../identity/identityManager');
const installation = require('./clientInstallation');
const knowledge = require('./supportKnowledge');
const Save = () => require('../storage/database').SaveDatabase();
const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
const hash = value => crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
const validId = id => /^[A-Za-z0-9_-]{8,64}$/.test(String(id || ''));
const CLOSE_MESSAGE = '관리자에 의해 상담이 종료되었습니다. 추가 문의가 있으시면 메시지를 남겨주세요. 새로운 상담으로 이어서 도와드리겠습니다.';
const DEFAULT_SETTINGS = Object.freeze({ hours: '상담시간 미설정', greeting: '궁금한 내용을 남겨주세요.', responseGuide: '오프라인 문의도 보관됩니다. 관리자가 확인 후 답변합니다.' });
function ValidateText(text) {
    return typeof text === 'string' && text.trim().length > 0 && text.length <= 1000 &&
        Buffer.byteLength(text, 'utf8') <= 4000 && !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text);
}
function Decode(text) {
    if (typeof text !== 'string' || text.length > 8000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
    const bytes = Buffer.from(text, 'base64');
    const decoded = bytes.toString('utf8');
    return bytes.toString('base64') === text && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : null;
}
function Allowed(c) {
    return c && c.clientId && identity.GetOnlineClient(c.clientId) === c &&
        require('./clientPermissions').Ready(c) && c.deviceAuthVerified && !c.reinstallBlocked && installation.Ready(c);
}
function Binding(deviceKey, saved, c) {
    const key = installation.RegistryKey(deviceKey);
    const token = c && c.installationToken || saved && saved.installationToken || '';
    return { deviceKey: key || hash('SUPPORT-LEGACY:' + deviceKey),
        tokenHash: token ? hash('SUPPORT-TOKEN:' + token) : hash('SUPPORT-LEGACY-INSTALL:' + deviceKey) };
}
function NewThread(id, binding, clientId) {
    return { clientId: id, currentClientId: clientId, aliases: [clientId], ...binding,
        tokenHashes: [binding.tokenHash], revision: 1, epoch: crypto.randomUUID(), status: 'OPEN',
        nextSeq: 1, updatedAt: Now(), unreadAdmin: 0, messages: [], device: {} };
}
// A CLIENT row is a routing address. This persisted room owns a separate ID,
// installation credential hashes and device metadata, even after CLIENT deletion.
function Backfill() {
    let changed = false;
    for (const t of state.supportThreads.values()) {
        if (t.deviceKey) continue;
        const key = identity.FindClientDeviceKey(t.currentClientId || t.clientId);
        if (!key) continue;
        const b = Binding(key, identity.GetSavedClientByID(t.currentClientId || t.clientId));
        Object.assign(t, b, { tokenHashes: [b.tokenHash] });
        changed = true;
    }
    return changed;
}
function Resolve(c, create = true) {
    Backfill();
    const deviceKey = identity.FindClientDeviceKey(c.clientId);
    const saved = identity.GetSavedClientByID(c.clientId);
    const b = Binding(deviceKey, saved, c);
    const candidates = [...state.supportThreads.values()].filter(t => t.deviceKey === b.deviceKey);
    let t = candidates.find(t => t.tokenHashes.includes(b.tokenHash));
    // A different installation cannot read the previous owner's messages just
    // by claiming ANDROID_ID. Link only after new QR + biometric authorization.
    const registry = state.clientInstallations.get(installation.RegistryKey(deviceKey));
    const approved = installation.WasAuthorized(saved) && registry &&
        registry.authorized.some(x => x.deviceKey === deviceKey && x.token && hash('SUPPORT-TOKEN:' + x.token) === b.tokenHash);
    if (approved && candidates.length) {
        const canonical = candidates.slice().sort((a, b) => a.createdAt - b.createdAt || a.clientId.localeCompare(b.clientId))[0];
        if (t && t !== canonical) {
            for (const m of t.messages) if (!canonical.messages.some(x => x.id === m.id && x.role === m.role))
                canonical.messages.push({ ...m, seq: canonical.nextSeq++ });
            canonical.unreadAdmin += t.unreadAdmin;
            canonical.aliases = [...new Set([...canonical.aliases, ...t.aliases])];
            Object.assign(canonical.device, t.device);
            state.supportThreads.delete(t.clientId);
        }
        t = canonical;
        if (!t.tokenHashes.includes(b.tokenHash)) t.tokenHashes.push(b.tokenHash);
    }
    if (!t && create && state.supportThreads.size < 5000) {
        // Keep the first legacy CLIENT ID as the room's permanent public ID.
        let id = c.clientId;
        while (state.supportThreads.has(id)) id = crypto.randomBytes(8).toString('hex').toUpperCase();
        t = NewThread(id, b, c.clientId); t.createdAt = Now();
        state.supportThreads.set(id, t);
    }
    if (t) {
        if (!t.aliases.includes(c.clientId)) t.aliases.push(c.clientId);
        t.currentClientId = c.clientId;
        c.supportRoomId = t.clientId;
    }
    return t;
}
function Room(id) { return state.supportThreads.get(String(id || '').toUpperCase()); }
function Live(t) {
    return [...state.clients.values()].filter(c => Allowed(c) && c.supportRoomId === t.clientId);
}
function Presence(session, active) {
    if (!session || session.role !== 'admin' || !session.id) return { ok: false, reason: 'ADMIN_REQUIRED' };
    // Compatibility for older tabs: page heartbeats never change availability.
    return { ok: true, ...Info() };
}
function Availability(session, mode) {
    if (!session || session.role !== 'admin' || !session.id) return { ok: false, reason: 'ADMIN_REQUIRED' };
    if (!['ONLINE', 'OFFLINE'].includes(mode)) return { ok: false, reason: 'INVALID_SUPPORT_AVAILABILITY' };
    const old = state.supportSettings;
    state.supportSettings = { ...old, adminOnline: mode === 'ONLINE' };
    if (!Save()) { state.supportSettings = old; return { ok: false, reason: 'STORAGE_SAVE_FAILED' }; }
    for (const t of state.supportThreads.values()) for (const c of Live(t)) PushInfo(c, t);
    return { ok: true, settings: Info() };
}
function Info(t) {
    return { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k=>[k,state.supportSettings[k]||DEFAULT_SETTINGS[k]])), mode:t?.mode||'HUMAN', adminOnline: state.supportSettings.adminOnline === true,
        baseSeq: t && t.messages.length ? t.messages[0].seq - 1 : 0, roomId: t && t.clientId || '', status: t && t.status || 'OPEN', epoch: t && t.epoch || '', revision: t && t.revision || 1 };
}
function Settings(value) {
    if (!value || !['hours', 'greeting', 'responseGuide'].every(k => typeof value[k] === 'string' && value[k].trim() && value[k].length <= 160 && !/[\x00-\x1F]/.test(value[k])))
        return { ok: false, reason: 'INVALID_SUPPORT_SETTINGS' };
    const old = state.supportSettings;
    state.supportSettings = { ...old, ...Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, value[k].trim()])) };
    if (!Save()) { state.supportSettings = old; return { ok: false, reason: 'STORAGE_SAVE_FAILED' }; }
    return { ok: true, settings: Info() };
}
function Append(t, role, id, text, revision) {
    if (!validId(id) || !ValidateText(text)) return { ok: false, reason: 'INVALID_MESSAGE' };
    if (!t) return { ok: false, reason: 'SUPPORT_CAPACITY' };
    if ((revision != null && Number(revision) !== t.revision) || (t.revision > 1 && revision == null)) return { ok: false, reason: 'HISTORY_CHANGED' };
    if (role === 'ADMIN' && t.status !== 'OPEN') return { ok: false, reason: 'SUPPORT_CLOSED' };
    const duplicate = t.messages.find(m => m.id === id && m.role === role);
    if (duplicate) return duplicate.text === text.trim() ? { ok: true, message: duplicate, replies:t.messages.filter(m=>m.replyTo===id), duplicate: true } : { ok: false, reason: 'MESSAGE_ID_CONFLICT' };
    const old = structuredClone(t);
    if(role==='CLIENT'&&t.status!=='OPEN'&&t.botStarted)t.mode='BOT';
    const message = { seq: t.nextSeq++, id, role, text: text.trim(), at: Now(), epoch: t.epoch };
    t.messages = [...t.messages, message]; // Never silently discard old conversations.
    t.updatedAt = message.at; t.status = 'OPEN';
    const replies=[];
    if (role === 'ADMIN') t.mode='HUMAN';
    if (role === 'CLIENT' && t.mode==='BOT') {
        const answer=knowledge.Answer(text,Info(t));
        const reply={seq:t.nextSeq++,id:'BOT_'+hash(id).slice(0,40),role:'BOT',text:answer.text,at:Now(),epoch:t.epoch,replyTo:id};
        t.messages.push(reply);replies.push(reply);
        if(answer.handoff){t.mode='HUMAN';t.unreadAdmin++;}
    } else if (role === 'CLIENT') t.unreadAdmin++;
    if (!Save()) { Object.assign(t, old); return { ok: false, reason: 'STORAGE_SAVE_FAILED' }; }
    return { ok: true, message, replies };
}
function StartBot(t) {
    if(t.botStarted && t.status==='OPEN')return {ok:true};
    const old=structuredClone(t);t.botStarted=true;t.mode='BOT';t.status='OPEN';
    const message={seq:t.nextSeq++,id:crypto.randomUUID(),role:'BOT',text:'안녕하세요. FAQ 안내 봇입니다. 충전, 게임 이용권, 프로필 등 궁금한 내용을 적어주세요. 확인이 필요한 문의는 상담원 연결로 이어갈 수 있습니다.',at:Now(),epoch:t.epoch};
    t.messages=[...t.messages,message];t.updatedAt=message.at;
    if(!Save()){Object.assign(t,old);return {ok:false,reason:'STORAGE_SAVE_FAILED'};}
    return {ok:true};
}
function PushInfo(c, t) { SendLine(c.socket, `SUPPORT_INFO|${encode(Info(t))}`); }
function Handle(c, line) {
    const error = reason => SendLine(c.socket, `SUPPORT_ERROR|${reason}`);
    if (!Allowed(c)) { error('AUTH_REQUIRED'); return; }
    const p = line.split('|');
    if (['SUPPORT_OPEN', 'SUPPORT_SYNC', 'SUPPORT_STATUS', 'SUPPORT_HELP', 'SUPPORT_BOT_OPEN'].includes(p[0]) && p[1] !== c.clientId) { error('CLIENT_NOT_OWNER'); return; }
    if (p[0]==='SUPPORT_HELP' && p.length===2) {
        if(Now()-(c.supportHelpAt||0)<500)return;
        c.supportHelpAt=Now();SendLine(c.socket,'SUPPORT_HELP_DATA|'+encode({...Info(),faq:knowledge.Public(),knowledgeRevision:knowledge.Admin().revision}));return;
    }
    const oldRoom = c.supportRoomId && Room(c.supportRoomId);
    const currentBinding = Binding(identity.FindClientDeviceKey(c.clientId), identity.GetSavedClientByID(c.clientId), c);
    const needsResolve = !oldRoom || !oldRoom.tokenHashes.includes(currentBinding.tokenHash) || oldRoom.currentClientId !== c.clientId || (installation.WasAuthorized(identity.GetSavedClientByID(c.clientId)) && !c.supportApprovedResolved);
    const before = needsResolve ? JSON.stringify([...state.supportThreads]) : '';
    const t = needsResolve ? Resolve(c) : oldRoom;
    c.supportApprovedResolved = installation.WasAuthorized(identity.GetSavedClientByID(c.clientId));
    if (!t) { error('SUPPORT_CAPACITY'); return; }
    if (needsResolve && before !== JSON.stringify([...state.supportThreads]) && !Save()) {
        state.supportThreads.clear(); for (const [id, raw] of JSON.parse(before)) state.supportThreads.set(id, raw);
        error('STORAGE_SAVE_FAILED'); return;
    }
    if(p[0]==='SUPPORT_BOT_OPEN' && p.length===2){
        const started=StartBot(t);if(!started.ok){error(started.reason);return;}
        PushInfo(c,t);return;
    }
    if (p[0] === 'SUPPORT_STATUS' && p.length === 2) {
        if (Now() - (c.supportStatusAt || 0) < 5000) return;
        c.supportStatusAt = Now(); PushInfo(c, t); return;
    }
    if (p[0] === 'SUPPORT_DEVICE' && p.length === 2) {
        if (Now() - (c.supportDeviceAt || 0) < 1000) { error('RATE_LIMIT'); return; }
        let data; try { data = JSON.parse(Decode(p[1])); } catch (_) {}
        const fields = ['manufacturer', 'product', 'model', 'os', 'phone', 'phoneStatus', 'serial', 'serialStatus', 'imei', 'imeiStatus'];
        if (!data || typeof data !== 'object' || !fields.every(k => data[k] == null || typeof data[k] === 'string' && data[k].length <= 120 && !/[\x00-\x1F]/.test(data[k]))) { error('INVALID_DEVICE_INFO'); return; }
        const old = t.device;
        t.device = Object.fromEntries(fields.map(k => [k, data[k] || '']));
        if (!Save()) { t.device = old; error('STORAGE_SAVE_FAILED'); return; }
        c.supportDeviceAt = Now(); return;
    }
    if (p[0] === 'SUPPORT_SYNC' && p.length === 4) {
        const after = Number(p[3]);
        if (!Number.isSafeInteger(after) || after < 0) { error('INVALID_CURSOR'); return; }
        if (Now() - (c.supportSyncAt || 0) < 100) { error('RATE_LIMIT'); return; }
        c.supportSyncAt = Now();
        PushInfo(c, t);
        const reset = p[2] !== t.epoch || after >= t.nextSeq || after < Info(t).baseSeq;
        if (reset) SendLine(c.socket, `SUPPORT_RESET|${encode(Info(t))}`);
        const messages = t.messages.filter(m => m.seq > (reset ? 0 : after)).slice(0, 100);
        for (const m of messages) SendLine(c.socket, `SUPPORT_MESSAGE|${encode({ ...m, epoch: t.epoch })}`);
        const lastSeq = messages.length ? messages.at(-1).seq : reset ? 0 : after;
        SendLine(c.socket, `SUPPORT_PAGE|${encode({ epoch: t.epoch, lastSeq, more: t.messages.some(m => m.seq > lastSeq) })}`);
        return;
    }
    if (p[0] === 'SUPPORT_OPEN' && p.length === 2) {
        if (Now() - (c.lastSupportOpenAt || 0) < 1000) { error('RATE_LIMIT'); return; }
        c.lastSupportOpenAt = Now(); c.supportLegacyRevision = t.revision;
        PushInfo(c, t); SendLine(c.socket, 'SUPPORT_HISTORY_BEGIN');
        for (const m of t.messages.slice(-60)) SendLine(c.socket, `SUPPORT_MESSAGE|${encode(m)}`);
        SendLine(c.socket, 'SUPPORT_HISTORY_END'); return;
    }
    const v2 = p[0] === 'SUPPORT_SEND_V2';
    if ((!v2 && p[0] !== 'SUPPORT_SEND') || p.length !== (v2 ? 4 : 3)) { error('INVALID_MESSAGE'); return; }
    const text = Decode(p[v2 ? 3 : 2]);
    const duplicate = t.messages.some(m => m.id === p[1] && m.role === 'CLIENT');
    if (!duplicate && Now() - (c.lastSupportSendAt || 0) < 1000) { error('RATE_LIMIT'); return; }
    const result = Append(t, 'CLIENT', p[1], text, v2 ? p[2] : c.supportLegacyRevision);
    if (!result.ok) { error(result.reason); return; }
    c.lastSupportSendAt = Now(); SendLine(c.socket, `SUPPORT_MESSAGE|${encode(result.message)}`);
    for(const message of result.replies||[])SendLine(c.socket,`SUPPORT_MESSAGE|${encode(message)}`);
    PushInfo(c, t);
    if (!result.duplicate && t.mode!=='BOT') {
        require('./notificationCenter').AddNotification({ severity: 'INFO', type: 'CUSTOMER_SUPPORT', title: '고객센터 새 문의', message: `상담 ${t.clientId}`, entityType: 'CLIENT', entityId: c.clientId });
        require('../storage/audit').LogEvent('CUSTOMER_SUPPORT_MESSAGE', t.clientId);
    }
}
function List() {
    return [...state.supportThreads.values()].filter(t => t.status !== 'DELETED').map(t => ({ clientId: t.clientId, currentClientId: t.currentClientId,
        status: t.status, mode:t.mode||'HUMAN', device: t.device, updatedAt: t.updatedAt, unreadAdmin: t.unreadAdmin, online: Live(t).length > 0,
        lastMessage: t.messages.length ? t.messages.at(-1).text.slice(0, 100) : '' })).sort((a, b) => b.updatedAt - a.updatedAt);
}
function Read(id, before = 0) {
    const t = Room(id); if (!t) return null;
    const filtered = t.messages.filter(m => !before || m.seq < Number(before));
    const messages = filtered.slice(-100);
    return { ...Info(t), clientId: t.clientId, currentClientId: t.currentClientId, device: t.device, messages,
        hasMore: filtered.length > messages.length, online: Live(t).length > 0, total: t.messages.length };
}
function MarkRead(id, throughSeq, revision) {
    const t = Room(id); if (!t) return { ok: false, reason: 'SUPPORT_NOT_FOUND' };
    if ((revision != null && Number(revision) !== t.revision) || (revision == null && t.revision > 1)) return { ok: false, reason: 'HISTORY_CHANGED' };
    const old = t.unreadAdmin;
    t.unreadAdmin = t.messages.filter(m => m.role === 'CLIENT' && m.seq > Number(throughSeq || 0)).length;
    if (!Save()) { t.unreadAdmin = old; return { ok: false, reason: 'STORAGE_SAVE_FAILED' }; }
    return { ok: true };
}
function Reply(id, text, requestId, revision) {
    const t = Room(id); if (!t) return { ok: false, reason: 'SUPPORT_NOT_FOUND' };
    const result = Append(t, 'ADMIN', requestId || crypto.randomUUID(), text, revision);
    if (result.ok) {
        for (const live of Live(t)){PushInfo(live,t);SendLine(live.socket, `SUPPORT_MESSAGE|${encode(result.message)}`);}
        require('../storage/audit').LogEvent('CUSTOMER_SUPPORT_REPLY', id);
    }
    return result;
}
function Change(id, action, revision) {
    const t = Room(id); if (!t) return { ok: false, reason: 'SUPPORT_NOT_FOUND' };
    if (Number(revision) !== t.revision) return { ok: false, reason: 'HISTORY_CHANGED' };
    if (!['close', 'reopen', 'delete'].includes(action)) return { ok: false, reason: 'INVALID_ACTION' };
    if ((action === 'close' && t.status === 'CLOSED') || (action === 'reopen' && t.status === 'OPEN') ||
        (action === 'delete' && t.status === 'DELETED')) return { ok: true, thread: Read(id) };
    if (t.status === 'DELETED') return { ok: false, reason: 'SUPPORT_DELETED' };
    const old = structuredClone(t);
    let closingMessage;
    if (action === 'delete') {
        t.messages = []; t.unreadAdmin = 0; t.nextSeq = 1; t.epoch = crypto.randomUUID(); t.revision++; t.status = 'DELETED';
    } else if (action === 'close') {
        closingMessage = { seq: t.nextSeq++, id: crypto.randomUUID(), role: 'SYSTEM', text: CLOSE_MESSAGE, at: Now(), epoch: t.epoch };
        t.messages = [...t.messages, closingMessage];
        t.status = 'CLOSED'; t.unreadAdmin = 0;
    }
    else if (action === 'reopen') t.status = 'OPEN';
    else return { ok: false, reason: 'INVALID_ACTION' };
    t.updatedAt = Now();
    if (!Save()) { Object.assign(t, old); return { ok: false, reason: 'STORAGE_SAVE_FAILED' }; }
    for (const live of Live(t)) {
        live.supportLegacyRevision = null;
        if (action === 'delete') SendLine(live.socket, `SUPPORT_RESET|${encode(Info(t))}`);
        if (closingMessage) SendLine(live.socket, `SUPPORT_MESSAGE|${encode(closingMessage)}`);
        PushInfo(live, t);
    }
    require('../storage/audit').LogEvent('CUSTOMER_SUPPORT_' + action.toUpperCase(), id);
    return { ok: true, thread: Read(id) };
}
function ImportPersisted(data) {
    const restoredKnowledge=knowledge.Import(data.supportSettings||{});
    state.supportThreads.clear();
    state.supportSettings = { ...DEFAULT_SETTINGS, ...restoredKnowledge };
    state.supportSettings.adminOnline = data.supportSettings && data.supportSettings.adminOnline === true;
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (data.supportSettings && typeof data.supportSettings[k] === 'string' && data.supportSettings[k].length <= 160)
        state.supportSettings[k] = data.supportSettings[k];
    for (const [id, raw] of Object.entries(data.supportThreads || {}).slice(0, 5000)) {
        if (!/^[0-9A-F]{16}$/.test(id) || !raw || !Array.isArray(raw.messages)) continue;
        const messages = raw.messages.filter(m => m && validId(m.id) && ValidateText(m.text) && ['CLIENT', 'ADMIN', 'SYSTEM', 'BOT'].includes(m.role) && Number.isSafeInteger(m.seq) && m.seq > 0).sort((a, b) => a.seq - b.seq);
        const epoch = validId(raw.epoch) ? raw.epoch : crypto.randomUUID();
        state.supportThreads.set(id, { clientId: id, currentClientId: raw.currentClientId || id, aliases: Array.isArray(raw.aliases) ? raw.aliases : [id],
            createdAt: Number(raw.createdAt) || Number(raw.updatedAt) || Now(), deviceKey: raw.deviceKey || '', tokenHashes: Array.isArray(raw.tokenHashes) ? raw.tokenHashes : [],
            epoch, mode:raw.mode==='BOT'?'BOT':'HUMAN', botStarted:raw.botStarted===true, revision: Math.max(1, Number(raw.revision) || 1), status: ['CLOSED', 'DELETED'].includes(raw.status) ? raw.status : 'OPEN',
            messages: raw.status === 'DELETED' ? [] : messages.map(m => ({ ...m, epoch })), nextSeq: messages.reduce((max, m) => Math.max(max, m.seq), 0) + 1,
            device: raw.device && typeof raw.device === 'object' ? raw.device : {}, updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
            unreadAdmin: Math.min(messages.length, Math.max(0, Number(raw.unreadAdmin) || 0)) });
    }
    Backfill();
}
module.exports = { Handle, List, Read, Reply, MarkRead, Change, ImportPersisted, Backfill, Presence, Availability, Info, Settings };
