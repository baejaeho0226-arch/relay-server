'use strict';

const crypto = require('crypto');
const state = require('../core/state');
const { NormalizeID, SendLine } = require('../core/utils');
const { GetOnlineServer, GetOnlineClient } = require('../identity/identityManager');

const TTL_MS = 10 * 60 * 1000;
function Type(v){v=String(v||'').toUpperCase();return v==='SERVER'||v==='CLIENT'?v:'';}
function K(type,id){return `${Type(type)}:${NormalizeID(id)}`;}
function Online(type,id){return Type(type)==='SERVER'?GetOnlineServer(id):GetOnlineClient(id);}
function NewId(){return crypto.randomBytes(8).toString('hex').toUpperCase();}
function Derive(secret,type,id,rotationId,nonce,expiresAt){return crypto.createHmac('sha256',secret).update(`ROTATE|${Type(type)}|${NormalizeID(id)}|${rotationId}|${nonce}|${expiresAt}`,'utf8').digest('hex').toUpperCase();}
function Proof(secret,type,id,rotationId,status){return crypto.createHmac('sha256',secret).update(`ROTATE_ACK|${Type(type)}|${NormalizeID(id)}|${rotationId}|${status}`,'utf8').digest('hex').toUpperCase();}
function SafeEqualHex(a,b){try{const x=Buffer.from(String(a||''),'hex'),y=Buffer.from(String(b||''),'hex');return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y);}catch(_){return false;}}
function Current(type,id){const r=state.deviceSecretRotations.get(K(type,id));if(!r)return null;if(r.expiresAt<Date.now()&&r.status!=='COMPLETED'){r.status='EXPIRED';r.expiredAt=Date.now();}return r;}
function Start(type,id){
    type=Type(type);id=NormalizeID(id);const key=K(type,id),c=Online(type,id),oldSecret=state.deviceSecrets.get(key);
    if(!type||!id)return {ok:false,reason:'INVALID_DEVICE'}; if(!c)return {ok:false,reason:'OFFLINE'}; if(!oldSecret)return {ok:false,reason:'SECRET_MISSING'};
    const caps=require('./deviceControl').Capabilities(type,id); if(!caps.includes('SECRET_ROTATION'))return {ok:false,reason:'CAPABILITY_MISSING'};
    const existing=Current(type,id);
    if(existing&&!['EXPIRED','COMPLETED','FAILED'].includes(existing.status))return {ok:false,reason:'ROTATION_PENDING'};
    const rotationId=NewId(),nonce=crypto.randomBytes(24).toString('hex').toUpperCase(),expiresAt=Date.now()+TTL_MS;
    const r={rotationId,type,id,nonce,expiresAt,status:'OFFERED',startedAt:Date.now(),readyAt:0,committedAt:0,completedAt:0};
    state.deviceSecretRotations.set(key,r);
    if(!require('../storage/database').SaveDatabase()){if(existing)state.deviceSecretRotations.set(key,existing);else state.deviceSecretRotations.delete(key);return {ok:false,reason:'STORAGE_SAVE_FAILED'};}
    if(!SendLine(c.socket,`DEVICE_SECRET_ROTATE|${rotationId}|${nonce}|${expiresAt}`))return {ok:false,reason:'SEND_FAILED'};
    return {ok:true,rotation:{...r}};
}
function PendingSecret(type,id){const r=Current(type,id),old=state.deviceSecrets.get(K(type,id));if(!r||!old||['EXPIRED','COMPLETED','FAILED'].includes(r.status))return '';return Derive(old,type,id,r.rotationId,r.nonce,r.expiresAt);}
function Commit(r,next){
    const key=K(r.type,r.id),oldSecret=state.deviceSecrets.get(key),oldMeta=state.deviceSecretMeta.get(key),previous={...r};
    state.deviceSecrets.set(key,next);
    state.deviceSecretMeta.set(key,{createdAt:Number(oldMeta&&oldMeta.createdAt)||Date.now(),rotatedAt:Date.now(),rotationCount:(Number(oldMeta&&oldMeta.rotationCount)||0)+1});
    r.status='COMPLETED';r.completedAt=Date.now();
    if(!require('../storage/database').SaveDatabase()){
        state.deviceSecrets.set(key,oldSecret);if(oldMeta)state.deviceSecretMeta.set(key,oldMeta);else state.deviceSecretMeta.delete(key);
        Object.assign(r,previous);return false;
    }
    const c=Online(r.type,r.id);if(c)SendLine(c.socket,`DEVICE_SECRET_ROTATE_DONE|${r.rotationId}`);
    return true;
}
function HandleAck(type,id,parts){
    type=Type(type);id=NormalizeID(id);const r=Current(type,id);if(!r)return {ok:false,reason:'ROTATION_NOT_FOUND'};
    const rotationId=String(parts[1]||''),status=String(parts[2]||'').toUpperCase(),proof=String(parts[3]||'').toUpperCase();
    if(rotationId!==r.rotationId)return {ok:false,reason:'ROTATION_ID_MISMATCH'};
    const oldSecret=state.deviceSecrets.get(K(type,id)); if(!oldSecret)return {ok:false,reason:'SECRET_MISSING'};
    if(r.status==='COMPLETED'){
        if(status==='COMMITTED'&&SafeEqualHex(Proof(oldSecret,type,id,r.rotationId,status),proof)){
            const c=Online(type,id);if(c)SendLine(c.socket,`DEVICE_SECRET_ROTATE_DONE|${r.rotationId}`);
            return {ok:true,status:r.status};
        }
        return {ok:false,reason:'ROTATION_COMPLETED'};
    }
    if(['EXPIRED','FAILED'].includes(r.status))return {ok:false,reason:'ROTATION_EXPIRED'};
    const next=Derive(oldSecret,type,id,r.rotationId,r.nonce,r.expiresAt);
    if(!SafeEqualHex(Proof(next,type,id,r.rotationId,status),proof))return {ok:false,reason:'INVALID_ROTATION_PROOF'};
    if(status==='READY'){
        r.status='READY';r.readyAt=Date.now();
        require('../storage/database').SaveDatabase();
        const c=Online(type,id); if(c)SendLine(c.socket,`DEVICE_SECRET_ROTATE_COMMIT|${r.rotationId}`);
        r.committedAt=Date.now();
        return {ok:true,status:r.status};
    }
    if(status==='COMMITTED'){
        if(!Commit(r,next))return {ok:false,reason:'STORAGE_SAVE_FAILED'};
        try{require('./deviceAuth').IssueChallenge(type,id);}catch(_){}
        return {ok:true,status:r.status};
    }
    return {ok:false,reason:'INVALID_ROTATION_STATUS'};
}
function VerifyAlternateAuth(type,id,ch,hex){
    const r=Current(type,id);if(!r||['EXPIRED','COMPLETED','FAILED'].includes(r.status))return false;
    const old=state.deviceSecrets.get(K(type,id));if(!old)return false;
    const pending=Derive(old,type,id,r.rotationId,r.nonce,r.expiresAt);
    const expected=crypto.createHmac('sha256',pending).update(`${ch.type}|${ch.id}|${ch.challengeId}|${ch.nonce}|${ch.issuedAt}`,'utf8').digest('hex').toUpperCase();
    if(!SafeEqualHex(expected,hex))return false;
    // A reconnect proof under the committed device key finishes a lost ACK.
    // Persist that key before biometric/update HMAC uses the current secret.
    return Commit(r,pending);
}
function Overview(){const out=[];for(const r of state.deviceSecretRotations.values())out.push({...Current(r.type,r.id)});return out.sort((a,b)=>(b.startedAt||0)-(a.startedAt||0));}
module.exports={TTL_MS,Derive,Proof,Start,Current,PendingSecret,HandleAck,VerifyAlternateAuth,Overview};
