'use strict';
const crypto = require('node:crypto');
const state = require('../../core/state');
const EXTRA_TABLES = ['coins','quotes','viewCounters','viewHits'];
const TABLES = ['profiles','products','news','orders','topups','ledger','posts','comments','reactions','reports','operations'];
function Empty() {
 const db={schema:2,revision:0,settings:{topupInstructions:'등록된 코인과 네트워크를 선택하고 입금 안내를 확인해주세요.',topupEnabled:false}};
 for(const name of [...TABLES,...EXTRA_TABLES])db[name]={};
 return db;
}
function DB(){return state.memberHub || (state.memberHub=Empty());}
function Import(data){
 const raw=data && data.memberHub;if(!raw)return void(state.memberHub=Empty());
 if(![1,2].includes(raw.schema) || TABLES.some(name=>!raw[name]||typeof raw[name]!=='object'||Array.isArray(raw[name])))throw Error('MEMBER_STORAGE_INVALID');
 const next=structuredClone(raw);
 for(const name of EXTRA_TABLES){if(raw.schema===1&&next[name]===undefined)next[name]={};if(!next[name]||typeof next[name]!=='object'||Array.isArray(next[name]))throw Error('MEMBER_STORAGE_INVALID');}
 next.schema=2;state.memberHub=next;
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
function PublicProfile(p,own=false){return {id:p.id,nickname:p.nickname,bio:p.bio,avatar:p.avatar,avatarRevision:p.avatarRevision,views:ViewCount('profile',p.id),...(own?{balance:p.balance,createdAt:p.createdAt}: {})};}
function ViewCount(kind,id){return DB().viewCounters?.[kind+':'+id]?.count||0;}
function ProfileById(id){return Object.values(DB().profiles).find(p=>p.id===id);}
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
module.exports={DB,Empty,Import,Fail,Text,Money,Id,Account,ProfileById,PublicProfile,ViewCount,Page,Atomic,Operation,Ledger};
