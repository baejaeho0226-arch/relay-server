'use strict';
const { config, state, NormalizeID, ServerExists, ClientExists, SaveDatabase, LogEvent, deviceControl, featureFlags, protocolReadiness, deviceAuth, releaseManager, configHistory, deviceEnrollment, secretRotation, Json, ApiError, RequireAdmin, RequireOperation } = require('../apiContext');
async function Handle({ method, pathname, url, body, req, res, session }) {
    let match, m;
    if (method === 'GET' && pathname === '/api/releases') {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        Json(res, 200, { ok: true, releases: releaseManager.ReleaseOverview() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/releases/device-channel') {
        if (!RequireAdmin(res, session)) return true;
        const type=releaseManager.NormalizeType(body.type), id=NormalizeID(body.id), channel=releaseManager.NormalizeChannel(body.channel);
        if(!type||!id||!channel){ApiError(res,400,'INVALID_RELEASE_ASSIGNMENT');return true;}
        const exists=type==='SERVER'?ServerExists(id):ClientExists(id); if(!exists){ApiError(res,404,`${type}_NOT_FOUND`);return true;}
        releaseManager.SetChannel(type,id,channel); SaveDatabase();
        const push=releaseManager.NotifyDevice(type,id);
        LogEvent('RELEASE_CHANNEL', `${type} ${id} -> ${channel}`);
        Json(res,200,{ok:true,type,id,channel,push}); return true;
    }

    if (method === 'POST' && pathname === '/api/releases/rollout') {
        if (!RequireAdmin(res, session)) return true;
        const type=releaseManager.NormalizeType(body.type), channel=releaseManager.NormalizeChannel(body.channel);
        const percent=Number(body.rolloutPercent);
        if(!type||!channel||!Number.isFinite(percent)||percent<0||percent>100){ApiError(res,400,'INVALID_ROLLOUT');return true;}
        const release=releaseManager.SetRollout(type,channel,percent); if(!release){ApiError(res,404,'RELEASE_NOT_FOUND');return true;}
        SaveDatabase(); const pushes=releaseManager.NotifyAll();
        LogEvent('RELEASE_ROLLOUT', `${type}/${channel} -> ${release.rolloutPercent}%`);
        Json(res,200,{ok:true,release,pushes}); return true;
    }

    if (method === 'POST' && pathname === '/api/releases/enabled') {
        if (!RequireAdmin(res, session)) return true;
        const type=releaseManager.NormalizeType(body.type), channel=releaseManager.NormalizeChannel(body.channel);
        const release=releaseManager.SetReleaseEnabled(type,channel,body.enabled); if(!release){ApiError(res,404,'RELEASE_NOT_FOUND');return true;}
        SaveDatabase(); if(release.enabled)releaseManager.NotifyAll();
        LogEvent('RELEASE_ENABLED', `${type}/${channel} -> ${release.enabled}`);
        Json(res,200,{ok:true,release}); return true;
    }

    if (method === 'POST' && pathname === '/api/releases/push') {
        if (!RequireAdmin(res, session)) return true;
        const type=releaseManager.NormalizeType(body.type), id=NormalizeID(body.id);
        if ((body.type && !type) || (body.channel && !releaseManager.NormalizeChannel(body.channel)) || (body.id && !id)) { ApiError(res,400,'INVALID_DEVICE');return true; }
        if(type&&id){Json(res,200,{ok:true,result:releaseManager.NotifyDevice(type,id)});return true;}
        Json(res,200,{ok:true,results:releaseManager.NotifyAll({type,channel:body.channel})}); return true;
    }

    if (method === 'GET' && pathname === '/api/control/config-history') {
        if (!RequireAdmin(res, session)) return true;
        const baseline=configHistory.EnsureBaseline(); SaveDatabase();
        Json(res,200,{ok:true,current:state.desiredRuntimeConfig,history:configHistory.List(Number(url.searchParams.get('limit')||100)),baselineId:baseline.id}); return true;
    }
    if (method === 'POST' && pathname === '/api/control/config-history/rollback') {
        if (!RequireAdmin(res, session)) return true;
        const r=configHistory.Rollback(body.id,session.role); if(!r.ok){ApiError(res,404,r.reason);return true;}
        SaveDatabase(); for(const d of deviceControl.DeviceOverview())if(d.online)deviceControl.PushDesiredConfig(d.type,d.id);
        LogEvent('CONFIG_ROLLBACK',`source=${r.source.id} revision=${r.currentRevision}`); Json(res,200,r); return true;
    }
    if (method === 'GET' && pathname === '/api/enrollment') { if(!RequireAdmin(res,session))return true;Json(res,200,{ok:true,enrollment:deviceEnrollment.Overview()});return true; }
    if (method === 'POST' && pathname === '/api/enrollment/policy') { if(!RequireAdmin(res,session))return true;const policy=deviceEnrollment.SetEnabled(body.enabled);SaveDatabase();LogEvent('ENROLLMENT_POLICY',`enabled=${policy.enabled}`);Json(res,200,{ok:true,policy});return true; }
    if (method === 'POST' && pathname === '/api/enrollment/decision') { if(!RequireAdmin(res,session))return true;const r=deviceEnrollment.Decide(body.requestId,body.status,session.role);if(!r.ok){ApiError(res,404,r.reason);return true;}SaveDatabase();LogEvent('ENROLLMENT_DECISION',`${r.record.type} ${r.record.deviceKey} ${r.record.status}`);Json(res,200,r);return true; }
    if (method === 'POST' && pathname === '/api/enrollment/reset') { if(!RequireAdmin(res,session))return true;const ok=deviceEnrollment.Reset(body.requestId);if(!ok){ApiError(res,404,'ENROLLMENT_NOT_FOUND');return true;}SaveDatabase();Json(res,200,{ok:true});return true; }

if (method === 'GET' && pathname === '/api/control/devices') {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        Json(res, 200, { ok: true, devices: deviceControl.DeviceOverview(), config: state.desiredRuntimeConfig }); return true;
    }
    if (method === 'POST' && pathname === '/api/control/config') {
        if (!RequireAdmin(res, session)) return true;
        configHistory.EnsureBaseline();
        const cfg=deviceControl.UpdateDesiredConfig(body);
        const history=configHistory.Record('RUNTIME_CONFIG',session.role,`revision=${cfg.revision}`);
        SaveDatabase();
        for(const d of deviceControl.DeviceOverview()) if(d.online) deviceControl.PushDesiredConfig(d.type,d.id);
        Json(res,200,{ok:true,config:cfg,history}); return true;
    }
    m=pathname.match(/^\/api\/control\/(server|client)\/([0-9A-Fa-f]{16})\/command$/);
    if(method==='POST'&&m){ if(!RequireAdmin(res,session))return true; const r=deviceControl.SendCommand(m[1],m[2],body.command,body.arg||''); if(!r.ok){ApiError(res,409,r.reason);return true;} Json(res,200,r);return true; }
    if (method === 'GET' && pathname === '/api/control/features') { if(!RequireOperation(res,session,'VIEW'))return true; Json(res,200,{ok:true,defaults:featureFlags.DEFAULTS,global:featureFlags.GlobalFlags(),serverOverrides:Object.fromEntries(state.serverFeatureOverrides),clientOverrides:Object.fromEntries(state.clientFeatureOverrides)});return true; }
    if (method === 'POST' && pathname === '/api/control/features/global') { if(!RequireAdmin(res,session))return true; configHistory.EnsureBaseline(); const flags=featureFlags.SetGlobalFlags(body.flags||{}); state.desiredRuntimeConfig.revision=Math.max(1,Number(state.desiredRuntimeConfig.revision||0)+1); const history=configHistory.Record('FEATURE_FLAGS_GLOBAL',session.role,`revision=${state.desiredRuntimeConfig.revision}`); SaveDatabase(); for(const d of deviceControl.DeviceOverview())if(d.online)deviceControl.PushDesiredConfig(d.type,d.id);Json(res,200,{ok:true,flags,history});return true; }
    if (method === 'POST' && pathname === '/api/control/features/device') { if(!RequireAdmin(res,session))return true; const type=String(body.type||'').toUpperCase(),id=NormalizeID(body.id); if(!['SERVER','CLIENT'].includes(type)||!id){ApiError(res,400,'INVALID_DEVICE');return true;} configHistory.EnsureBaseline(); const overrides=featureFlags.SetDeviceOverrides(type,id,body.flags||{}); state.desiredRuntimeConfig.revision=Math.max(1,Number(state.desiredRuntimeConfig.revision||0)+1); const history=configHistory.Record('FEATURE_FLAGS_DEVICE',session.role,`${type}:${id} revision=${state.desiredRuntimeConfig.revision}`);SaveDatabase();deviceControl.PushDesiredConfig(type,id);Json(res,200,{ok:true,overrides,effective:featureFlags.EffectiveFlags(type,id),history});return true; }
    if (method === 'GET' && pathname === '/api/control/protocol-readiness') { if(!RequireOperation(res,session,'VIEW'))return true;Json(res,200,{ok:true,readiness:protocolReadiness.Overview()});return true; }
    if (method === 'GET' && pathname === '/api/control/security') { if(!RequireOperation(res,session,'VIEW'))return true;Json(res,200,{ok:true,devices:deviceAuth.Overview()});return true; }
    if (method === 'GET' && pathname === '/api/control/sequences') { if(!RequireOperation(res,session,'VIEW'))return true;Json(res,200,{ok:true,devices:require('../../services/eventSequence').Overview()});return true; }
    if (method === 'POST' && pathname === '/api/control/security/challenge') { if(!RequireAdmin(res,session))return true;const r=deviceAuth.IssueChallenge(body.type,body.id);if(!r.ok){ApiError(res,409,r.reason);return true;}Json(res,200,r);return true; }
    if (method === 'POST' && pathname === '/api/control/security/reset') { if(!RequireAdmin(res,session))return true;const r=deviceAuth.Reset(body.type,body.id);if(!r.ok){ApiError(res,409,r.reason);return true;}Json(res,200,r);return true; }
    if (method === 'GET' && pathname === '/api/control/security/rotations') { if(!RequireOperation(res,session,'VIEW'))return true;Json(res,200,{ok:true,rotations:secretRotation.Overview()});return true; }
    if (method === 'POST' && pathname === '/api/control/security/rotate') { if(!RequireAdmin(res,session))return true;const r=secretRotation.Start(body.type,body.id);if(!r.ok){ApiError(res,409,r.reason);return true;}SaveDatabase();LogEvent('DEVICE_SECRET_ROTATION_START',`${String(body.type||'').toUpperCase()} ${NormalizeID(body.id)} ${r.rotation.rotationId}`);Json(res,200,r);return true; }
    m=pathname.match(/^\/api\/licenses\/([^/]+)\/qr$/);
    if(method==='GET'&&m){if(!RequireOperation(res,session,'VIEW'))return true;ApiError(res,410,'LEGACY_LICENSE_QR_DISABLED','Use the QR device approval page.');return true;}


    return false;
}
module.exports = { Handle };
