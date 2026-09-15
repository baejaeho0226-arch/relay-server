'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix58-withdrawals-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),database=require('../storage/database'),lm=require('../license/licenseManager');
let sequence=0;
function client(n,key='FIX58-WITHDRAWAL-'+n){
 const id=String(n).padStart(16,'0'),c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:Date.now()});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;return c;
}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX58-WITHDRAW-REQUEST-'+(++sequence),action,body),admin=(action,body)=>hub.AdminWrite(action,body,'ADMIN:WITHDRAW-TEST'),own=c=>s.Account(c);
const balance=c=>own(c).balance,ledger=c=>Object.values(s.DB().ledger).filter(x=>x.accountId===own(c).id&&x.kind.startsWith('WITHDRAW_'));
const request={amount:1500,bank:'테스트은행',account:'123-456-789012',holder:'출금 회원',confirmed:true};
(async()=>{try{
 const a=client(58001),b=client(58002),a2={...a,socket:{destroyed:false,write(){return true;}}};
 for(const c of [a,b])run(c,'withdraw');s.Atomic(()=>{s.Ledger(own(a),5000,'TOPUP','TEST');s.Ledger(own(b),2000,'TOPUP','TEST');});
 assert.equal(own(a2).id,own(a).id);assert.equal(run(a,'withdraw').total,0);
 let before=JSON.stringify(s.DB());
 for(const body of [{...request,amount:-1},{...request,amount:1.1},{...request,amount:10000001},{...request,confirmed:false},{...request,account:'abc'},{...request,holder:''},{...request,bank:'bank\nother'}])assert.throws(()=>run(a,'withdraw.request',body),/AMOUNT_INVALID|WITHDRAW_DETAILS_INVALID|INPUT_INVALID/);
 assert.throws(()=>run(a,'withdraw.request',{...request,amount:6000}),/WITHDRAW_BALANCE_REQUIRED/);assert.equal(JSON.stringify(s.DB()),before);
 const save=database.SaveDatabase;database.SaveDatabase=()=>false;
 try{assert.throws(()=>run(a,'withdraw.request',request,'WITHDRAW-ROLLBACK'),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 assert.equal(JSON.stringify(s.DB()),before,'failed persistence rolls back reservation and replay token');
 const first=run(a,'withdraw.request',request,'WITHDRAW-ONE'),id=first.request.id;
 assert.equal(balance(a),3500);assert.equal(first.request.status,'PENDING');assert.equal(first.request.account,undefined);assert.equal(first.request.accountMasked,'********9012');
 assert.equal(first.request.accountId,undefined);assert.equal(ledger(a).length,1);assert.equal(ledger(a)[0].amount,-1500);
 state.clients.set(a.clientId,a2);assert.equal(run(a2,'withdraw.request',request,'WITHDRAW-ONE').request.id,id,'reconnected account replay is stable');state.clients.set(a.clientId,a);assert.equal(balance(a),3500);
 assert.throws(()=>run(a,'withdraw.request',{...request,amount:1600},'WITHDRAW-ONE'),/REQUEST_REUSED/);
 state.clients.set(a.clientId,a2);const attempts=await Promise.all(Array.from({length:8},async(_,i)=>{try{return run(a2,'withdraw.request',request,'PARALLEL-WITHDRAW-'+i);}catch(e){return e.message;}}));
 state.clients.set(a.clientId,a);assert.deepEqual(attempts,Array(8).fill('WITHDRAW_PENDING'));assert.equal(ledger(a).length,1,'concurrent submissions reserve at most once');
 const forged=run(b,'withdraw',{id,accountId:own(a).id});assert.equal(forged.total,0);assert.equal(forged.pending,false);
 assert.equal(JSON.stringify(run(b,'member',{id:own(a).id})).includes('123456789012'),false,'public profile never contains payment destination');
 assert.throws(()=>run(b,'withdraw.approve',{id,paidConfirmed:true,payoutReference:'ATTACK'}),/UNKNOWN_ACTION/);
 assert.throws(()=>run(b,'withdraw.reject',{id,reason:'ATTACK'}),/UNKNOWN_ACTION/);
 before=JSON.stringify(s.DB());b.biometricVerified=false;assert.throws(()=>run(b,'withdraw.request',request),/MEMBER_AUTH_REQUIRED/);b.biometricVerified=true;assert.equal(JSON.stringify(s.DB()),before);
 const listing=hub.AdminRead({view:'withdrawals'}).items[0];assert.equal(listing.account,undefined);assert.equal(listing.accountMasked,'********9012');
 const detail=hub.AdminRead({view:'withdrawals',id}).items[0];assert.equal(detail.account,'123456789012');
 assert.throws(()=>admin('withdraw.approve',{id,payoutReference:'BANK-01',paidConfirmed:false}),/WITHDRAW_PAYMENT_CONFIRM/);
 assert.equal(balance(a),3500);
 before=JSON.stringify(s.DB());database.SaveDatabase=()=>false;try{assert.throws(()=>admin('withdraw.reject',{id,reason:'정보 불일치'}),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}assert.equal(JSON.stringify(s.DB()),before);
 const rejected=admin('withdraw.reject',{id,reason:'정보 불일치'});assert.equal(rejected.status,'REJECTED');assert.equal(balance(a),5000);assert.equal(ledger(a).length,2);
 admin('withdraw.reject',{id,reason:'중복 처리'});assert.equal(balance(a),5000);assert.equal(ledger(a).length,2,'repeated rejection cannot credit twice');
 assert.throws(()=>admin('withdraw.approve',{id,payoutReference:'BANK-01',paidConfirmed:true}),/WITHDRAW_PROCESSED/);
 const rejectedReplay=run(a,'withdraw.request',request,'WITHDRAW-ONE');assert.equal(rejectedReplay.request.status,'REJECTED');assert.equal(rejectedReplay.pending,false,'old replay projects current terminal status instead of hiding the form');
 const second=run(a,'withdraw.request',{...request,amount:1000},'WITHDRAW-TWO').request;assert.equal(balance(a),4000);
 const approved=admin('withdraw.approve',{id:second.id,payoutReference:'BANK-02',paidConfirmed:true});assert.equal(approved.status,'PAID');assert.equal(balance(a),4000,'approval never charges the reserved amount twice');
 assert.deepEqual(admin('withdraw.approve',{id:second.id,payoutReference:'BANK-02',paidConfirmed:true}),approved);
 assert.throws(()=>admin('withdraw.approve',{id:second.id,payoutReference:'OTHER-REF',paidConfirmed:true}),/CONTENT_CHANGED/);
 assert.throws(()=>admin('withdraw.reject',{id:second.id,reason:'늦은 반려'}),/WITHDRAW_PROCESSED/);assert.equal(balance(a),4000);
 const exportData=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(exportData),true);
 assert.equal(balance(a),4000);assert.equal(run(a,'withdraw').total,2);assert.equal(run(a,'withdraw').pending,false);
 const replay=run(a,'withdraw.request',{...request,amount:1000},'WITHDRAW-TWO');assert.equal(replay.request.status,'PAID');assert.equal(replay.pending,false);assert.equal(balance(a),4000,'restart and old retry cannot reserve twice');
 const snapshot=structuredClone(s.DB());delete snapshot.withdrawRequests;s.Import({memberHub:snapshot});assert.deepEqual(s.DB().withdrawRequests,{},'older database gains the optional table without schema loss');database.ImportDatabaseObject(exportData);
 // Pending reservations count toward the exact integer wallet cap. A credit
 // must not occupy the amount which rejection promises to restore later.
 const cap=client(58004);run(cap,'withdraw');s.Atomic(()=>s.Ledger(own(cap),Number.MAX_SAFE_INTEGER,'TOPUP','CAP'));
 const capRequest={...request,amount:100000};const held=run(cap,'withdraw.request',capRequest,'WITHDRAW-CAP').request;assert.equal(balance(cap),Number.MAX_SAFE_INTEGER-capRequest.amount);
 before=JSON.stringify(s.DB());assert.throws(()=>s.Atomic(()=>s.Ledger(own(cap),1,'TOPUP','OVERFLOW')),/BALANCE_INVALID/);assert.equal(JSON.stringify(s.DB()),before);
 const random=crypto.randomInt;let draws=0;crypto.randomInt=()=>{draws++;throw Error('OUTCOME_DRAW_MUST_NOT_RUN');};
 try{
  for(const [game,choice] of [['BACCARAT','PLAYER'],['ROULETTE','RED'],['SLOTS','SPIN']])assert.throws(()=>run(cap,'arcade.play',{game,choice,amount:100,rulesRevision:4}),/ARCADE_BALANCE_LIMIT/);
  for(const body of [{game:'DICE',direction:'UNDER',threshold:50},{game:'PLINKO',risk:'LOW'},{game:'LIMBO',targetMultiplier:2}])assert.throws(()=>run(cap,'casino.play',{...body,amount:100,rulesRevision:1}),/ARCADE_BALANCE_LIMIT/);
  for(const game of ['CRASH','MINES','HILO','TOWER','BLACKJACK'])assert.throws(()=>run(cap,'casino.start',{game,amount:100,rulesRevision:1,...(game==='MINES'?{mines:3}:{})}),/ARCADE_BALANCE_LIMIT/);
 }finally{crypto.randomInt=random;}
 assert.equal(draws,0,'every game rejects an unpayable wager before sampling any outcome');assert.equal(JSON.stringify(s.DB()),before,'rejected stakes never change wallet, rounds or operations');
 admin('withdraw.reject',{id:held.id,reason:'한도 복원'});assert.equal(balance(cap),Number.MAX_SAFE_INTEGER,'a rejection can always restore its reserved amount');
 // An already open blackjack round also rechecks the reserved headroom
 // before hit/stand/double, rather than rejecting only drawn winning outcomes.
 const live=client(58005);run(live,'withdraw');s.Atomic(()=>s.Ledger(own(live),5000,'TOPUP','LIVE'));
 crypto.randomInt=()=>0;let blackjack;try{blackjack=run(live,'casino.start',{game:'BLACKJACK',amount:100,rulesRevision:1});}finally{crypto.randomInt=random;}
 assert.ok(blackjack.active);run(live,'withdraw.request',{...request,amount:2000},'WITHDRAW-LIVE');
 s.Atomic(()=>s.Ledger(own(live),Number.MAX_SAFE_INTEGER-s.ReservedBalance(own(live))-balance(live),'TOPUP','LIVE-CAP'));
 const liveView=run(live,'casino',{game:'BLACKJACK'});assert.equal(liveView.active.canHit,false);assert.equal(liveView.active.canStand,false);assert.equal(liveView.active.canDouble,false);
 before=JSON.stringify(s.DB());draws=0;crypto.randomInt=()=>{draws++;throw Error('OUTCOME_DRAW_MUST_NOT_RUN');};
 try{for(const action of ['HIT','STAND','DOUBLE'])assert.throws(()=>run(live,'casino.action',{game:'BLACKJACK',roundId:blackjack.active.id,action}),/ARCADE_BALANCE_LIMIT/);}finally{crypto.randomInt=random;}
 assert.equal(draws,0);assert.equal(JSON.stringify(s.DB()),before,'live decisions preserve the stake and deck without drawing');
 // Existing HTTP boundary rejects a non-admin before private account access.
 const route=require('../web/routes/memberRoutes');const res={writeHead(status){this.status=status;},end(value){this.body=value;},setHeader(){}};
 await route.Handle({method:'GET',pathname:'/api/member',url:new URL('http://localhost/api/member?view=withdrawals&id='+id),body:{},res,session:{role:'VIEWER'}});
 assert.equal(res.status,403);assert.equal(String(res.body).includes('123456789012'),false);
 // The dedicated Web action must first load full destination only for its review
 // dialog, and cannot submit an approval if the operator cancels the dialog.
 const calls=[],context={memberMoney:n=>n+'원',toast(){},renderMember:async()=>{},URLSearchParams,
  api:async(url,args)=>{calls.push({url,args});return args?{}:{items:[{...detail,status:'PENDING'}]};},openModal:async()=>null};vm.createContext(context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/admin-member-withdrawals.js'),'utf8'),context);
 await context.processMemberWithdrawal('withdraw.approve',{id});assert.equal(calls.length,1);
 context.openModal=async opts=>{assert.match(opts.message,/은행 송금이 실행되지 않습니다/);assert.match(opts.message,/123456789012/);return {payoutReference:'CONFIRMED'};};
 await context.processMemberWithdrawal('withdraw.approve',{id});assert.equal(calls.at(-1).args.body.paidConfirmed,true);assert.equal(calls.at(-1).args.body.payoutReference,'CONFIRMED');
 console.log('FIX58 withdrawal reservation, replay, authorization, privacy, admin review and persistence checks passed');
}finally{fs.rmSync(temp,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
