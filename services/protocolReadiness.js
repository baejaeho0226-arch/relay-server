'use strict';

const state=require('../core/state');
const {NormalizeID,Now}=require('../core/utils');
const {Capabilities}=require('./deviceControl');

const REQUIRED=['PROTOCOL_V3_PREP','DEVICE_HMAC','EVENT_SEQUENCE'];

function MapFor(type){return String(type).toUpperCase()==='SERVER'?state.serverProtocolProfiles:state.clientProtocolProfiles;}
function RecordProfile(type,id,current,candidate,caps){
    id=NormalizeID(id);if(!id)return;
    MapFor(type).set(id,{current:Number(current)||0,candidate:Number(candidate)||0,caps:String(caps||'').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean),updatedAt:Now()});
}
function One(type,id){
    type=String(type||'').toUpperCase();id=NormalizeID(id);
    const p=MapFor(type).get(id)||null;
    const caps=new Set([...(p&&p.caps||[]),...Capabilities(type,id)]);
    const blockers=[];
    if(!p||p.current!==2)blockers.push('PROTOCOL_PROFILE_MISSING');
    if(!p||p.candidate<3)blockers.push('V3_CANDIDATE_MISSING');
    for(const cap of REQUIRED)if(!caps.has(cap))blockers.push(`CAP_${cap}_MISSING`);
    const key=`${type}:${id}`;
    const hasSecret=state.deviceSecrets.has(key);
    const live=type==='SERVER'?state.servers.get(id):state.clients.get(id);
    const hmacVerified=!!live&&live.deviceAuthVerified===true;
    if(caps.has('DEVICE_HMAC')&&!hasSecret)blockers.push('HMAC_SECRET_MISSING');
    if(caps.has('DEVICE_HMAC')&&live&&!hmacVerified)blockers.push('HMAC_NOT_VERIFIED');
    return {type,id,profile:p,capabilities:Array.from(caps).sort(),hasSecret,hmacVerified,ready:blockers.length===0,blockers};
}
function Overview(){
    const devices=[];
    for(const id of state.serverIdentities.values())devices.push(One('SERVER',id));
    for(const s of state.clientIdentities.values())devices.push(One('CLIENT',s.id));
    return {currentProtocol:2,candidateProtocol:3,requiredCapabilities:REQUIRED,ready:devices.filter(x=>x.ready).length,total:devices.length,devices};
}
module.exports={RecordProfile,One,Overview};
