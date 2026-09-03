'use strict';

const state = require('../core/state');

function ObjectFromMap(map) { return Object.fromEntries(map instanceof Map ? map : []); }
function MapFromObject(value, max = 5000) {
    const out = new Map();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [key, item] of Object.entries(value).slice(0, max)) {
        if (key && item && typeof item === 'object') out.set(String(key).slice(0, 256), { ...item });
    }
    return out;
}
function List(value, max) { return Array.isArray(value) ? value.filter(x => x && typeof x === 'object').slice(-max).map(x => ({ ...x })) : []; }
function Clamp(value, min, max, fallback) { const n=Number(value); return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback; }
function Clone(value) { return JSON.parse(JSON.stringify(value)); }

function ExportPersisted() {
    const p = state.production;
    return Clone({
        passkeyCredentials: ObjectFromMap(p.passkeyCredentials),
        privilegedApprovals: ObjectFromMap(p.privilegedApprovals),
        deploymentManifest: p.deploymentManifest,
        transportPolicy: p.transportPolicy,
        updatePolicy: p.updatePolicy,
        updateTransactions: ObjectFromMap(p.updateTransactions),
        auditChain: p.auditChain,
        incidents: p.incidents,
        sloPolicy: p.sloPolicy,
        recoveryDrills: p.recoveryDrills,
        anomalyFindings: ObjectFromMap(p.anomalyFindings),
        retentionPolicy: p.retentionPolicy,
        supplyChain: p.supplyChain,
        chaosRuns: p.chaosRuns,
        diagnosticsBundles: p.diagnosticsBundles
    });
}

function ImportPersisted(data) {
    const raw = data && data.productionControl;
    const p = state.production;
    // A restore must never merge the previous in-memory database into the
    // restored database.  Start from deterministic defaults, including when
    // an older database has no productionControl section yet.
    p.pairingClaims.clear();
    p.passkeyCredentials = new Map();
    p.privilegedApprovals = new Map();
    p.updateTransactions = new Map();
    p.anomalyFindings = new Map();
    p.deploymentManifest = { revision: 1, updatedAt: 0, updatedBy: 'DEFAULT' };
    p.transportPolicy = { mode: 'HMAC', requireTls: false, pinSha256: '', rotationGraceUntil: 0, updatedAt: 0, updatedBy: 'DEFAULT' };
    p.updatePolicy = { autoRollback: true, startupAckSeconds: 60, failureThresholdPercent: 20, minimumSamples: 3, updatedAt: 0, updatedBy: 'DEFAULT' };
    p.auditChain = { anchor: '', head: '', count: 0, verifiedAt: 0, lastError: '' };
    p.incidents = [];
    p.sloPolicy = { availabilityTarget: 99.9, ackSuccessTarget: 99.9, p95TargetMs: 1000, windowMinutes: 60, updatedAt: 0, updatedBy: 'DEFAULT' };
    p.recoveryDrills = [];
    p.retentionPolicy = { auditDays: 90, incidentDays: 180, diagnosticsDays: 30, updateDays: 90, chaosDays: 30, updatedAt: 0, updatedBy: 'DEFAULT' };
    p.supplyChain = { generatedAt: 0, sourceHash: '', manifestHash: '', files: [], violations: [] };
    p.chaosRuns = [];
    p.diagnosticsBundles = [];
    if (!raw || typeof raw !== 'object') return;
    p.passkeyCredentials = MapFromObject(raw.passkeyCredentials, 100);
    p.privilegedApprovals = MapFromObject(raw.privilegedApprovals, 2000);
    p.updateTransactions = MapFromObject(raw.updateTransactions, 5000);
    p.anomalyFindings = MapFromObject(raw.anomalyFindings, 2000);
    p.deploymentManifest = raw.deploymentManifest && typeof raw.deploymentManifest === 'object' ? { ...p.deploymentManifest, ...raw.deploymentManifest } : p.deploymentManifest;
    p.transportPolicy = raw.transportPolicy && typeof raw.transportPolicy === 'object' ? { ...p.transportPolicy, ...raw.transportPolicy } : p.transportPolicy;
    p.updatePolicy = raw.updatePolicy && typeof raw.updatePolicy === 'object' ? { ...p.updatePolicy, ...raw.updatePolicy } : p.updatePolicy;
    p.auditChain = raw.auditChain && typeof raw.auditChain === 'object' ? { ...p.auditChain, ...raw.auditChain } : p.auditChain;
    p.incidents = List(raw.incidents, 5000);
    p.recoveryDrills = List(raw.recoveryDrills, 500);
    p.chaosRuns = List(raw.chaosRuns, 500);
    p.diagnosticsBundles = List(raw.diagnosticsBundles, 500);
    p.sloPolicy = raw.sloPolicy && typeof raw.sloPolicy === 'object' ? {
        ...p.sloPolicy,
        availabilityTarget: Clamp(raw.sloPolicy.availabilityTarget, 90, 100, 99.9),
        ackSuccessTarget: Clamp(raw.sloPolicy.ackSuccessTarget, 90, 100, 99.9),
        p95TargetMs: Clamp(raw.sloPolicy.p95TargetMs, 10, 60000, 1000),
        windowMinutes: Clamp(raw.sloPolicy.windowMinutes, 5, 10080, 60)
    } : p.sloPolicy;
    p.retentionPolicy = raw.retentionPolicy && typeof raw.retentionPolicy === 'object' ? {
        ...p.retentionPolicy,
        auditDays: Clamp(raw.retentionPolicy.auditDays, 1, 3650, 90),
        incidentDays: Clamp(raw.retentionPolicy.incidentDays, 1, 3650, 180),
        diagnosticsDays: Clamp(raw.retentionPolicy.diagnosticsDays, 1, 3650, 30),
        updateDays: Clamp(raw.retentionPolicy.updateDays, 1, 3650, 90),
        chaosDays: Clamp(raw.retentionPolicy.chaosDays, 1, 3650, 30)
    } : p.retentionPolicy;
    p.supplyChain = raw.supplyChain && typeof raw.supplyChain === 'object' ? { ...p.supplyChain, ...raw.supplyChain, files: List(raw.supplyChain.files, 10000), violations: Array.isArray(raw.supplyChain.violations) ? raw.supplyChain.violations.slice(0, 1000) : [] } : p.supplyChain;
}

module.exports = { ExportPersisted, ImportPersisted };
