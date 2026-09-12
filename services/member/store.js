'use strict';
const crypto = require('node:crypto');
const state = require('../../core/state');
const EXTRA_TABLES = ['coins','quotes','viewCounters','viewHits','chargeRequests','follows','commentReactions','bookmarks','blocks','reposts','pollVotes','pointLedger','eventSpins'];
const TABLES = ['profiles','products','news','orders','topups','ledger','posts','comments','reactions','reports','operations'];
function Empty() {
 const db={schema:4,revision:0,settings:{topupInstructions:'충전 방식은 준비 중입니다.',topupEnabled:false}};
 for(const name of [...TABLES,...EXTRA_TABLES])db[name]={};
 return db;
}
function DB(){return state.memberHub || (state.memberHub=Empty());}
function Import(data){
 const raw=data && data.memberHub;if(!raw)return void(state.memberHub=Empty());
 if(![1,2,3,4].includes(raw.schema) || TABLES.some(name=>!raw[name]||typeof raw[name]!=='object'||Array.isArray(raw[name])))throw Error('MEMBER_STORAGE_INVALID');
 const next=structuredClone(raw);
 for(const name of EXTRA_TABLES){if((['commentReactions','bookmarks','blocks','reposts','pollVotes','pointLedger','eventSpins'].includes(name)||raw.schema===1||name==='chargeRequests'&&raw.schema<3||name==='follows'&&raw.schema<4)&&next[name]===undefined)next[name]={};if(!next[name]||typeof next[name]!=='object'||Array.isArray(next[name]))throw Error('MEMBER_STORAGE_INVALID');}
 next.schema=4;state.memberHub=next;
}
function Fail(reason){const e=Error(reason);e.memberError=true;throw e;}
function Text(value,max,required=false){const v=String(value??'').trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');if(v.length>max || required&&!v)Fail('INPUT_INVALID');return v;}
function Money(value,min=1,max=10000000){if(!Number.isSafeInteger(value)||value<min||value>max)Fail('AMOUNT_INVALID');return value;}
function Id(prefix){return prefix+'-'+crypto.randomBytes(12).toString('hex').toUpperCase();}
function Subject(c){const key=c.installationDeviceKey||require('../../identity/identityManager').FindClientDeviceKey(c.clientId);if(!key)Fail('ACCOUNT_REQUIRED');return require('../clientInstallation').RegistryKey(key)||crypto.createHash('sha256').update('MEMBER:'+key).digest('hex').toUpperCase();}
function Account(c){
 const subject=Subject(c);let p=DB().profiles[subject];
 if(!p)return Atomic(()=>{p={id:Id('USR'),subject,nickname:'회원 '+crypto.randomBytes(2).toString('hex').toUpperCase(),bio:'',avatar:'',avatarRevision:0,balance:0,createdAt:Date.now(),readNewsAt:0,blocked:false};DB().profiles[subject]=p;return p;});
 return p;
}
function DefaultHandle(p){return 'user_'+p.id.replace(/^USR-/, '').slice(0,12).toLowerCase();}
function Handle(p){return p.handle||DefaultHandle(p);}
function NormalizeHandle(value){const v=String(value||'').trim().replace(/^@/,'').toLowerCase();if(!/^[a-z0-9_][a-z0-9_.]{2,23}$/.test(v))Fail('HANDLE_INVALID');return v;}
function Resolve(value){if(typeof value!=='string')return;return ProfileById(value)||Object.values(DB().profiles).find(p=>[Handle(p),DefaultHandle(p)].includes(value.trim().replace(/^@/,'').toLowerCase()));}
function PublicAvatar(p){if(!p.avatar)return '';if(p.avatarThumb&&p.avatarThumb.length<=16100)return p.avatarThumb;try{return p.avatarThumb=require('./social').AvatarThumb(p.avatar);}catch(_){return '';}}
function PublicProfile(p,own=false){return {id:p.id,handle:Handle(p),nickname:p.nickname,bio:p.bio,pronouns:p.pronouns||'',avatar:own?p.avatar:PublicAvatar(p),avatarRevision:p.avatarRevision,profileRevision:p.profileRevision||p.avatarRevision||0,posts:Object.values(DB().posts).filter(x=>x.accountId===p.id&&!x.deleted&&!x.hidden).length,...require('./follows').Counts(p.id),...(own?{balance:p.balance,points:p.points||0,eventSpins:p.eventSpins||0,createdAt:p.createdAt,handleEditable:!p.handleChangedAt,nicknameChangeAt:p.nicknameChangedAt?p.nicknameChangedAt+30*86400000:0,gender:p.gender||'UNDISCLOSED',preferences:require('./preferences').Read(p)}: {})};}
function ViewCount(kind,id){return DB().viewCounters?.[kind+':'+id]?.count||0;}
let profileTable,profileRevision=-1,profileIndex=new Map();
function ProfileById(id){
 const db=DB();
 if(profileTable!==db.profiles||profileRevision!==db.revision){
  profileTable=db.profiles;profileRevision=db.revision;profileIndex=new Map(Object.values(profileTable).map(p=>[p.id,p]));
 }
 let p=profileIndex.get(id);
 // New profiles may be projected inside an atomic write, before revision increments.
 if(!p){p=Object.values(profileTable).find(x=>x.id===id);if(p)profileIndex.set(id,p);}
 return p;
}
function Page(rows,body={},max=12){const offset=Math.max(0,Math.min(100000,Number(body.offset)||0));const limit=Math.max(1,Math.min(max,Number(body.limit)||max));return {items:rows.slice(offset,offset+limit),total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null};}
function Atomic(fn,extras=[]){
 const previous=structuredClone(DB());const saved=extras.map(name=>[name,structuredClone(state[name])]);
 try{const result=fn();DB().revision++;if(!require('../../storage/database').SaveDatabase())Fail('STORAGE_SAVE_FAILED');return result;}
 catch(e){state.memberHub=previous;for(const [name,value]of saved){if(state[name]instanceof Map){state[name].clear();for(const [k,v]of value)state[name].set(k,v);}else state[name]=value;}throw e;}
}
function Operation(account,requestId,action,body,fn,extras=[]){
 if(!/^[A-Za-z0-9_-]{8,80}$/.test(requestId))Fail('REQUEST_ID_INVALID');
 const key=account.id+':'+requestId;const fingerprint=crypto.createHash('sha256').update(JSON.stringify({action,body})).digest('hex');
 const old=DB().operations[key];if(old){if(old.fingerprint!==fingerprint)Fail('REQUEST_REUSED');return structuredClone(old.result);}
 return Atomic(()=>{const result=fn();DB().operations[key]={fingerprint,result,at:Date.now()};return result;},extras);
}
function Ledger(p,amount,kind,reference){
 const next=p.balance+amount;if(!Number.isSafeInteger(next)||next<0||next>100000000)Fail('BALANCE_INVALID');
 p.balance=next;const id=Id('PAY');const row={id,accountId:p.id,amount,balance:next,kind,reference,at:Date.now()};DB().ledger[id]=row;return row;
}
module.exports={Handle,NormalizeHandle,Resolve,Subject,DB,Empty,Import,Fail,Text,Money,Id,Account,ProfileById,PublicProfile,ViewCount,Page,Atomic,Operation,Ledger};
