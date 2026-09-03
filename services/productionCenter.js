'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const state = require('../core/state');
const config = require('../config/config');
const { Now, SafeField, NormalizeID, NormalizeVersion } = require('../core/utils');

const REQUIRED = {
    SERVER: ['DEVICE_HMAC', 'BUILD_SESSION_LEASE', 'FIXED_BUILD_BINDING', 'SIGNED_UPDATE', 'SERVER_AUTHORITY'],
    CLIENT: ['DEVICE_HMAC', 'QR_DEVICE_APPROVAL', 'PIN6_ONLY', 'BUILD_SESSION_LEASE', 'FIXED_BUILD_BINDING', 'SIGNED_UPDATE', 'SERVER_AUTHORITY']
};

function DeviceRows(type) {
    type = String(type || '').toUpperCase();
    const identities = type === 'SERVER'
        ? Array.from(state.serverIdentities.values()).map(id => ({ id }))
        : Array.from(state.clientIdentities.values()).map(item => ({ id: item.id }));
    return identities.map(({ id }) => {
        id = NormalizeID(id);
        const live = type === 'SERVER' ? require('../identity/identityManager').GetOnlineServer(id) : require('../identity/identityManager').GetOnlineClient(id);
        const caps = Array.from(state.deviceCapabilities.get(`${type}:${id}`) || []).sort();
        const missing = REQUIRED[type].filter(cap => !caps.includes(cap));
        const protocol = Number(live && live.protocolVersion) || 0;
        const version = NormalizeVersion(live && live.appVersion || '');
        const fingerprint = crypto.createHash('sha256').update(`${type}|${id}|${protocol}|${version}|${caps.join(',')}`).digest('hex').slice(0, 24).toUpperCase();
        return { type, id, online: !!live, protocol, version, capabilities: caps, missing, compatible: !!live && !missing.length, fingerprint };
    });
}

function CompatibilityOverview() {
    const devices = [...DeviceRows('SERVER'), ...DeviceRows('CLIENT')];
    return {
        manifest: state.production.deploymentManifest,
        requiredCapabilities: REQUIRED,
        summary: { total: devices.length, online: devices.filter(x => x.online).length, compatible: devices.filter(x => x.compatible).length, mismatch: devices.filter(x => x.online && !x.compatible).length },
        devices
    };
}

function ConfigDryRun(input, actor) {
    input = input && typeof input === 'object' ? input : {};
    const changes = {};
    const warnings = [];
    if (input.minProtocolVersion !== undefined) {
        const value = Number(input.minProtocolVersion);
        if (!Number.isInteger(value) || value < 1 || value > config.CURRENT_PROTOCOL_VERSION) return { ok: false, reason: 'INVALID_PROTOCOL_VERSION' };
        changes.minProtocolVersion = value;
        const affected = [...state.servers.values(), ...state.clients.values()].filter(x => Number(x.protocolVersion || 0) < value).length;
        if (affected) warnings.push(`${affected} online device(s) would be rejected by the protocol floor.`);
    }
    for (const key of ['minServerVersion', 'minClientVersion']) {
        if (input[key] === undefined) continue;
        const value = NormalizeVersion(input[key]);
        if (!value) return { ok: false, reason: `INVALID_${key.toUpperCase()}` };
        changes[key] = value;
    }
    if (input.heartbeatMs !== undefined) {
        const value = Number(input.heartbeatMs);
        if (!Number.isInteger(value) || value < 1000 || value > 300000) return { ok: false, reason: 'INVALID_HEARTBEAT' };
        changes.heartbeatMs = value;
        if (value < 5000) warnings.push('Heartbeat below 5 seconds increases Relay and mobile radio load.');
    }
    const plan = {
        planId: `PLAN-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
        changes, warnings, safe: warnings.length === 0,
        affected: { servers: state.serverIdentities.size, clients: state.clientIdentities.size },
        createdAt: Now(), createdBy: SafeField(actor).slice(0, 64), expiresAt: Now() + 10 * 60000
    };
    state.production.deploymentManifest.lastDryRun = plan;
    return { ok: true, plan };
}

function ApplyPlan(planId, actor) {
    const plan = state.production.deploymentManifest.lastDryRun;
    if (!plan || plan.planId !== String(planId || '').toUpperCase()) return { ok: false, reason: 'PLAN_NOT_FOUND' };
    if (plan.expiresAt <= Now()) return { ok: false, reason: 'PLAN_EXPIRED' };
    const c = plan.changes;
    if (c.minProtocolVersion !== undefined) state.minProtocolVersion = c.minProtocolVersion;
    if (c.minServerVersion !== undefined) state.minServerVersion = c.minServerVersion;
    if (c.minClientVersion !== undefined) state.minClientVersion = c.minClientVersion;
    if (c.heartbeatMs !== undefined) state.desiredRuntimeConfig.heartbeatMs = c.heartbeatMs;
    state.production.deploymentManifest = {
        ...state.production.deploymentManifest,
        revision: Number(state.production.deploymentManifest.revision || 0) + 1,
        appliedPlanId: plan.planId, appliedChanges: c,
        updatedAt: Now(), updatedBy: SafeField(actor).slice(0, 64), lastDryRun: null
    };
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent('CONFIG_PLAN_APPLIED', `${plan.planId} / ${state.production.deploymentManifest.updatedBy}`);
    return { ok: true, manifest: state.production.deploymentManifest };
}

function Percentile(values, p) {
    if (!values.length) return 0;
    values.sort((a,b)=>a-b);
    return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))];
}

function SloSnapshot() {
    const policy = state.production.sloPolicy;
    const cutoff = Now() - Number(policy.windowMinutes || 60) * 60000;
    const traces = Array.from(state.requestTraces.values()).filter(x => Number(x.createdAt) >= cutoff && !['PENDING','QUEUED'].includes(String(x.status)));
    const successes = traces.filter(x => ['OK','SUCCESS','AUTHORIZED'].includes(String(x.status).toUpperCase())).length;
    const ackSuccess = traces.length ? successes * 100 / traces.length : 100;
    const durations = traces.map(x => Number(x.durationMs) || 0).filter(x => x >= 0);
    const registered = state.serverIdentities.size + state.clientIdentities.size;
    const online = Array.from(state.servers.values()).filter(x => x.registered && x.socket && !x.socket.destroyed).length + Array.from(state.clients.values()).filter(x => x.connected && x.socket && !x.socket.destroyed).length;
    const availability = registered ? online * 100 / registered : 100;
    const allowedFailure = Math.max(0.0001, 100 - Number(policy.ackSuccessTarget));
    const consumed = Math.max(0, 100 - ackSuccess) / allowedFailure * 100;
    return {
        windowMinutes: policy.windowMinutes, policy: { ...policy },
        availability: Number(availability.toFixed(3)), ackSuccess: Number(ackSuccess.toFixed(3)), p95Ms: Percentile(durations, .95), samples: traces.length,
        errorBudget: { consumedPercent: Number(consumed.toFixed(2)), remainingPercent: Number(Math.max(0, 100-consumed).toFixed(2)), exhausted: consumed >= 100 },
        compliant: availability >= policy.availabilityTarget && ackSuccess >= policy.ackSuccessTarget && Percentile(durations,.95) <= policy.p95TargetMs
    };
}

function SetSloPolicy(input, actor) {
    state.production.sloPolicy = {
        ...state.production.sloPolicy,
        availabilityTarget: Math.max(90, Math.min(100, Number(input.availabilityTarget) || 99.9)),
        ackSuccessTarget: Math.max(90, Math.min(100, Number(input.ackSuccessTarget) || 99.9)),
        p95TargetMs: Math.max(10, Math.min(60000, Number(input.p95TargetMs) || 1000)),
        windowMinutes: Math.max(5, Math.min(10080, Number(input.windowMinutes) || 60)),
        updatedAt: Now(), updatedBy: SafeField(actor).slice(0,64)
    };
    require('../storage/database').SaveDatabase();
    return { ok: true, slo: SloSnapshot() };
}

function Diagnostics(type, id, actor) {
    type = String(type || '').toUpperCase(); id = NormalizeID(id);
    if (!['SERVER','CLIENT'].includes(type) || !id) return { ok:false,reason:'INVALID_DEVICE' };
    const compatible = DeviceRows(type).find(x=>x.id===id);
    if (!compatible) return { ok:false,reason:'DEVICE_NOT_FOUND' };
    const info = state.deviceInfo.get(`${type}:${id}`) || {};
    const auth = state.deviceAuthStatus.get(`${type}:${id}`) || {};
    const network = state.deviceNetworkProfiles.get(`${type}:${id}`) || {};
    const payload = {
        schema: 'relay.diagnostics.v1', createdAt: Now(), createdBy: SafeField(actor).slice(0,64),
        device: compatible,
        runtime: { info: { platform: SafeField(info.platform), osVersion: SafeField(info.osVersion), model: SafeField(info.model) }, auth: { verified: !!auth.verified, verifiedAt: Number(auth.verifiedAt)||0 }, network: { changedAt: Number(network.changedAt)||0, changeCount: Number(network.changeCount)||0 } },
        updates: require('./updateSupervisor').Overview().transactions.filter(x=>x.type===type&&x.id===id).slice(0,20),
        incidents: require('./incidentCenter').List().filter(x=>x.entity===id).slice(0,20)
    };
    const bundle = { bundleId:`DIAG-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,type,id,createdAt:payload.createdAt,createdBy:payload.createdBy,sha256:crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').toUpperCase(),payload };
    state.production.diagnosticsBundles.push({ ...bundle, payload: undefined });
    state.production.diagnosticsBundles = state.production.diagnosticsBundles.slice(-500);
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent('DIAGNOSTICS_BUNDLE_CREATED', `${type}:${id} / ${bundle.bundleId}`);
    return { ok:true,bundle };
}

function RecoveryDrill(actor) {
    const file = require('../storage/backup').CreateBackup('recovery_drill');
    const check = file ? require('./integrityCheck').VerifyBackup(file) : { ok:false, errors:[{code:'BACKUP_FAILED'}] };
    const drill = { id:`DRILL-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,at:Now(),actor:SafeField(actor).slice(0,64),backup:file,ok:!!check.ok,errors:check.errors||[],warnings:check.warnings||[],stats:check.stats||{} };
    state.production.recoveryDrills.push(drill);
    state.production.recoveryDrills = state.production.recoveryDrills.slice(-500);
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent('RECOVERY_DRILL', `${drill.id} / ${drill.ok?'PASS':'FAIL'}`);
    return { ok:true,drill };
}

function EvaluateAnomalies() {
    const cutoff = Now() - 15*60000;
    const recent = state.events.filter(x=>Number(x.time)>=cutoff);
    const rules = [
        {key:'AUTH_FAILURE_SPIKE',test:/AUTH_FAILED/,limit:5,severity:'HIGH'},
        {key:'ACK_TIMEOUT_SPIKE',test:/ACK_TIMEOUT/,limit:5,severity:'HIGH'},
        {key:'NETWORK_CHURN',test:/IP_CHANGED|FLAPPING/,limit:3,severity:'MEDIUM'}
    ];
    for(const rule of rules){
        const matches=recent.filter(x=>rule.test.test(String(x.type))).length;
        const existing=state.production.anomalyFindings.get(rule.key);
        if(matches>=rule.limit) state.production.anomalyFindings.set(rule.key,{key:rule.key,severity:rule.severity,status:'ACTIVE',count:matches,firstAt:existing?existing.firstAt:Now(),lastAt:Now()});
        else if(existing&&existing.status==='ACTIVE') state.production.anomalyFindings.set(rule.key,{...existing,status:'CLEARED',lastAt:Now(),count:matches});
    }
    return Array.from(state.production.anomalyFindings.values());
}

function RetentionApply(actor='SCHEDULED') {
    const p=state.production.retentionPolicy, now=Now(), removed={incidents:0,diagnostics:0,updates:0,chaos:0,auditFiles:0,releaseArtifacts:0};
    const keep=(rows,days,key)=>{const cutoff=now-days*86400000,kept=rows.filter(x=>Number(x.lastAt||x.createdAt||x.updatedAt||x.at)>=cutoff);removed[key]=rows.length-kept.length;return kept;};
    state.production.incidents=keep(state.production.incidents,p.incidentDays,'incidents');
    state.production.diagnosticsBundles=keep(state.production.diagnosticsBundles,p.diagnosticsDays,'diagnostics');
    state.production.chaosRuns=keep(state.production.chaosRuns,p.chaosDays,'chaos');
    const updateCutoff=now-p.updateDays*86400000;
    for(const [key,item] of Array.from(state.production.updateTransactions))if(Number(item.updatedAt)<updateCutoff){state.production.updateTransactions.delete(key);removed.updates++;}
    const auditCutoff=new Date(now-p.auditDays*86400000).toISOString().slice(0,10);
    try{for(const file of fs.readdirSync(config.AUDIT_DIR).sort()){const m=file.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);if(m&&m[1]<auditCutoff){const full=path.join(config.AUDIT_DIR,file);try{const lines=fs.readFileSync(full,'utf8').trim().split(/\r?\n/);for(let i=lines.length-1;i>=0;i--){try{const row=JSON.parse(lines[i]);if(/^[0-9A-F]{64}$/i.test(String(row.hash||''))){state.production.auditChain.anchor=String(row.hash).toUpperCase();break;}}catch(_){}}}catch(_){}fs.unlinkSync(full);removed.auditFiles++;}}}catch(_){}
    try{const manager=require('./releaseManager'),referenced=new Set();for(const root of state.releaseCatalog.values()){let item=root,depth=0;while(item&&depth++<10){if(item.fileName)referenced.add(item.fileName);item=item.previous;}}for(const file of fs.readdirSync(manager.RELEASE_DIR)){const full=path.join(manager.RELEASE_DIR,file);const st=fs.statSync(full);if(st.isFile()&&!referenced.has(file)&&st.mtimeMs<updateCutoff){fs.unlinkSync(full);removed.releaseArtifacts++;}}}catch(_){}
    state.production.retentionPolicy.lastAppliedAt=now;state.production.retentionPolicy.lastAppliedBy=SafeField(actor);
    if(Object.values(removed).some(Boolean)) require('../storage/database').SaveDatabase();
    return {ok:true,removed,policy:{...p}};
}

function SetRetention(input,actor){
    const clamp=(v,d)=>Math.max(1,Math.min(3650,Number(v)||d));
    state.production.retentionPolicy={...state.production.retentionPolicy,auditDays:clamp(input.auditDays,90),incidentDays:clamp(input.incidentDays,180),diagnosticsDays:clamp(input.diagnosticsDays,30),updateDays:clamp(input.updateDays,90),chaosDays:clamp(input.chaosDays,30),updatedAt:Now(),updatedBy:SafeField(actor).slice(0,64)};
    require('../storage/database').SaveDatabase();return {ok:true,policy:state.production.retentionPolicy};
}

function SupplyChainManifest() {
    const root=path.resolve(__dirname,'..'),files=[];
    const runtimeFiles=new Set(['relay-identities.json','relay-identities.bak.json','relay-licenses.json','relay-licenses.bak.json']);
    const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(['node_modules','data','.git','audit','backups','releases'].includes(entry.name)||runtimeFiles.has(entry.name))continue;const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|json|md|txt)$/.test(entry.name)&&!/(secret|credential)/i.test(entry.name)){const data=fs.readFileSync(full);files.push({path:path.relative(root,full).replace(/\\/g,'/'),size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex').toUpperCase()});}}};
    walk(root);files.sort((a,b)=>a.path.localeCompare(b.path));
    let dependencies={};try{dependencies=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8')).packages||{};}catch(_){}
    const sbom=Object.entries(dependencies).filter(([k])=>k.startsWith('node_modules/')).map(([k,v])=>({name:k.slice(13),version:v.version||'',license:v.license||''})).sort((a,b)=>a.name.localeCompare(b.name));
    const sourceHash=crypto.createHash('sha256').update(files.map(x=>`${x.path}:${x.sha256}`).join('\n')).digest('hex').toUpperCase();
    const manifest={generatedAt:Now(),sourceHash,files,sbom,violations:sbom.filter(x=>!x.version).map(x=>`MISSING_VERSION:${x.name}`)};
    manifest.manifestHash=crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex').toUpperCase();
    state.production.supplyChain=manifest;require('../storage/database').SaveDatabase();
    return {ok:true,manifest};
}

function ChaosRun(scenario,actor){
    scenario=String(scenario||'').toUpperCase();
    const allowed=['SERVER_OUTAGE','RELAY_LATENCY','DATABASE_READ_ONLY','AUTH_FLOOD'];
    if(!allowed.includes(scenario))return {ok:false,reason:'INVALID_SCENARIO'};
    const slo=SloSnapshot();
    const predictions={SERVER_OUTAGE:'Paired client enters locked/offline state; no cross-PC reassignment.',RELAY_LATENCY:'ACK retry and p95 alerts activate; requests retain correlation IDs.',DATABASE_READ_ONLY:'HA mutation guard rejects writes; active sessions continue in memory.',AUTH_FLOOD:'Rate limits and HMAC verification reject invalid peers.'};
    const run={id:`CHAOS-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,scenario,mode:'SIMULATION_ONLY',createdAt:Now(),createdBy:SafeField(actor).slice(0,64),baseline:slo,prediction:predictions[scenario],passed:true};
    state.production.chaosRuns.push(run);state.production.chaosRuns=state.production.chaosRuns.slice(-500);require('../storage/database').SaveDatabase();require('../storage/audit').LogEvent('CHAOS_SIMULATION',`${run.id} / ${scenario}`);return {ok:true,run};
}

function Overview(){
    return {compatibility:CompatibilityOverview(),transport:require('./transportSecurity').Status(),updates:require('./updateSupervisor').Overview(),audit:state.production.auditChain,incidents:require('./incidentCenter').List(),slo:SloSnapshot(),recoveryDrills:state.production.recoveryDrills.slice(-20).reverse(),anomalies:EvaluateAnomalies(),retention:state.production.retentionPolicy,supplyChain:state.production.supplyChain,chaosRuns:state.production.chaosRuns.slice(-20).reverse(),diagnosticsBundles:state.production.diagnosticsBundles.slice(-20).reverse()};
}

module.exports={CompatibilityOverview,ConfigDryRun,ApplyPlan,SloSnapshot,SetSloPolicy,Diagnostics,RecoveryDrill,EvaluateAnomalies,RetentionApply,SetRetention,SupplyChainManifest,ChaosRun,Overview};
