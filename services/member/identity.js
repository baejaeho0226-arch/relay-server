'use strict';
// Handles address an already authenticated account; they never replace device proof.
const s=require('./store'),state=require('../../core/state'),crypto=require('node:crypto');
function Subject(key){return require('../clientInstallation').RegistryKey(key)||crypto.createHash('sha256').update('MEMBER:'+key).digest('hex').toUpperCase();}
function ClientIds(p){
 const ids=new Set();for(const [key,saved]of state.clientIdentities)if(Subject(key)===p.subject)ids.add(saved.id);
 const registry=state.clientInstallations.get(p.subject);for(const a of registry?.authorized||[])ids.add(a.clientId);
 for(const t of state.supportThreads.values())if(t.deviceKey===p.subject){ids.add(t.clientId);if(t.currentClientId)ids.add(t.currentClientId);}
 return [...ids].filter(Boolean);
}
function MemberIndex(){
 const out=new Map(),profiles=s.DB().profiles;
 for(const [key,saved]of state.clientIdentities){const p=profiles[Subject(key)];if(p)out.set(saved.id,p);}
 for(const [key,record]of state.clientInstallations){const p=profiles[key];if(p)for(const x of record.authorized||[])if(!out.has(x.clientId))out.set(x.clientId,p);}
 for(const t of state.supportThreads.values()){const p=profiles[t.deviceKey];if(p)for(const id of [t.clientId,t.currentClientId])if(id&&!out.has(id))out.set(id,p);}
 return out;
}
function ResolveClient(handle,selected=''){
 const p=s.Resolve(handle);if(!p)s.Fail('MEMBER_NOT_FOUND');const ids=ClientIds(p).filter(id=>require('../../identity/identityManager').GetSavedClientByID(id));
 if(selected){if(!ids.includes(selected))s.Fail('NOT_OWNER');return selected;}
 const live=ids.filter(id=>state.clients.get(id)?.connected);if(live.length===1)return live[0];if(ids.length!==1)s.Fail('MEMBER_DEVICE_SELECT');return ids[0];
}
function Rooms(p){const ids=ClientIds(p);return [...state.supportThreads.values()].filter(t=>t.deviceKey===p.subject||ids.includes(t.clientId)||ids.includes(t.currentClientId));}
function ResolveSupport(handle,selected=''){
 const p=s.Resolve(handle);if(!p)s.Fail('MEMBER_NOT_FOUND');const rooms=Rooms(p);
 if(selected){const room=rooms.find(t=>[t.clientId,t.currentClientId].includes(selected));if(!room)s.Fail('NOT_OWNER');return room.clientId;}
 if(rooms.length!==1)s.Fail(rooms.length?'MEMBER_DEVICE_SELECT':'SUPPORT_NOT_FOUND');return rooms[0].clientId;
}
function Home(p){
 const db=s.DB(),commerce=require('./commerce'),orders=Object.values(db.orders).filter(x=>x.accountId===p.id).map(commerce.PublicOrder),payments=commerce.PurchasePayments(p);
 const usable=orders.filter(x=>x.status==='PAID'||x.status==='ACTIVE').sort((a,b)=>Number(!a.activatedAt)-Number(!b.activatedAt)||(a.activatedAt||a.at)-(b.activatedAt||b.at));
 const firstPayments=[...payments].sort((a,b)=>a.at-b.at);
 const extras=require('./home').Extras(p);
 return {...extras,settings:{},profile:s.PublicProfile(p,true),counts:{...extras.counts,orders:orders.length,payments:payments.length},
  summary:{ready:orders.filter(x=>x.status==='PAID').length,active:orders.filter(x=>x.status==='ACTIVE').length,payments:payments.length,posts:extras.counts.posts,unreadNews:require('./social').UnreadNewsCount(p)},
  recentOrders:usable.slice(0,1),recentPayments:firstPayments.slice(0,1),latestPayment:firstPayments[0]||null};
}

const INFO_FIELDS=['name','manufacturer','product','model','os','architecture','appVersion','protocolVersion','phone','phoneStatus','serial','serialStatus','imei','imeiStatus'];
function Device(id,rooms){
 const saved=require('../../identity/identityManager').GetSavedClientByID(id),live=state.clients.get(id),key='CLIENT:'+id;
 const raw={...(state.deviceInfo.get(key)||{})};
 for(const t of rooms.filter(t=>t.clientId===id||t.currentClientId===id).sort((a,b)=>a.updatedAt-b.updatedAt))Object.assign(raw,t.device);
 const bound=require('../../license/licenseManager').GetBoundLicenseEntry(id),auth=state.deviceAuthStatus.get(key)||{};
 return {id,serverId:saved?.serverId||'',online:!!live?.connected,registered:!!saved,lastSeenAt:saved?.lastSeenAt||0,
  device:Object.fromEntries(INFO_FIELDS.map(k=>[k,String(raw[k]??'')])),
  biometric:require('../clientBiometric').PublicStatus(id),
  permissions:{granted:!!live&&require('../clientPermissions').Ready(live),online:!!live?.connected,mask:live?.permissionMask??null,reapprovalRequired:!!saved?.permissionsReapprovalRequired},
  capabilities:require('../deviceControl').Capabilities('CLIENT',id),
  authentication:{status:auth.status||'UNKNOWN',verified:!!live?.deviceAuthVerified,enrolledAt:auth.enrolledAt||0,verifiedAt:auth.verifiedAt||0},
  entryPass:bound?{status:require('../../license/licenseManager').GetLicenseStatus(bound.license),expiresAt:bound.license.expiresAt||0}:null,
  alias:state.clientAliases.get(id)||'',...(state.clientNotes.has(id)?{note:state.clientNotes.get(id)}:{}),
  flags:require('../featureFlags').EffectiveFlags('CLIENT',id),
  uiState:state.clientUiStates.get(id)?{status:state.clientUiStates.get(id).status,updatedAt:state.clientUiStates.get(id).updatedAt}:null};
}
function Read(p,body={},admin=false){
 if(admin!==true)s.Fail('ADMIN_ONLY');
 const db=s.DB(),ids=ClientIds(p),rooms=Rooms(p),linked=rows=>rows.filter(x=>x.accountId===p.id);
 const devices=()=>ids.map(id=>{const row=Device(id,rooms);if(!admin)delete row.note;return row;});
 const qr=()=>require('../qrApproval').List().filter(q=>ids.includes(q.clientId)).map(({deviceKey,lastIP,...q})=>q);
 const support=()=>rooms.map(t=>({id:t.clientId,currentClientId:t.currentClientId,status:t.status,mode:t.mode||'HUMAN',at:t.createdAt||t.updatedAt,updatedAt:t.updatedAt,messages:t.messages.length}));
 const sections={devices,qr,support,orders:()=>linked(Object.values(db.orders)).map(require('./commerce').PublicOrder),payments:()=>linked(Object.values(db.ledger)),charges:()=>linked(Object.values(db.chargeRequests)).map(require('./charges').Public),posts:()=>linked(Object.values(db.posts)).map(x=>({id:x.id,body:x.body,at:x.at,hidden:x.hidden,deleted:x.deleted,imageThumb:x.imageThumb||''})),comments:()=>linked(Object.values(db.comments)),reports:()=>linked(Object.values(db.reports)),followers:()=>require('./follows').List(p,{id:p.id,mode:'followers',offset:body.offset,limit:body.limit}),following:()=>require('./follows').List(p,{id:p.id,mode:'following',offset:body.offset,limit:body.limit})};
 if(body.section){
  if(!sections[body.section])s.Fail('INPUT_INVALID');let rows=sections[body.section]();
  if(body.section==='support'&&body.threadId){
   const room=rooms.find(t=>t.clientId===body.threadId);if(!room)s.Fail('NOT_OWNER');
   rows=room.messages.map(m=>({id:String(m.seq),title:m.role==='CLIENT'?'나':m.role==='ADMIN'?'상담원':m.role==='BOT'?'안내 봇':'상담 안내',body:m.text,at:m.at,role:m.role}));
  }
  return {profile:s.PublicProfile(p,true),section:body.section,...(body.threadId?{threadId:body.threadId}:{}),...(Array.isArray(rows)?s.Page(rows.sort((a,b)=>(b.at||b.issuedAt||0)-(a.at||a.issuedAt||0)),body,50):rows)};
 }
 const counts={};for(const [key,get]of Object.entries(sections)){const v=get();counts[key]=Array.isArray(v)?v.length:v.total;}
 return {...Home(p),profile:{...s.PublicProfile(p,true),...(admin?{blocked:!!p.blocked}:{})},devices:devices().slice(0,12),counts,qr:qr().slice(0,12),support:support().slice(0,12)};
}
module.exports={MemberIndex,ClientIds,ResolveClient,ResolveSupport,Home,Read};
