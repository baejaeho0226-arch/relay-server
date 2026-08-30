'use strict';

const { AuditSearch, LogEvent } = require('../storage/audit');
const { SafeField, Now } = require('../core/utils');

const TYPE = 'WEB_ADMIN_ACTIVITY';

function Clean(value, max = 180) {
    return SafeField(value || '').slice(0, max);
}

function RecordAdminActivity(role, ip, method, path, status, action) {
    const item = {
        time: Now(),
        role: Clean(role, 24),
        ip: Clean(ip, 96),
        method: Clean(method, 12).toUpperCase(),
        path: Clean(path, 220),
        status: Number(status) || 0,
        action: Clean(action || '', 80)
    };
    LogEvent(TYPE, JSON.stringify(item));
    return item;
}

function ParseActivity(event) {
    try {
        const item = JSON.parse(String(event.detail || ''));
        return {
            time: Number(item.time) || Number(event.time) || 0,
            role: Clean(item.role, 24),
            ip: Clean(item.ip, 96),
            method: Clean(item.method, 12).toUpperCase(),
            path: Clean(item.path, 220),
            status: Number(item.status) || 0,
            action: Clean(item.action, 80)
        };
    } catch (_) {
        return null;
    }
}

function ListAdminActivity(query = '', limit = 300) {
    const q = String(query || '').trim().toUpperCase();
    limit = Math.max(1, Math.min(1000, Number(limit) || 300));
    const rows = [];
    for (const event of AuditSearch('', TYPE, 0)) {
        const item = ParseActivity(event);
        if (!item) continue;
        if (q && !`${item.role}|${item.ip}|${item.method}|${item.path}|${item.status}|${item.action}`.toUpperCase().includes(q)) continue;
        rows.push(item);
    }
    return rows.slice(-limit).reverse();
}

module.exports = {
    TYPE,
    RecordAdminActivity,
    ListAdminActivity
};
