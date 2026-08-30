'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');
const { CompareVersions, NormalizeID, NormalizeVersion, SafeField, SendLine } = require('../core/utils');
const { GetOnlineServer, GetOnlineClient } = require('../identity/identityManager');

const RELEASE_DIR = path.join(config.DATA_DIR, 'releases');
const SECRET_FILE = path.join(config.DATA_DIR, 'update-download-secret.txt');
const CHANNELS = ['STABLE', 'BETA', 'TEST'];
const TYPES = ['SERVER', 'CLIENT'];
const MAX_RELEASE_BYTES = Math.max(8 * 1024 * 1024, Number(process.env.MAX_RELEASE_BYTES || 256 * 1024 * 1024));

function EnsureDir() { fs.mkdirSync(RELEASE_DIR, { recursive: true }); }
function NormalizeType(value) { const v=String(value||'').toUpperCase(); return TYPES.includes(v)?v:''; }
function NormalizeChannel(value) { const v=String(value||'').toUpperCase(); return CHANNELS.includes(v)?v:''; }
function DeviceKey(type,id){ return `${NormalizeType(type)}:${NormalizeID(id)}`; }
function ReleaseKey(type,channel){ return `${NormalizeType(type)}:${NormalizeChannel(channel)}`; }
function SafeFileName(value){ return String(value||'release.bin').replace(/[^A-Za-z0-9._-]/g,'_').slice(-120) || 'release.bin'; }
function RandomId(){ return crypto.randomBytes(12).toString('hex').toUpperCase(); }
function SigningSecret(){
    EnsureDir();
    try { const s=fs.readFileSync(SECRET_FILE,'utf8').trim(); if(s.length>=48)return s; } catch(_) {}
    const s=crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(SECRET_FILE,s,{encoding:'utf8',mode:0o600,flag:'wx'}); } catch(_) { try { return fs.readFileSync(SECRET_FILE,'utf8').trim(); } catch(__) {} }
    return s;
}
function HashBucket(type,id){ const h=crypto.createHash('sha256').update(`${NormalizeType(type)}:${NormalizeID(id)}`).digest(); return h.readUInt32BE(0)%100; }
function ChannelFor(type,id){ return state.deviceReleaseChannels.get(DeviceKey(type,id)) || 'STABLE'; }
function SetChannel(type,id,channel){ type=NormalizeType(type); id=NormalizeID(id); channel=NormalizeChannel(channel); if(!type||!id||!channel)return false; state.deviceReleaseChannels.set(DeviceKey(type,id),channel); return true; }
function GetRelease(type,channel){ return state.releaseCatalog.get(ReleaseKey(type,channel)) || null; }
function EligibleForRollout(type,id,release){ if(!release)return false; const p=Math.max(0,Math.min(100,Number(release.rolloutPercent??100))); return p>=100 || HashBucket(type,id)<p; }
function SignedDownload(artifactId,ttlMs=15*60*1000){ const exp=Date.now()+ttlMs; const sig=crypto.createHmac('sha256',SigningSecret()).update(`${artifactId}|${exp}`).digest('hex'); const rel=`/updates/${encodeURIComponent(artifactId)}?exp=${exp}&sig=${sig}`; return config.UPDATE_BASE_URL ? config.UPDATE_BASE_URL + rel : rel; }
function VerifyDownload(artifactId,exp,sig){ exp=Number(exp); if(!artifactId||!Number.isFinite(exp)||exp<Date.now()||exp>Date.now()+60*60*1000)return false; const expected=crypto.createHmac('sha256',SigningSecret()).update(`${artifactId}|${exp}`).digest('hex'); const a=Buffer.from(String(sig||'')); const b=Buffer.from(expected); return a.length===b.length && crypto.timingSafeEqual(a,b); }
function FindArtifact(id){ for(const r of state.releaseCatalog.values())if(r&&r.artifactId===id)return r; return null; }
function UpdateForDevice(type,id,currentVersion){
    type=NormalizeType(type); id=NormalizeID(id); const channel=ChannelFor(type,id); const release=GetRelease(type,channel);
    if(!type||!id||!release||!release.enabled)return {available:false,channel};
    if(!EligibleForRollout(type,id,release))return {available:false,channel,reason:'CANARY_NOT_SELECTED',bucket:HashBucket(type,id),rolloutPercent:release.rolloutPercent};
    const current=NormalizeVersion(currentVersion||''); const target=NormalizeVersion(release.version||'');
    if(!target || (current && CompareVersions(current,target)>=0))return {available:false,channel,currentVersion:current,targetVersion:target};
    return {available:true,channel,currentVersion:current,targetVersion:target,release:{...release,download:SignedDownload(release.artifactId)}};
}

function UpdateMessageSignature(type,id,fields){
    const secret=state.deviceSecrets.get(DeviceKey(type,id))||'';
    if(!secret)return '';
    const canonical=['UPDATE',NormalizeType(type),NormalizeID(id),...fields].join('|');
    return crypto.createHmac('sha256',secret).update(canonical,'utf8').digest('hex').toUpperCase();
}

function NotifyDevice(type,id){
    type=NormalizeType(type); id=NormalizeID(id); const c=type==='SERVER'?GetOnlineServer(id):GetOnlineClient(id); if(!c)return {ok:false,reason:'OFFLINE'};
    const caps=state.deviceCapabilities.get(DeviceKey(type,id))||new Set();
    if(!caps.has('AUTO_UPDATE'))return {ok:false,reason:'CAPABILITY_MISSING'};
    if(!caps.has('SIGNED_UPDATE'))return {ok:false,reason:'SIGNED_UPDATE_CAPABILITY_MISSING'};
    const secret=state.deviceSecrets.get(DeviceKey(type,id));
    if(!secret || c.deviceAuthVerified!==true)return {ok:false,reason:'DEVICE_AUTH_REQUIRED'};
    const u=UpdateForDevice(type,id,c.appVersion); if(!u.available)return {ok:true,available:false,reason:u.reason||''};
    const r=u.release; if(!config.UPDATE_BASE_URL)return {ok:false,available:true,reason:'UPDATE_BASE_URL_REQUIRED',version:r.version,channel:u.channel};
    const fields=[r.version,u.channel,r.download,r.sha256,String(r.size),r.mandatory?'1':'0',encodeURIComponent(r.notes||''),encodeURIComponent(r.originalName||r.fileName||'')];
    const signature=UpdateMessageSignature(type,id,fields);
    if(!signature)return {ok:false,reason:'UPDATE_SIGNATURE_FAILED'};
    const line=['UPDATE_AVAILABLE',...fields,signature].join('|');
    return {ok:SendLine(c.socket,line),available:true,version:r.version,channel:u.channel};
}

function RecordUpdateAck(type,id,parts){
    type=NormalizeType(type); id=NormalizeID(id); if(!type||!id)return null;
    if(!Array.isArray(parts))parts=String(parts||'').split('|');
    const version=NormalizeVersion(parts[1]||'');
    const status=SafeField(parts[2]||'UNKNOWN').slice(0,64).toUpperCase();
    const detail=SafeField(parts.slice(3).join('|')).slice(0,500);
    const item={type,id,version,status,detail,at:Date.now()};
    state.deviceUpdateStatus.set(DeviceKey(type,id),item);
    return item;
}
function GetUpdateStatus(type,id){ return state.deviceUpdateStatus.get(DeviceKey(type,id)) || null; }

function NotifyAll(){ const out=[]; for(const id of state.serverIdentities.values())out.push({type:'SERVER',id,...NotifyDevice('SERVER',id)}); for(const saved of state.clientIdentities.values())out.push({type:'CLIENT',id:saved.id,...NotifyDevice('CLIENT',saved.id)}); return out; }
function ReleaseOverview(){
    const releases=[]; for(const r of state.releaseCatalog.values())releases.push({...r}); releases.sort((a,b)=>`${a.type}:${a.channel}`.localeCompare(`${b.type}:${b.channel}`));
    const assignments=[];
    for(const id of state.serverIdentities.values()){const channel=ChannelFor('SERVER',id),c=GetOnlineServer(id),u=UpdateForDevice('SERVER',id,c?c.appVersion:'');assignments.push({type:'SERVER',id,channel,bucket:HashBucket('SERVER',id),online:!!c,currentVersion:c?c.appVersion:'',update:u,updateStatus:GetUpdateStatus('SERVER',id)});}
    for(const saved of state.clientIdentities.values()){const id=saved.id,channel=ChannelFor('CLIENT',id),c=GetOnlineClient(id),u=UpdateForDevice('CLIENT',id,c?c.appVersion:'');assignments.push({type:'CLIENT',id,channel,bucket:HashBucket('CLIENT',id),online:!!c,currentVersion:c?c.appVersion:'',update:u,updateStatus:GetUpdateStatus('CLIENT',id)});}
    return {channels:CHANNELS,releases,assignments,maxReleaseBytes:MAX_RELEASE_BYTES};
}
function SetRollout(type,channel,percent){ const r=GetRelease(type,channel); if(!r)return null; r.rolloutPercent=Math.max(0,Math.min(100,Number(percent)||0)); r.updatedAt=Date.now(); return r; }
function SetReleaseEnabled(type,channel,enabled){ const r=GetRelease(type,channel); if(!r)return null; r.enabled=!!enabled; r.updatedAt=Date.now(); return r; }
function PublishFromTemp(meta,tmpPath,sha256,size){
    const type=NormalizeType(meta.type), channel=NormalizeChannel(meta.channel), version=NormalizeVersion(meta.version);
    if(!type||!channel||!version)throw new Error('INVALID_RELEASE_META');
    const ext=path.extname(SafeFileName(meta.fileName)).toLowerCase(); const allow=type==='CLIENT'?new Set(['.apk','.zip']):new Set(['.zip','.exe']); if(!allow.has(ext))throw new Error('INVALID_ARTIFACT_TYPE');
    const artifactId=RandomId(); const destName=`${type.toLowerCase()}-${channel.toLowerCase()}-${version}-${artifactId}${ext}`; const dest=path.join(RELEASE_DIR,destName); EnsureDir(); fs.renameSync(tmpPath,dest);
    const release={artifactId,type,channel,version,fileName:destName,originalName:SafeFileName(meta.fileName),sha256,size:Number(size)||0,mandatory:!!meta.mandatory,notes:SafeField(meta.notes||'').slice(0,1000),rolloutPercent:Math.max(0,Math.min(100,Number(meta.rolloutPercent??100))),enabled:true,createdAt:Date.now(),updatedAt:Date.now()};
    const old=GetRelease(type,channel); state.releaseCatalog.set(ReleaseKey(type,channel),release); if(old&&old.fileName&&old.fileName!==release.fileName){try{fs.unlinkSync(path.join(RELEASE_DIR,old.fileName));}catch(_) {}}
    return release;
}
function ArtifactPath(release){ if(!release||!release.fileName)return ''; const p=path.resolve(RELEASE_DIR,release.fileName); return p.startsWith(path.resolve(RELEASE_DIR)+path.sep)?p:''; }

module.exports={RELEASE_DIR,MAX_RELEASE_BYTES,CHANNELS,TYPES,NormalizeType,NormalizeChannel,ChannelFor,SetChannel,GetRelease,HashBucket,EligibleForRollout,SignedDownload,VerifyDownload,FindArtifact,UpdateForDevice,NotifyDevice,NotifyAll,ReleaseOverview,SetRollout,SetReleaseEnabled,PublishFromTemp,ArtifactPath,SigningSecret,RecordUpdateAck,GetUpdateStatus,UpdateMessageSignature};
