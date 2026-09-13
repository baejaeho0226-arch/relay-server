'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix49-notifications-'));
process.env.DATA_DIR=temporary;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const state=require('../core/state'),store=require('../services/member/store'),preferences=require('../services/member/preferences');
const database=require('../storage/database'),notices=require('../relay/notifications');
const keys=['notifyFollowers','notifyFollowing','notifyComments','notifyPosts'];
function client(id,device){const received=[];const c={clientId:id,installationDeviceKey:device,connected:true,socket:{destroyed:false,write(line){received.push(line);}}};state.clients.set(id,c);return {c,received};}
try{
 const a=client('A000000000000001','FIX49-DEVICE-A'),b=client('B000000000000002','FIX49-DEVICE-B'),same=client('A000000000000003','FIX49-DEVICE-A');
 const owner=store.Account(a.c),other=store.Account(b.c);
 assert.equal(store.Account(same.c).id,owner.id);
 for(const key of keys)assert.equal(preferences.Read(owner)[key],false,'social notices default off');
 for(const category of ['FOLLOW','FOLLOWER','SOCIAL_FOLLOW','FOLLOWING','SOCIAL_FOLLOWING','COMMENT','REPLY','SOCIAL_COMMENT','POST','SOCIAL_POST']){
  assert.equal(preferences.NoticeAllowed(owner,category),false);assert.equal(notices.NoticeClient(a.c.clientId,'muted social notice',category),false);
 }
 assert.equal(a.received.length,0);
 for(const category of ['INFO','WARNING','CRITICAL','AUTH','UPDATE'])assert.equal(preferences.NoticeAllowed(owner,category),true,'system notices remain independent');
 assert.equal(notices.NoticeClient(a.c.clientId,'operator notice','INFO'),true);assert.equal(a.received.length,1);
 store.Atomic(()=>preferences.Save(store.ProfileById(owner.id),{notifyFollowers:true,notifyComments:true,language:'en'}));
 assert.equal(notices.NoticeAll('follower notice','FOLLOWER'),2,'all devices of the subscribed member receive notices');
 assert.equal(a.received.length,2);assert.equal(same.received.length,1);assert.equal(b.received.length,0);
 assert.equal(notices.NoticeAll('following notice','FOLLOWING'),0,'the two follow settings are independent');
 assert.equal(notices.NoticeAll('reply notice','REPLY'),2);assert.equal(notices.NoticeAll('post notice','POST'),0);
 assert.equal(preferences.Read(other).notifyComments,false,'another account is untouched');
 const before=JSON.stringify(preferences.Read(store.ProfileById(owner.id)));
 assert.throws(()=>store.Atomic(()=>preferences.Save(store.ProfileById(owner.id),{notifyFollowers:false,notifyComments:'true'})),/INPUT_INVALID/);
 assert.equal(JSON.stringify(preferences.Read(store.ProfileById(owner.id))),before);
 const save=database.SaveDatabase;
 try{database.SaveDatabase=()=>false;assert.throws(()=>store.Atomic(()=>preferences.Save(store.ProfileById(owner.id),{notifyFollowers:false})),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 assert.equal(preferences.Read(store.ProfileById(owner.id)).notifyFollowers,true,'failed writes do not silence already accepted settings');
 store.Import({memberHub:JSON.parse(JSON.stringify(store.DB()))});
 assert.equal(preferences.Read(store.Account(same.c)).language,'en');assert.equal(preferences.Read(store.Account(same.c)).notifyComments,true);
 store.Atomic(()=>preferences.Save(store.ProfileById(owner.id),Object.fromEntries(keys.map(key=>[key,false]))));
 for(const key of keys)assert.equal(preferences.Read(store.Account(same.c))[key],false);
 assert.equal(notices.NoticeAll('muted again','COMMENT'),0);
 assert.equal(preferences.Read(store.ProfileById(owner.id)).notifyApproval,true);assert.equal(preferences.Read(store.ProfileById(owner.id)).notifyRelease,true);
 // Native startup must load the local acknowledged locale before building UI.
 const apk=path.resolve(__dirname,'../../MoaPlayApp_Android64');
 const construction=fs.readFileSync(path.join(apk,'MoaPlayApp.Lifecycle.Construction.inc'),'utf8');
 assert.ok(construction.indexOf('InitializeMemberOptions;')<construction.indexOf('BuildWebStyleUI;'));
 assert.match(construction,/PromptTitle := MemberCaption\(/);assert.match(construction,/PromptCancelButtonText := MemberCaption\(/);
 console.log('FIX49 PASS: social notice preferences, shared-account delivery, generic/auth independence, rollback, persistence and startup locale ordering.');
}finally{state.clients.clear();fs.rmSync(temporary,{recursive:true,force:true});}
