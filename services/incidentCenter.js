'use strict';

const crypto = require('crypto');
const state = require('../core/state');
const { Now, SafeField } = require('../core/utils');

const SEVERITY = new Map([
    ['DATABASE_AUTO_RECOVER', 'CRITICAL'], ['DATABASE_LOAD_FAILED', 'CRITICAL'],
    ['UPDATE_AUTO_ROLLBACK', 'CRITICAL'], ['AUDIT_CHAIN_INVALID', 'CRITICAL'],
    ['DEVICE_AUTH_FAILED', 'HIGH'], ['WEB_ADMIN_AUTH_FAILED', 'HIGH'],
    ['ACK_TIMEOUT', 'HIGH'], ['SERVER_FLAPPING', 'HIGH'], ['CLIENT_FLAPPING', 'MEDIUM'],
    ['IP_CHANGED', 'MEDIUM'], ['RELEASE_PUBLISHED', 'INFO']
]);

function EntityFrom(event) {
    const match = String(event.detail || '').match(/\b[0-9A-F]{16}\b/i);
    return match ? match[0].toUpperCase() : 'SYSTEM';
}

function CaptureEvent(event) {
    const severity = SEVERITY.get(String(event && event.type || '').toUpperCase());
    if (!severity) return null;
    const entity = EntityFrom(event);
    const key = `${event.type}|${entity}`;
    const now = Number(event.time) || Now();
    let incident = state.production.incidents.find(x => x.status === 'OPEN' && x.correlationKey === key && now - Number(x.lastAt) < 15 * 60000);
    if (!incident) {
        incident = {
            id: `INC-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
            correlationKey: key, entity, severity, title: SafeField(event.type),
            status: 'OPEN', firstAt: now, lastAt: now, count: 0, eventTypes: [], timeline: [], resolvedAt: 0, resolvedBy: ''
        };
        state.production.incidents.push(incident);
    }
    incident.lastAt = now;
    incident.count++;
    if (!incident.eventTypes.includes(event.type)) incident.eventTypes.push(event.type);
    incident.timeline.push({ time: now, type: SafeField(event.type), detail: SafeField(event.detail) });
    incident.timeline = incident.timeline.slice(-100);
    state.production.incidents = state.production.incidents.slice(-5000);
    return incident;
}

function List() { return state.production.incidents.slice().sort((a, b) => Number(b.lastAt) - Number(a.lastAt)); }
function Resolve(id, actor) {
    const item = state.production.incidents.find(x => x.id === String(id || '').toUpperCase());
    if (!item) return { ok: false, reason: 'INCIDENT_NOT_FOUND' };
    item.status = 'RESOLVED'; item.resolvedAt = Now(); item.resolvedBy = SafeField(actor).slice(0, 64);
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent('INCIDENT_RESOLVED', `${item.id} / ${item.resolvedBy}`);
    return { ok: true, incident: item };
}

module.exports = { CaptureEvent, List, Resolve };
