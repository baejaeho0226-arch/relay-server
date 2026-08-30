'use strict';

const config = require('../config/config');
const state = require('../core/state');
const { Now, SafeField } = require('../core/utils');

const MAX_NOTIFICATIONS = config.MAX_NOTIFICATIONS || 500;
const DEDUPE_MS = config.NOTIFICATION_DEDUPE_MS || 60000;

function NormalizeSeverity(value) {
    const s = String(value || 'INFO').toUpperCase();
    return ['INFO', 'WARNING', 'CRITICAL'].includes(s) ? s : 'INFO';
}

function AddNotification(options = {}) {
    const now = Now();
    const severity = NormalizeSeverity(options.severity);
    const type = SafeField(options.type || 'SYSTEM');
    const title = SafeField(options.title || type);
    const message = SafeField(options.message || '');
    const entityType = SafeField(options.entityType || '');
    const entityId = SafeField(options.entityId || '');
    const dedupeKey = SafeField(options.dedupeKey || `${type}|${entityType}|${entityId}|${message}`);

    const recent = state.notifications.findLast
        ? state.notifications.findLast(x => x.dedupeKey === dedupeKey && now - x.createdAt < DEDUPE_MS)
        : [...state.notifications].reverse().find(x => x.dedupeKey === dedupeKey && now - x.createdAt < DEDUPE_MS);
    if (recent) {
        recent.count = Number(recent.count || 1) + 1;
        recent.updatedAt = now;
        recent.message = message || recent.message;
        try { require('../web/webEvents').BroadcastNotification(recent); } catch (_) {}
        return recent;
    }

    const item = {
        id: String(state.nextNotificationId++),
        severity,
        type,
        title,
        message,
        entityType,
        entityId,
        createdAt: now,
        updatedAt: now,
        read: false,
        count: 1,
        dedupeKey
    };
    state.notifications.push(item);
    while (state.notifications.length > MAX_NOTIFICATIONS) state.notifications.shift();
    try { require('../web/webEvents').BroadcastNotification(item); } catch (_) {}
    try { require('./pushManager').DispatchNotification(item); } catch (_) {}
    return item;
}

function CaptureEvent(event) {
    if (!event || !event.type) return;
    const type = String(event.type).toUpperCase();
    const detail = String(event.detail || '');
    const firstId = (detail.match(/\b[A-F0-9]{16}\b/i) || [])[0] || '';

    if (type === 'SERVER_OFFLINE') {
        AddNotification({ severity: 'WARNING', type, title: 'Server offline', message: detail, entityType: 'SERVER', entityId: firstId, dedupeKey: `${type}|${firstId}` });
    } else if (type === 'ACK_TIMEOUT') {
        AddNotification({ severity: 'CRITICAL', type, title: 'ACK timeout', message: detail, entityType: 'REQUEST', entityId: '', dedupeKey: `${type}|${detail}` });
    } else if (type === 'ACK_ERROR') {
        AddNotification({ severity: 'WARNING', type, title: 'ACK error', message: detail, entityType: 'REQUEST', entityId: '', dedupeKey: `${type}|${detail}` });
    } else if (type === 'DATABASE_RECOVER' || type === 'DATABASE_RECOVERY' || type === 'DATABASE_AUTO_RECOVER') {
        AddNotification({ severity: 'CRITICAL', type, title: 'Database recovery', message: detail, dedupeKey: `${type}|${detail}` });
    } else if (type === 'SERVICE_STOP') {
        AddNotification({ severity: 'CRITICAL', type, title: 'Relay service stopped', message: detail || 'Service stopped by administrator.', dedupeKey: type });
    } else if (type === 'MAINTENANCE_ON') {
        AddNotification({ severity: 'WARNING', type, title: 'Maintenance enabled', message: detail || 'Maintenance mode is active.', dedupeKey: type });
    } else if (type === 'SERVER_DRAIN_READY') {
        AddNotification({ severity: 'INFO', type, title: 'Server drain complete', message: detail || 'Server has no active clients and is ready for maintenance.', entityType: 'SERVER', entityId: firstId, dedupeKey: `${type}|${firstId}` });
    }
}

function ListNotifications(options = {}) {
    const unreadOnly = !!options.unreadOnly;
    const severity = String(options.severity || 'ALL').toUpperCase();
    const limit = Math.max(1, Math.min(500, Number(options.limit || 200)));
    return state.notifications
        .filter(x => !unreadOnly || !x.read)
        .filter(x => severity === 'ALL' || x.severity === severity)
        .slice(-limit)
        .reverse()
        .map(x => ({ ...x }));
}

function NotificationSummary() {
    const unread = state.notifications.filter(x => !x.read);
    return {
        total: state.notifications.length,
        unread: unread.length,
        critical: unread.filter(x => x.severity === 'CRITICAL').length,
        warning: unread.filter(x => x.severity === 'WARNING').length,
        info: unread.filter(x => x.severity === 'INFO').length
    };
}

function MarkRead(id, read = true) {
    const item = state.notifications.find(x => x.id === String(id));
    if (!item) return false;
    item.read = !!read;
    item.updatedAt = Now();
    return true;
}

function MarkAllRead() {
    const now = Now();
    for (const item of state.notifications) {
        item.read = true;
        item.updatedAt = now;
    }
}

function ClearNotifications() {
    state.notifications.length = 0;
}

module.exports = {
    AddNotification,
    CaptureEvent,
    ListNotifications,
    NotificationSummary,
    MarkRead,
    MarkAllRead,
    ClearNotifications
};
