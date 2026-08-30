'use strict';

const net = require('net');
const state = require('../core/state');
const { NormalizeID, Now, SafeField } = require('../core/utils');

const MAX_CHANGES = 30;
const COUNTRY_UNKNOWN = new Set(['', 'UNKNOWN', 'LOCAL']);

function Type(value) {
    const type = String(value || '').toUpperCase();
    return type === 'SERVER' || type === 'CLIENT' ? type : '';
}

function Key(type, id) {
    return `${Type(type)}:${NormalizeID(id)}`;
}

function NormalizeIP(value) {
    let ip = String(value || '').trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    const zone = ip.indexOf('%');
    if (zone >= 0) ip = ip.slice(0, zone);
    return ip;
}

function IsPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
    return parts[0] === 10 ||
        parts[0] === 127 ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 169 && parts[1] === 254);
}

function IsLocalIP(ip) {
    if (net.isIP(ip) === 4) return IsPrivateIPv4(ip);
    if (net.isIP(ip) !== 6) return false;
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

function Subnet(ip) {
    ip = NormalizeIP(ip);
    if (net.isIP(ip) === 4) {
        const p = ip.split('.');
        return `${p[0]}.${p[1]}.${p[2]}.0/24`;
    }
    if (net.isIP(ip) === 6) {
        const expanded = ip.split(':').slice(0, 4).join(':');
        return `${expanded}::/64`;
    }
    return '';
}

function GeoLookup(ip) {
    ip = NormalizeIP(ip);
    if (!ip || !net.isIP(ip)) return { available: false, country: 'UNKNOWN', region: '', city: '', timezone: '', source: 'INVALID' };
    if (IsLocalIP(ip)) return { available: true, country: 'LOCAL', region: '', city: '', timezone: '', source: 'LOCAL' };
    try {
        const geoip = require('geoip-lite');
        const value = geoip.lookup(ip);
        if (!value) return { available: true, country: 'UNKNOWN', region: '', city: '', timezone: '', source: 'GEOIP_LITE' };
        return {
            available: true,
            country: SafeField(value.country || 'UNKNOWN').toUpperCase(),
            region: SafeField(value.region || ''),
            city: SafeField(value.city || ''),
            timezone: SafeField(value.timezone || ''),
            source: 'GEOIP_LITE'
        };
    } catch (_) {
        return { available: false, country: 'UNKNOWN', region: '', city: '', timezone: '', source: 'UNAVAILABLE' };
    }
}

function Snapshot(ip) {
    const geo = GeoLookup(ip);
    return {
        ip: NormalizeIP(ip),
        subnet: Subnet(ip),
        country: geo.country,
        region: geo.region,
        city: geo.city,
        timezone: geo.timezone,
        geoAvailable: geo.available,
        geoSource: geo.source
    };
}

function SameCountry(a, b) {
    const ca = String(a || '').toUpperCase();
    const cb = String(b || '').toUpperCase();
    if (COUNTRY_UNKNOWN.has(ca) || COUNTRY_UNKNOWN.has(cb)) return true;
    return ca === cb;
}

function Classify(trusted, current) {
    if (!trusted || !current || !trusted.ip || !current.ip) return { changed: false, severity: '', code: 'TRUSTED' };
    if (!SameCountry(trusted.country, current.country)) return { changed: true, severity: 'CRITICAL', code: 'COUNTRY_CHANGED' };
    if (trusted.subnet && current.subnet && trusted.subnet !== current.subnet) return { changed: true, severity: 'WARNING', code: 'SUBNET_CHANGED' };
    if (trusted.ip !== current.ip) return { changed: true, severity: 'INFO', code: 'IP_CHANGED' };
    return { changed: false, severity: '', code: 'TRUSTED' };
}

function NormalizeStoredProfile(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = Type(raw.type);
    const id = NormalizeID(raw.id);
    if (!type || !id) return null;

    // Backward compatibility with the earlier experimental flat profile format.
    const current = raw.current && typeof raw.current === 'object' ? { ...raw.current } : Snapshot(raw.ip || '');
    const trusted = raw.trusted && typeof raw.trusted === 'object'
        ? { ...raw.trusted }
        : Snapshot(raw.trustedIp || raw.ip || '');

    return {
        type,
        id,
        current,
        trusted,
        firstSeenAt: Math.max(0, Number(raw.firstSeenAt) || Now()),
        lastSeenAt: Math.max(0, Number(raw.lastSeenAt) || 0),
        trustedAt: Math.max(0, Number(raw.trustedAt) || Number(raw.firstSeenAt) || 0),
        lastChangeAt: Math.max(0, Number(raw.lastChangeAt) || 0),
        changeCount: Math.max(0, Number(raw.changeCount) || 0),
        untrustedChangeCount: Math.max(0, Number(raw.untrustedChangeCount) || 0),
        changes: Array.isArray(raw.changes) ? raw.changes.slice(-MAX_CHANGES).map(x => ({ ...x })) : []
    };
}

function Public(profile) {
    if (!profile) return null;
    const classification = Classify(profile.trusted, profile.current);
    return {
        ...profile,
        current: { ...profile.current },
        trusted: { ...profile.trusted },
        changes: profile.changes.map(x => ({ ...x })),
        changed: classification.changed,
        severity: classification.severity,
        changeCode: classification.code,
        status: classification.changed ? 'CHANGED' : 'TRUSTED'
    };
}

function Track(type, id, ip) {
    type = Type(type);
    id = NormalizeID(id);
    ip = NormalizeIP(ip);
    if (!type || !id || !ip || !net.isIP(ip)) return null;

    const key = Key(type, id);
    const now = Now();
    const current = Snapshot(ip);
    let profile = NormalizeStoredProfile(state.deviceNetworkProfiles.get(key));

    if (!profile) {
        profile = {
            type,
            id,
            current,
            trusted: { ...current },
            firstSeenAt: now,
            lastSeenAt: now,
            trustedAt: now,
            lastChangeAt: 0,
            changeCount: 0,
            untrustedChangeCount: 0,
            changes: []
        };
        state.deviceNetworkProfiles.set(key, profile);
        try { require('../storage/database').SaveDatabase(); } catch (_) {}
        return Public(profile);
    }

    const previousObserved = profile.current || {};
    const observationChanged = previousObserved.ip !== current.ip || previousObserved.country !== current.country || previousObserved.subnet !== current.subnet;
    profile.current = current;
    profile.lastSeenAt = now;

    const classification = Classify(profile.trusted, current);
    if (observationChanged && classification.changed) {
        const change = {
            at: now,
            severity: classification.severity,
            code: classification.code,
            fromIp: previousObserved.ip || '',
            toIp: current.ip,
            trustedIp: profile.trusted.ip || '',
            fromSubnet: previousObserved.subnet || '',
            toSubnet: current.subnet || '',
            trustedSubnet: profile.trusted.subnet || '',
            fromCountry: previousObserved.country || '',
            toCountry: current.country || '',
            trustedCountry: profile.trusted.country || '',
            acknowledgedAt: 0
        };
        profile.changes.push(change);
        while (profile.changes.length > MAX_CHANGES) profile.changes.shift();
        profile.changeCount += 1;
        profile.untrustedChangeCount += 1;
        profile.lastChangeAt = now;

        const detail = `${type} ${id} ${profile.trusted.ip || '?'} (${profile.trusted.country || '?'}) -> ${current.ip} (${current.country || '?'}) ${classification.code}`;
        try { require('../storage/audit').LogEvent(`DEVICE_${classification.code}`, detail); } catch (_) {}
        try {
            require('./notificationCenter').AddNotification({
                severity: classification.severity,
                type: 'DEVICE_NETWORK_CHANGE',
                title: classification.code === 'COUNTRY_CHANGED' ? 'Device country changed' : classification.code === 'SUBNET_CHANGED' ? 'Device subnet changed' : 'Device IP changed',
                message: detail,
                entityType: type,
                entityId: id,
                dedupeKey: `DEVICE_NETWORK_CHANGE|${type}|${id}|${profile.trusted.ip}|${current.ip}|${classification.code}`
            });
        } catch (_) {}
    }

    state.deviceNetworkProfiles.set(key, profile);
    if (observationChanged) {
        try { require('../storage/database').SaveDatabase(); } catch (_) {}
    }
    return Public(profile);
}

function Get(type, id) {
    const profile = NormalizeStoredProfile(state.deviceNetworkProfiles.get(Key(type, id)));
    return Public(profile);
}

function Overview() {
    const rows = [];
    for (const raw of state.deviceNetworkProfiles.values()) {
        const profile = NormalizeStoredProfile(raw);
        if (profile) rows.push(Public(profile));
    }
    return rows.sort((a, b) => (b.lastChangeAt || b.lastSeenAt || 0) - (a.lastChangeAt || a.lastSeenAt || 0));
}

function Trust(type, id) {
    const key = Key(type, id);
    const profile = NormalizeStoredProfile(state.deviceNetworkProfiles.get(key));
    if (!profile || !profile.current || !profile.current.ip) return false;
    const now = Now();
    profile.trusted = { ...profile.current };
    profile.trustedAt = now;
    profile.untrustedChangeCount = 0;
    profile.changes = profile.changes.map(x => x.acknowledgedAt ? x : { ...x, acknowledgedAt: now });
    state.deviceNetworkProfiles.set(key, profile);
    try { require('../storage/database').SaveDatabase(); } catch (_) {}
    try { require('../storage/audit').LogEvent('DEVICE_NETWORK_TRUSTED', `${Type(type)} ${NormalizeID(id)} ${profile.current.ip} ${profile.current.country || ''}`); } catch (_) {}
    return true;
}

function Summary() {
    const devices = Overview();
    const changed = devices.filter(x => x.changed);
    return {
        total: devices.length,
        changed: changed.length,
        critical: changed.filter(x => x.severity === 'CRITICAL').length,
        warning: changed.filter(x => x.severity === 'WARNING').length,
        info: changed.filter(x => x.severity === 'INFO').length,
        countryChanged: changed.filter(x => x.changeCode === 'COUNTRY_CHANGED').length,
        subnetChanged: changed.filter(x => x.changeCode === 'SUBNET_CHANGED').length,
        ipChanged: changed.filter(x => x.changeCode === 'IP_CHANGED').length
    };
}

function GeoStatus() {
    let available = false;
    try { require.resolve('geoip-lite'); available = true; } catch (_) {}
    return { available, provider: available ? 'geoip-lite' : 'none', fallback: 'IP_AND_SUBNET_ONLY', externalApi: false };
}

module.exports = {
    Track,
    Get,
    Overview,
    Trust,
    Summary,
    GeoLookup,
    GeoStatus,
    NormalizeIP,
    Subnet,
    Classify,
    NormalizeStoredProfile
};
