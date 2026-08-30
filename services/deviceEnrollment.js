'use strict';

const crypto = require('crypto');
const state = require('../core/state');
const { SafeField } = require('../core/utils');

function Type(v){ v=String(v||'').toUpperCase(); return v==='SERVER'||v==='CLIENT'?v:''; }
function Key(type,deviceKey){ return `${Type(type)}:${String(deviceKey||'').trim()}`; }
function NewId(){ return crypto.randomBytes(8).toString('hex').toUpperCase(); }
function Enabled(){ return !!state.enrollmentPolicy.enabled; }
function SetEnabled(value){ state.enrollmentPolicy.enabled=!!value; state.enrollmentPolicy.updatedAt=Date.now(); return {...state.enrollmentPolicy}; }
function Request(type, deviceKey, meta={}) {
    type=Type(type); deviceKey=String(deviceKey||'').trim();
    if(!type||!deviceKey)return {allowed:false,reason:'INVALID_DEVICE'};
    if(!Enabled())return {allowed:true,policy:false};
    const key=Key(type,deviceKey); let r=state.deviceEnrollments.get(key);
    if(r&&r.status==='APPROVED')return {allowed:true,approved:true,record:r};
    if(r&&r.status==='REJECTED')return {allowed:false,rejected:true,reason:'ENROLLMENT_REJECTED',record:r};
    if(!r){
        r={requestId:NewId(),type,deviceKey,status:'PENDING',firstSeenAt:Date.now(),lastSeenAt:Date.now(),ip:SafeField(meta.ip||''),appVersion:SafeField(meta.appVersion||''),protocolVersion:Number(meta.protocolVersion||0),decisionAt:0,decidedBy:'',assignedId:''};
        state.deviceEnrollments.set(key,r);
    } else {
        r.lastSeenAt=Date.now(); r.ip=SafeField(meta.ip||r.ip); r.appVersion=SafeField(meta.appVersion||r.appVersion); r.protocolVersion=Number(meta.protocolVersion||r.protocolVersion||0);
    }
    return {allowed:false,pending:true,reason:'ENROLLMENT_PENDING',record:r};
}
function FindByRequestId(id){ for(const r of state.deviceEnrollments.values())if(r.requestId===String(id||''))return r; return null; }
function Decide(requestId,status,actor='admin'){
    const r=FindByRequestId(requestId); if(!r)return {ok:false,reason:'ENROLLMENT_NOT_FOUND'};
    status=String(status||'').toUpperCase(); if(!['APPROVED','REJECTED'].includes(status))return {ok:false,reason:'INVALID_DECISION'};
    r.status=status; r.decisionAt=Date.now(); r.decidedBy=String(actor||'admin').slice(0,64); return {ok:true,record:r};
}
function Reset(requestId){ const r=FindByRequestId(requestId); if(!r)return false; return state.deviceEnrollments.delete(Key(r.type,r.deviceKey)); }
function MarkBound(type,deviceKey,id){ const r=state.deviceEnrollments.get(Key(type,deviceKey)); if(r){r.assignedId=String(id||'');r.boundAt=Date.now();} }
function Overview(){ const records=Array.from(state.deviceEnrollments.values()).sort((a,b)=>(b.lastSeenAt||0)-(a.lastSeenAt||0)); return {policy:{...state.enrollmentPolicy},pending:records.filter(x=>x.status==='PENDING').length,approved:records.filter(x=>x.status==='APPROVED').length,rejected:records.filter(x=>x.status==='REJECTED').length,records}; }
module.exports={Enabled,SetEnabled,Request,FindByRequestId,Decide,Reset,MarkBound,Overview,Key};
