'use strict';
const crypto = require('crypto');
const state = require('../core/state');
const { Now, SendLine } = require('../core/utils');
const identity = require('../identity/identityManager');
const Save = () => require('../storage/database').SaveDatabase();
const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
const validId = id => /^[A-Za-z0-9_-]{8,64}$/.test(String(id || ''));
function ValidateText(text) {
    return typeof text === 'string' && text.trim().length > 0 && text.length <= 1000 &&
        Buffer.byteLength(text, 'utf8') <= 4000 && !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text);
}
function Thread(clientId, create = false) {
    if (!state.supportThreads.has(clientId) && create && state.supportThreads.size < 5000)
        state.supportThreads.set(clientId, { clientId, nextSeq: 1, updatedAt: Now(), unreadAdmin: 0, messages: [] });
    return state.supportThreads.get(clientId);
}
function Append(clientId, role, id, text) {
    if (!validId(id) || !ValidateText(text)) return { ok: false, reason: 'INVALID_MESSAGE' };
    const thread = Thread(clientId, true);
    if (!thread) return { ok: false, reason: 'SUPPORT_CAPACITY' };
    const duplicate = thread.messages.find(m => m.id === id && m.role === role);
    if (duplicate) return duplicate.text === text.trim() ? { ok: true, message: duplicate, duplicate: true } : { ok: false, reason: 'MESSAGE_ID_CONFLICT' };
    const old = { nextSeq: thread.nextSeq, updatedAt: thread.updatedAt, unreadAdmin: thread.unreadAdmin, messages: thread.messages };
    const message = { seq: thread.nextSeq++, id, role, text: text.trim(), at: Now() };
    thread.messages = [...thread.messages, message].slice(-200);
    thread.updatedAt = message.at;
    if (role === 'CLIENT') thread.unreadAdmin++;
    if (!Save()) { Object.assign(thread, old); return { ok: false, reason: 'STORAGE_SAVE_FAILED' }; }
    return { ok: true, message };
}
function Allowed(connection) {
    return connection && connection.clientId && identity.GetOnlineClient(connection.clientId) === connection &&
        connection.deviceAuthVerified && !connection.reinstallBlocked && require('./clientInstallation').Ready(connection);
}
function Handle(connection, line) {
    if (!Allowed(connection)) { SendLine(connection.socket, 'SUPPORT_ERROR|AUTH_REQUIRED'); return; }
    const parts = line.split('|');
    if (parts[0] === 'SUPPORT_OPEN') {
        if (parts.length !== 2 || parts[1] !== connection.clientId) { SendLine(connection.socket, 'SUPPORT_ERROR|CLIENT_NOT_OWNER'); return; }
        if (Now() - (connection.lastSupportOpenAt || 0) < 1000) { SendLine(connection.socket, 'SUPPORT_ERROR|RATE_LIMIT'); return; }
        connection.lastSupportOpenAt = Now();
        const thread = Thread(connection.clientId);
        SendLine(connection.socket, 'SUPPORT_HISTORY_BEGIN');
        if (thread) for (const m of thread.messages.slice(-60)) SendLine(connection.socket, `SUPPORT_MESSAGE|${encode(m)}`);
        SendLine(connection.socket, 'SUPPORT_HISTORY_END');
        return;
    }
    if (parts.length !== 3 || !validId(parts[1]) || parts[2].length > 6000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(parts[2])) {
        SendLine(connection.socket, 'SUPPORT_ERROR|INVALID_MESSAGE'); return;
    }
    const bytes = Buffer.from(parts[2], 'base64');
    const messageText = bytes.toString('utf8');
    if (bytes.toString('base64') !== parts[2] || !Buffer.from(messageText, 'utf8').equals(bytes)) { SendLine(connection.socket, 'SUPPORT_ERROR|INVALID_MESSAGE'); return; }
    const previous = Thread(connection.clientId);
    const duplicate = previous && previous.messages.some(m => m.id === parts[1] && m.role === 'CLIENT');
    if (!duplicate && Now() - (connection.lastSupportSendAt || 0) < 1000) { SendLine(connection.socket, 'SUPPORT_ERROR|RATE_LIMIT'); return; }
    const result = Append(connection.clientId, 'CLIENT', parts[1], messageText);
    if (!result.ok) { SendLine(connection.socket, `SUPPORT_ERROR|${result.reason}`); return; }
    connection.lastSupportSendAt = Now();
    SendLine(connection.socket, `SUPPORT_MESSAGE|${encode(result.message)}`);
    if (!result.duplicate) {
        require('./notificationCenter').AddNotification({ severity: 'INFO', type: 'CUSTOMER_SUPPORT', title: '고객센터 새 문의', message: `CLIENT ${connection.clientId}`, entityType: 'CLIENT', entityId: connection.clientId });
        require('../storage/audit').LogEvent('CUSTOMER_SUPPORT_MESSAGE', connection.clientId);
    }
}
function List() {
    return [...state.supportThreads.values()].map(t => ({ clientId: t.clientId, updatedAt: t.updatedAt,
        unreadAdmin: t.unreadAdmin, online: !!identity.GetOnlineClient(t.clientId),
        lastMessage: t.messages.length ? t.messages[t.messages.length - 1].text.slice(0, 100) : ''
    })).sort((a, b) => b.updatedAt - a.updatedAt);
}
function Read(clientId) {
    const t = Thread(clientId);
    return t ? { clientId, messages: t.messages.slice(-60), online: !!identity.GetOnlineClient(clientId) } : null;
}
function MarkRead(clientId, throughSeq) {
    const t = Thread(clientId);
    if (!t) return { ok: false, reason: 'SUPPORT_NOT_FOUND' };
    t.unreadAdmin = t.messages.filter(m => m.role === 'CLIENT' && m.seq > Number(throughSeq || 0)).length;
    return { ok: Save() };
}
function Reply(clientId, text, requestId) {
    if (!Thread(clientId)) return { ok: false, reason: 'SUPPORT_NOT_FOUND' };
    const result = Append(clientId, 'ADMIN', requestId || crypto.randomUUID(), text);
    if (result.ok) {
        const live = identity.GetOnlineClient(clientId);
        if (Allowed(live)) SendLine(live.socket, `SUPPORT_MESSAGE|${encode(result.message)}`);
        require('../storage/audit').LogEvent('CUSTOMER_SUPPORT_REPLY', clientId);
    }
    return result;
}
function ImportPersisted(data) {
    state.supportThreads.clear();
    for (const [clientId, raw] of Object.entries(data.supportThreads || {}).slice(0, 5000)) {
        if (!/^[0-9A-F]{16}$/.test(clientId) || !raw || !Array.isArray(raw.messages)) continue;
        const messages = raw.messages.filter(m => m && validId(m.id) && ValidateText(m.text) && ['CLIENT', 'ADMIN'].includes(m.role) && Number.isSafeInteger(m.seq) && m.seq > 0).slice(-200);
        state.supportThreads.set(clientId, { clientId, messages, nextSeq: Math.max(0, ...messages.map(m => m.seq)) + 1,
            updatedAt: Math.max(0, Number(raw.updatedAt) || 0), unreadAdmin: Math.min(200, Math.max(0, Number(raw.unreadAdmin) || 0)) });
    }
}
module.exports = { Handle, List, Read, Reply, MarkRead, ImportPersisted };
