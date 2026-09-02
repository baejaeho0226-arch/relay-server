'use strict';

const crypto = require('crypto');
const state = require('../core/state');

const GROUPS = Object.freeze(['TYPE1', 'TYPE2', 'TYPE3']);
const GUID_PATTERN = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/;

function NormalizeAccessType(value) {
    const normalized = String(value || '').trim().toUpperCase();
    return GROUPS.includes(normalized) ? normalized : 'TYPE1';
}

function NewGuid() {
    return `{${crypto.randomUUID().toUpperCase()}}`;
}

function EnsureGroupGuids() {
    let changed = false;
    for (const group of GROUPS) {
        const current = String(state.accessGroupGuids.get(group) || '').toUpperCase();
        if (GUID_PATTERN.test(current)) {
            if (state.accessGroupGuids.get(group) !== current) state.accessGroupGuids.set(group, current);
            continue;
        }
        state.accessGroupGuids.set(group, NewGuid());
        changed = true;
    }
    return changed;
}

function GroupGuid(accessType) {
    EnsureGroupGuids();
    return state.accessGroupGuids.get(NormalizeAccessType(accessType));
}

function ImportPersisted(data) {
    state.accessGroupGuids.clear();
    const source = data && data.accessGroupGuids;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    for (const group of GROUPS) {
        const value = String(source[group] || '').toUpperCase();
        if (GUID_PATTERN.test(value)) state.accessGroupGuids.set(group, value);
    }
}

function PublicGroups() {
    EnsureGroupGuids();
    return GROUPS.map(group => ({ group, guid: state.accessGroupGuids.get(group) }));
}

module.exports = {
    GROUPS,
    EnsureGroupGuids,
    GroupGuid,
    ImportPersisted,
    PublicGroups
};
