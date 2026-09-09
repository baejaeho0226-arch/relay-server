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
function Home(p){
 const db=s.DB(),orders=Object.values(db.orders).filter(x=>x.accountId===p.id).map(require('./commerce').PublicOrder),ledger=Object.values(db.ledger).filter(x=>x.accountId===p.id);
 return {settings:{},profile:s.PublicProfile(p,true),summary:{ready:orders.filter(x=>x.status==='PAID').length,active:orders.filter(x=>x.status==='ACTIVE').length,payments:ledger.length,posts:s.PublicProfile(p).posts,unreadNews:require('./social').News(p,{limit:12}).items.filter(x=>x.unread).length},latestPayment:ledger.sort((a,b)=>b.at-a.at)[0]||null};
}
function Read(p,body={},admin=false){
 const db=s.DB(),ids=ClientIds(p),rooms=[...state.supportThreads.values()].filter(t=>t.deviceKey===p.subject||ids.includes(t.clientId)||ids.includes(t.currentClientId));
 const linked=rows=>rows.filter(x=>x.accountId===p.id);
 const sections={orders:()=>linked(Object.values(db.orders)).map(require('./commerce').PublicOrder),payments:()=>linked(Object.values(db.ledger)),charges:()=>linked(Object.values(db.chargeRequests)).map(require('./charges').Public),posts:()=>linked(Object.values(db.posts)).map(x=>({id:x.id,body:x.body,at:x.at,hidden:x.hidden,deleted:x.deleted,imageThumb:x.imageThumb||''})),comments:()=>linked(Object.values(db.comments)),reports:()=>linked(Object.values(db.reports)),followers:()=>require('./follows').List(p,{id:p.id,mode:'followers',offset:body.offset,limit:body.limit}),following:()=>require('./follows').List(p,{id:p.id,mode:'following',offset:body.offset,limit:body.limit})};
 if(body.section){if(!sections[body.section])s.Fail('INPUT_INVALID');const rows=sections[body.section]();return {profile:s.PublicProfile(p,true),section:body.section,...(Array.isArray(rows)?s.Page(rows.sort((a,b)=>(b.at||0)-(a.at||0)),body,50):rows)};}
 const infoFields=['name','manufacturer','product','model','os','architecture','appVersion','protocolVersion','phone','phoneStatus','serial','serialStatus','imei','imeiStatus'];
 const devices=ids.map(id=>{
  const saved=require('../../identity/identityManager').GetSavedClientByID(id),live=state.clients.get(id),raw={...(state.deviceInfo.get('CLIENT:'+id)||{})};
  for(const t of rooms.filter(t=>t.clientId===id||t.currentClientId===id))Object.assign(raw,t.device);
  const bound=require('../../license/licenseManager').GetBoundLicenseEntry(id);
  return {id,serverId:saved?.serverId||'',online:!!live?.connected,registered:!!saved,lastSeenAt:saved?.lastSeenAt||0,device:Object.fromEntries(infoFields.map(k=>[k,raw[k]??''])),biometric:require('../clientBiometric').PublicStatus(id),permissions:{granted:live?require('../clientPermissions').Ready(live):false,online:!!live?.connected},capabilities:require('../deviceControl').Capabilities('CLIENT',id),authentication:{status:state.deviceAuthStatus.get('CLIENT:'+id)?.status||'UNKNOWN',verified:!!live?.deviceAuthVerified},entryPass:bound?{status:require('../../license/licenseManager').GetLicenseStatus(bound.license),expiresAt:bound.license.expiresAt||0}:null};
 });
 const counts={};for(const [key,get]of Object.entries(sections)){const v=get();counts[key]=Array.isArray(v)?v.length:v.total;}
 return {...Home(p),profile:{...s.PublicProfile(p,true),...(admin?{blocked:!!p.blocked}:{})},devices,counts,qr:require('../qrApproval').List().filter(q=>ids.includes(q.clientId)),support:rooms.map(t=>({id:t.clientId,currentClientId:t.currentClientId,status:t.status,mode:t.mode||'HUMAN',updatedAt:t.updatedAt,messages:t.messages.length,device:t.device}))};
}
module.exports={MemberIndex,ClientIds,ResolveClient,Home,Read};
