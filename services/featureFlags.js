'use strict';

const state = require('../core/state');
const { NormalizeID } = require('../core/utils');

const DEFAULTS = Object.freeze({
    REMOTE_COMMANDS: true,
    REMOTE_DIAGNOSTICS: true,
    ADVANCED_NOTICE: true,
    PROCESS_RESULT: true,
    UI_STATE: true,
    QR_DEVICE_APPROVAL: true,
    PROTOCOL_V3_PREVIEW: false,
    DEVICE_HMAC_ENFORCE: false,
    EVENT_SEQUENCE: false
});

function NormalizeFlagName(name) {
    return String(name || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 48);
}

function GlobalFlags() {
    return { ...DEFAULTS, ...(state.desiredRuntimeConfig.featureFlags || {}) };
}

function OverrideMap(type) {
    return String(type || '').toUpperCase() === 'SERVER' ? state.serverFeatureOverrides : state.clientFeatureOverrides;
}

function EffectiveFlags(type, id) {
    const out = GlobalFlags();
    const override = OverrideMap(type).get(NormalizeID(id)) || {};
    for (const [key, value] of Object.entries(override)) {
        const name = NormalizeFlagName(key);
        if (name && Object.prototype.hasOwnProperty.call(DEFAULTS, name) && typeof value === 'boolean') out[name] = value;
    }
    return out;
}

function FeatureEnabled(type, id, name, defaultValue = true) {
    const n = NormalizeFlagName(name);
    const flags = EffectiveFlags(type, id);
    return Object.prototype.hasOwnProperty.call(flags, n) ? !!flags[n] : !!defaultValue;
}

function SetGlobalFlags(values) {
    const next = { ...(state.desiredRuntimeConfig.featureFlags || {}) };
    for (const [raw, value] of Object.entries(values || {})) {
        const name = NormalizeFlagName(raw);
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, name) && typeof value === 'boolean') next[name] = value;
    }
    state.desiredRuntimeConfig.featureFlags = next;
    return GlobalFlags();
}

function SetDeviceOverrides(type, id, values) {
    id = NormalizeID(id);
    if (!id) return null;
    const map = OverrideMap(type);
    const next = {};
    for (const [raw, value] of Object.entries(values || {})) {
        const name = NormalizeFlagName(raw);
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, name)) continue;
        if (value === true || value === false) next[name] = value;
    }
    if (Object.keys(next).length) map.set(id, next); else map.delete(id);
    return next;
}

function EncodeFlags(type, id) {
    return Object.entries(EffectiveFlags(type, id)).map(([k,v]) => `${k}=${v ? 1 : 0}`).join(',');
}

module.exports = { DEFAULTS, GlobalFlags, EffectiveFlags, FeatureEnabled, SetGlobalFlags, SetDeviceOverrides, EncodeFlags };
