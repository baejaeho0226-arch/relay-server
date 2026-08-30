'use strict';

const crypto = require('crypto');
const state = require('../core/state');
const { NormalizeID, SafeField, SendLine, Now } = require('../core/utils');
const { GetOnlineServer, GetOnlineClient } = require('../identity/identityManager');
const { EffectiveFlags, FeatureEnabled, EncodeFlags } = require('./featureFlags');

function Key(type,id){ return `${String(type||'').toUpperCase()}:${NormalizeID(id)}`; }
function Online(type,id){ return String(type).toUpperCase()==='SERVER' ? GetOnlineServer(id) : GetOnlineClient(id); }
function RecordCapabilities(type,id,csv){
    const key=Key(type,id); if(!key.endsWith(':')) state.deviceCapabilities.set(key, new Set(String(csv||'').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean)));
}
function Capabilities(type,id){ return Array.from(state.deviceCapabilities.get(Key(type,id))||[]); }
function RecordDeviceInfo(type,id,parts){
    const key=Key(type,id); const values=Array.isArray(parts)?parts:[];
    state.deviceInfo.set(key,{type:String(type).toUpperCase(),id:NormalizeID(id),name:SafeField(values[0]||''),manufacturer:SafeField(values[1]||''),os:SafeField(values[2]||''),architecture:SafeField(values[3]||''),appVersion:SafeField(values[4]||''),protocolVersion:Number(values[5]||0),updatedAt:Now()});
}
function RecordDiagnostics(type,id,payload){ state.deviceDiagnostics.set(Key(type,id),{payload:SafeField(payload||'').slice(0,12000),updatedAt:Now()}); }
function RecordUiState(id,status,detail=''){ if(!FeatureEnabled('CLIENT',id,'UI_STATE',true))return; state.clientUiStates.set(NormalizeID(id),{status:SafeField(status||'UNKNOWN').toUpperCase(),detail:SafeField(detail||''),updatedAt:Now()}); }
function SendCommand(type,id,command,arg=''){
    type=String(type||'').toUpperCase(); id=NormalizeID(id); command=SafeField(command||'').toUpperCase();
    const allow=new Set(['RECONNECT','REFRESH_STATUS','SHOW_NOTICE','CLEAR_STATE','PING_TEST','GET_DIAGNOSTICS']);
    if(!id||!allow.has(command))return {ok:false,reason:'INVALID_COMMAND'};
    const flag=command==='GET_DIAGNOSTICS'?'REMOTE_DIAGNOSTICS':'REMOTE_COMMANDS';
    if(!FeatureEnabled(type,id,flag,true))return {ok:false,reason:'FEATURE_DISABLED'};
    const c=Online(type,id); if(!c)return {ok:false,reason:'OFFLINE'};
    const commandId=crypto.randomBytes(8).toString('hex').toUpperCase();
    if(!SendLine(c.socket,`COMMAND|${commandId}|${command}|${SafeField(arg||'')}`))return {ok:false,reason:'SEND_FAILED'};
    state.pendingDeviceCommands.set(commandId,{commandId,type,id,command,createdAt:Now(),status:'PENDING',detail:''});
    return {ok:true,commandId};
}
function RecordCommandAck(type,id,parts){ const commandId=String(parts[1]||'').trim(); const item=state.pendingDeviceCommands.get(commandId); if(item){item.status=String(parts[2]||'UNKNOWN').toUpperCase();item.detail=SafeField(parts.slice(3).join('|'));item.completedAt=Now();} }
function UpdateDesiredConfig(body){
    const c=state.desiredRuntimeConfig;
    if(Number.isFinite(Number(body.reconnectBaseMs)))c.reconnectBaseMs=Math.max(100,Math.min(60000,Number(body.reconnectBaseMs)));
    if(Number.isFinite(Number(body.reconnectMaxMs)))c.reconnectMaxMs=Math.max(c.reconnectBaseMs,Math.min(300000,Number(body.reconnectMaxMs)));
    if(Number.isFinite(Number(body.reconnectJitterPct)))c.reconnectJitterPct=Math.max(0,Math.min(100,Number(body.reconnectJitterPct)));
    if(Number.isFinite(Number(body.heartbeatMs)))c.heartbeatMs=Math.max(1000,Math.min(120000,Number(body.heartbeatMs)));
    c.revision=Math.max(1,Number(c.revision||0)+1);
    return c;
}
function PushDesiredConfig(type,id){ const c=Online(type,id); if(!c)return false; const d=state.desiredRuntimeConfig; return SendLine(c.socket,`CONFIG_UPDATE|${d.revision}|${d.reconnectBaseMs}|${d.reconnectMaxMs}|${d.heartbeatMs}|${d.reconnectJitterPct}|${EncodeFlags(type,id)}`); }
function DeviceOverview(){
    const out=[];
    for(const [deviceKey,id] of state.serverIdentities){ const c=GetOnlineServer(id); out.push({type:'SERVER',id,deviceKey,online:!!c,capabilities:Capabilities('SERVER',id),info:state.deviceInfo.get(Key('SERVER',id))||null,diagnostics:state.deviceDiagnostics.get(Key('SERVER',id))||null,flags:EffectiveFlags('SERVER',id),rttMs:c?c.rttMs:-1}); }
    for(const [deviceKey,saved] of state.clientIdentities){ const id=saved.id,c=GetOnlineClient(id); out.push({type:'CLIENT',id,deviceKey,online:!!c,serverId:saved.serverId,capabilities:Capabilities('CLIENT',id),info:state.deviceInfo.get(Key('CLIENT',id))||null,diagnostics:state.deviceDiagnostics.get(Key('CLIENT',id))||null,uiState:state.clientUiStates.get(id)||null,flags:EffectiveFlags('CLIENT',id),rttMs:c?c.rttMs:-1}); }
    return out;
}
module.exports={Key,RecordCapabilities,Capabilities,RecordDeviceInfo,RecordDiagnostics,RecordUiState,SendCommand,RecordCommandAck,UpdateDesiredConfig,PushDesiredConfig,DeviceOverview};
