'use strict';

const crypto = require('crypto');
const state = require('../core/state');
const { NormalizeID, Now, SendLine } = require('../core/utils');
const { GetOnlineServer, GetOnlineClient } = require('../identity/identityManager');
const { FeatureEnabled } = require('./featureFlags');
const { Capabilities } = require('./deviceControl');

function K(type,id){return `${String(type).toUpperCase()}:${NormalizeID(id)}`;}
function Online(type,id){return String(type).toUpperCase()==='SERVER'?GetOnlineServer(id):GetOnlineClient(id);}
function NewSecret(){return crypto.randomBytes(32).toString('base64url');}
function Status(type,id,status,extra={}){
    const key=K(type,id), old=state.deviceAuthStatus.get(key)||{};
    state.deviceAuthStatus.set(key,{...old,...extra,status});
}

function SendEnrollmentSecret(type,id,force=false){
    type=String(type||'').toUpperCase(); id=NormalizeID(id);
    const key=K(type,id),c=Online(type,id);
    if(!c)return {ok:false,reason:'OFFLINE'};
    if(!Capabilities(type,id).includes('DEVICE_HMAC'))return {ok:false,reason:'CAPABILITY_MISSING'};

    let secret=state.deviceSecrets.get(key);
    if(secret && !force) return IssueChallenge(type,id);

    secret=NewSecret();
    state.deviceSecrets.set(key,secret);
    state.deviceSecretMeta.set(key,{createdAt:Now(),rotatedAt:0,rotationCount:0});
    require('../storage/database').SaveDatabase();
    c.deviceAuthVerified=false;
    SendLine(c.socket,`DEVICE_SECRET|${secret}`);
    Status(type,id,'ENROLLING',{enrolledAt:Now(),verifiedAt:0});
    return {ok:true,enrolling:true};
}

function IssueChallenge(type,id){
    type=String(type||'').toUpperCase(); id=NormalizeID(id);
    const key=K(type,id),c=Online(type,id);
    if(!c)return {ok:false,reason:'OFFLINE'};
    if(!Capabilities(type,id).includes('DEVICE_HMAC'))return {ok:false,reason:'CAPABILITY_MISSING'};
    if(!state.deviceSecrets.has(key))return SendEnrollmentSecret(type,id,false);

    const challengeId=crypto.randomBytes(8).toString('hex').toUpperCase();
    const nonce=crypto.randomBytes(16).toString('hex').toUpperCase();
    const issuedAt=Now();
    c.deviceAuthVerified=false;
    state.deviceAuthChallenges.set(challengeId,{challengeId,type,id,nonce,issuedAt,expiresAt:issuedAt+30000});
    Status(type,id,'CHALLENGED',{lastChallengeAt:issuedAt});
    SendLine(c.socket,`AUTH_CHALLENGE|${challengeId}|${nonce}|${issuedAt}`);
    return {ok:true,challengeId};
}

function HandleSecretAck(type,id){
    const key=K(type,id),old=state.deviceAuthStatus.get(key)||{};
    Status(type,id,'ENROLLED',{enrolledAt:old.enrolledAt||Now()});
    return IssueChallenge(type,id);
}

function HandleDeviceAuthError(type,id,parts){
    type=String(type||'').toUpperCase(); id=NormalizeID(id);
    const c=Online(type,id);
    const challengeId=String(parts&&parts[1]||'').toUpperCase();
    const reason=String(parts&&parts[2]||'').toUpperCase();
    const ch=state.deviceAuthChallenges.get(challengeId);
    if(!c||reason!=='NO_SECRET'||!ch||ch.type!==type||ch.id!==id||ch.expiresAt<Now()){
        if(c) SendLine(c.socket,`DEVICE_AUTH_ERROR|${challengeId}|RECOVERY_DENIED`);
        return {ok:false,reason:'RECOVERY_DENIED'};
    }
    if(Number(c.deviceSecretRecoveryAt||0)>Now()-60000){
        SendLine(c.socket,`DEVICE_AUTH_ERROR|${challengeId}|RECOVERY_RATE_LIMIT`);
        return {ok:false,reason:'RECOVERY_RATE_LIMIT'};
    }
    c.deviceSecretRecoveryAt=Now();
    c.deviceAuthVerified=false;
    state.deviceAuthChallenges.delete(challengeId);
    require('../storage/audit').LogEvent('DEVICE_SECRET_RECOVERY',`${type} ${id} / LOCAL_SECRET_MISSING`);
    try{require('./notificationCenter').AddNotification({severity:'WARNING',type:'DEVICE_SECRET_RECOVERY',title:'Device secret recovered',message:`${type} ${id} re-enrolled after local secret loss.`,entityType:type,entityId:id,dedupeKey:`DEVICE_SECRET_RECOVERY|${type}|${id}`});}catch(_){}
    return SendEnrollmentSecret(type,id,true);
}

function Expected(ch,secret){
    return crypto.createHmac('sha256',secret).update(`${ch.type}|${ch.id}|${ch.challengeId}|${ch.nonce}|${ch.issuedAt}`,'utf8').digest('hex').toUpperCase();
}

function HandleAuth(type,id,challengeId,hex){
    type=String(type||'').toUpperCase(); id=NormalizeID(id);
    const c=Online(type,id),ch=state.deviceAuthChallenges.get(String(challengeId||''));
    if(!c||!ch||ch.type!==type||ch.id!==id||ch.expiresAt<Now()){
        if(c){c.deviceAuthVerified=false;SendLine(c.socket,`DEVICE_AUTH_ERROR|${challengeId}|INVALID_CHALLENGE`);}
        try{require('../storage/audit').LogEvent('DEVICE_AUTH_INVALID_CHALLENGE',`${type} ${id} ${challengeId}`);}catch(_){}
        return false;
    }
    const secret=state.deviceSecrets.get(K(type,id));
    const want=Expected(ch,secret||'');
    let ok=false;
    try{
        const a=Buffer.from(want,'hex'),b=Buffer.from(String(hex||''),'hex');
        ok=a.length===b.length&&a.length>0&&crypto.timingSafeEqual(a,b);
    }catch(_){}
    if(!ok){ try{ ok=require('./deviceSecretRotation').VerifyAlternateAuth(type,id,ch,hex); }catch(_){} }
    state.deviceAuthChallenges.delete(challengeId);
    if(ok){
        c.deviceAuthVerified=true;
        Status(type,id,'VERIFIED',{enrolledAt:(state.deviceAuthStatus.get(K(type,id))||{}).enrolledAt||Now(),verifiedAt:Now()});
        SendLine(c.socket,`DEVICE_AUTH_OK|${challengeId}`);
        if(type==='SERVER') require('./buildGate').TryDispatchServer(id);
        else require('./buildGate').TryDispatchClient(id);
        return true;
    }
    c.deviceAuthVerified=false;
    Status(type,id,'FAILED',{failedAt:Now()});
    try{require('../storage/audit').LogEvent('DEVICE_AUTH_FAILED',`${type} ${id} INVALID_HMAC`);}catch(_){}
    try{require('./notificationCenter').AddNotification({severity:'CRITICAL',type:'DEVICE_AUTH_FAILED',title:'Device HMAC authentication failed',message:`${type} ${id} rejected invalid HMAC`,entityType:type,entityId:id,dedupeKey:`DEVICE_AUTH_FAILED|${type}|${id}`});}catch(_){}
    SendLine(c.socket,`DEVICE_AUTH_ERROR|${challengeId}|INVALID_HMAC`);
    return false;
}

function Enforced(type,id){return FeatureEnabled(type,id,'DEVICE_HMAC_ENFORCE',false);}
function Verified(type,id){const c=Online(type,id);return !!c&&c.deviceAuthVerified===true;}
function RequireVerified(type,id){return !Enforced(type,id)||Verified(type,id);}

function Overview(){
    const out=[];
    for(const [deviceKey,id] of state.serverIdentities)out.push(Item('SERVER',id,deviceKey));
    for(const [deviceKey,s] of state.clientIdentities)out.push(Item('CLIENT',s.id,deviceKey));
    return out;
}
function Item(type,id,deviceKey){
    const key=K(type,id), c=Online(type,id);
    return {type,id,deviceKey,online:!!c,capable:Capabilities(type,id).includes('DEVICE_HMAC'),enforced:Enforced(type,id),hasSecret:state.deviceSecrets.has(key),verified:!!c&&c.deviceAuthVerified===true,status:state.deviceAuthStatus.get(key)||null};
}
function Reset(type,id){
    type=String(type||'').toUpperCase(); id=NormalizeID(id);
    const key=K(type,id),c=Online(type,id);
    if(!c)return {ok:false,reason:'OFFLINE'};
    if(!Capabilities(type,id).includes('DEVICE_HMAC'))return {ok:false,reason:'CAPABILITY_MISSING'};
    state.deviceSecrets.delete(key);state.deviceSecretMeta.delete(key);state.deviceAuthStatus.delete(key);
    c.deviceAuthVerified=false;
    require('../storage/database').SaveDatabase();
    return SendEnrollmentSecret(type,id,true);
}

module.exports={K,SendEnrollmentSecret,IssueChallenge,HandleSecretAck,HandleDeviceAuthError,HandleAuth,Enforced,Verified,RequireVerified,Overview,Reset};
