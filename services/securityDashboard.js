'use strict';

const state = require('../core/state');
const { Now } = require('../core/utils');
const deviceAuth = require('./deviceAuth');
const enrollment = require('./deviceEnrollment');
const rotation = require('./deviceSecretRotation');
const networkSecurity = require('./networkSecurity');

const SECRET_STALE_MS = 90 * 24 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 24 * 60 * 60 * 1000;

function Clamp(value, max) {
    return Math.min(max, Math.max(0, Number(value) || 0));
}

function RecentEventCount(types, windowMs) {
    const wanted = new Set(types.map(x => String(x).toUpperCase()));
    const since = Now() - windowMs;
    return state.events.filter(e => Number(e.time || 0) >= since && wanted.has(String(e.type || '').toUpperCase())).length;
}

function SecretAge(type, id, hasSecret) {
    if (!hasSecret) return { ageMs: 0, ageDays: null, stale: false, unknown: false };
    const meta = state.deviceSecretMeta.get(`${type}:${id}`) || null;
    const createdAt = Number(meta && (meta.rotatedAt || meta.createdAt) || 0);
    if (!createdAt) return { ageMs: 0, ageDays: null, stale: false, unknown: true };
    const ageMs = Math.max(0, Now() - createdAt);
    return { ageMs, ageDays: Math.floor(ageMs / 86400000), stale: ageMs >= SECRET_STALE_MS, unknown: false };
}

function Build() {
    const authDevices = deviceAuth.Overview();
    const enrollmentOverview = enrollment.Overview();
    const rotations = rotation.Overview();
    const rotationMap = new Map(rotations.map(x => [`${x.type}:${x.id}`, x]));

    let staleSecrets = 0;
    let unknownSecretAge = 0;

    const devices = authDevices.map(d => {
        const age = SecretAge(d.type, d.id, d.hasSecret);
        if (age.stale) staleSecrets++;
        if (age.unknown) unknownSecretAge++;
        const rot = rotationMap.get(`${d.type}:${d.id}`) || null;
        return {
            type: d.type,
            id: d.id,
            deviceKey: d.deviceKey,
            online: d.online,
            capable: d.capable,
            enforced: d.enforced,
            hasSecret: d.hasSecret,
            verified: d.verified,
            authStatus: d.status && d.status.status ? d.status.status : '',
            verifiedAt: Number(d.status && d.status.verifiedAt || 0),
            failedAt: Number(d.status && d.status.failedAt || 0),
            secretAgeDays: age.ageDays,
            secretAgeUnknown: age.unknown,
            secretStale: age.stale,
            rotationStatus: rot ? String(rot.status || '') : '',
            rotationId: rot ? String(rot.rotationId || '') : ''
        };
    }).sort((a, b) => Number(b.online) - Number(a.online) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));

    const total = devices.length;
    const online = devices.filter(x => x.online).length;
    const hmacCapable = devices.filter(x => x.capable).length;
    const onlineHmacCapable = devices.filter(x => x.online && x.capable).length;
    const secrets = devices.filter(x => x.hasSecret).length;
    const verified = devices.filter(x => x.online && x.verified).length;
    const enforced = devices.filter(x => x.enforced).length;
    const legacy = devices.filter(x => !x.capable).length;
    const unverifiedOnline = devices.filter(x => x.online && x.capable && !x.verified).length;
    const activeRotations = rotations.filter(x => !['COMPLETED', 'EXPIRED', 'FAILED'].includes(String(x.status || '').toUpperCase())).length;
    const authFailures24h = RecentEventCount(['DEVICE_AUTH_FAILED', 'DEVICE_AUTH_INVALID_CHALLENGE'], AUTH_WINDOW_MS);
    const network = networkSecurity.Summary();

    let risk = 0;
    risk += Clamp(enrollmentOverview.pending * 8, 24);
    risk += Clamp(authFailures24h * 5, 25);
    risk += Clamp(unverifiedOnline * 10, 30);
    risk += Clamp(staleSecrets * 5, 20);
    risk += Clamp(legacy * 3, 15);
    risk += Clamp(activeRotations * 2, 10);
    risk += Clamp(network.critical * 15, 30);
    risk += Clamp(network.warning * 6, 18);
    risk += Clamp(network.info * 2, 8);
    risk = Math.min(100, risk);

    const score = Math.max(0, 100 - risk);
    const label = score >= 95 ? 'EXCELLENT' : score >= 85 ? 'GOOD' : score >= 70 ? 'FAIR' : score >= 50 ? 'POOR' : 'CRITICAL';

    const alerts = [];
    if (authFailures24h) alerts.push({ severity: 'CRITICAL', code: 'AUTH_FAILURE_24H', count: authFailures24h, message: '최근 24시간 Device HMAC 인증 실패가 있습니다.' });
    if (unverifiedOnline) alerts.push({ severity: 'WARNING', code: 'ONLINE_UNVERIFIED', count: unverifiedOnline, message: '온라인 상태지만 HMAC 검증이 완료되지 않은 기기가 있습니다.' });
    if (enrollmentOverview.pending) alerts.push({ severity: 'WARNING', code: 'ENROLLMENT_PENDING', count: enrollmentOverview.pending, message: '관리자 승인을 기다리는 신규 기기가 있습니다.' });
    if (staleSecrets) alerts.push({ severity: 'WARNING', code: 'SECRET_AGE_90D', count: staleSecrets, message: '90일 이상 된 Device Secret이 있습니다.' });
    if (legacy) alerts.push({ severity: 'INFO', code: 'LEGACY_DEVICE', count: legacy, message: 'DEVICE_HMAC capability가 없는 Legacy 기기가 있습니다.' });
    if (activeRotations) alerts.push({ severity: 'INFO', code: 'SECRET_ROTATION_ACTIVE', count: activeRotations, message: '진행 중인 Device Secret Rotation이 있습니다.' });
    if (network.critical) alerts.push({ severity: 'CRITICAL', code: 'DEVICE_COUNTRY_CHANGED', count: network.critical, message: '신뢰 기준과 다른 국가에서 접속한 Device가 있습니다.' });
    if (network.warning) alerts.push({ severity: 'WARNING', code: 'DEVICE_SUBNET_CHANGED', count: network.warning, message: '신뢰 기준과 다른 Subnet에서 접속한 Device가 있습니다.' });
    if (network.info) alerts.push({ severity: 'INFO', code: 'DEVICE_IP_CHANGED', count: network.info, message: '신뢰 기준과 다른 IP에서 접속한 Device가 있습니다.' });

    return {
        score,
        label,
        total,
        online,
        hmacCapable,
        onlineHmacCapable,
        secrets,
        verified,
        enforced,
        legacy,
        unverifiedOnline,
        staleSecrets,
        unknownSecretAge,
        activeRotations,
        authFailures24h,
        enrollment: enrollmentOverview,
        network,
        alerts,
        devices
    };
}

module.exports = { Build, SECRET_STALE_MS, AUTH_WINDOW_MS };
