'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-arcade-flow-'));
process.env.DATA_DIR=dir;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),protocol=require('../services/member/protocol'),wire=require('../services/member/wire');
const oldNow=Date.now,oldRandom=crypto.randomInt;let clock=Date.now(),sequence=0;
Date.now=()=>clock;
function client(id,key){
 const lines=[],c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(line){lines.push(line.trim());return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:clock});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:clock});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 return {c,lines};
}
function request(peer,action,body={},id='ARCADE-FLOW-'+String(++sequence).padStart(8,'0')){
 const payload=Buffer.from(JSON.stringify(body)).toString('base64'),fields=[id,action,payload];
 peer.lines.length=0;assert.equal(hub.Handle(peer.c,['HUB',...fields,protocol.Sign(peer.c,'HUB',fields)].join('|')),true);
 const chunks=peer.lines.filter(line=>/^HUB_(?:Z)?CHUNK\|/.test(line)).map(line=>line.split('|')).sort((a,b)=>Number(a[3])-Number(b[3]));
 assert.ok(chunks.length,'signed request receives its response synchronously');
 for(const chunk of chunks)assert.equal(chunk[6],protocol.Sign(peer.c,chunk[0]==='HUB_ZCHUNK'?'HUB_ZRESPONSE':'HUB_RESPONSE',chunk.slice(1,6)));
 return JSON.parse(wire.Decode(chunks.map(chunk=>chunk[5]).join(''),chunks[0][0]==='HUB_ZCHUNK'));
}
function ok(peer,action,body={},id){const result=request(peer,action,body,id);assert.equal(result.ok,true,JSON.stringify(result));return result.data;}
try{
 const a=client('1111111111111111','ARCADE-FLOW-A'),a2=client('2222222222222222','ARCADE-FLOW-A2'),b=client('3333333333333333','ARCADE-FLOW-B');
 a2.c.installationDeviceKey=a.c.installationDeviceKey;
 const owner=s.Account(a.c).id,other=s.Account(b.c).id;
 s.Atomic(()=>Object.assign(s.ProfileById(owner),{balance:8910,points:432,eventSpins:9}));
 const badgeRewards=()=>Object.values(s.DB().pointLedger).filter(row=>row.accountId===owner&&row.kind==='BADGE_REWARD');
 const untouched=()=>({points:s.ProfileById(owner).points-badgeRewards().reduce((sum,row)=>sum+row.amount,0),pointLedger:Object.fromEntries(Object.entries(s.DB().pointLedger).filter(([,row])=>row.kind!=='BADGE_REWARD')),eventSpins:s.ProfileById(owner).eventSpins,...Object.fromEntries(['eventSpins','orders','shopPurchases','pointConversions','chargeRequests'].map(key=>[key,structuredClone(s.DB()[key])]))});
 const initial=untouched(),empty=ok(a,'arcade',{game:'SLOTS'});assert.equal(empty.stats.played,0);assert.equal(empty.mode,'VIRTUAL_BALANCE');assert.equal(empty.rules.redeemable,false);
 assert.equal(empty.wallet.balance,8910);assert.equal(empty.wallet.accountId,owner);assert.equal(empty.profile,undefined,'round read does not resend full profile media');
 crypto.randomInt=max=>max-1;
 a2.lines.length=0;b.lines.length=0;
 const body={game:'SLOTS',choice:'SPIN',amount:100,rulesRevision:4,_wire:'zlib',_delta:true},result=ok(a,'arcade.play',body,'ARCADE-SLOT-REPLAY-01');
 assert.equal(result.result.symbol,'SEVEN');assert.deepEqual(result.result.reels.map(reel=>reel.id),['SEVEN','SEVEN','SEVEN']);assert.equal(result.stats.played,1);assert.equal(result.stats.matched,1);assert.deepEqual(result.lastResult,result.result);
 assert.equal(result.result.betAmount,100);assert.equal(result.result.payout,6000);assert.equal(result.result.net,5900);assert.equal(result.wallet.balance,14810);assert.equal(result.result.balance,14810);assert.equal(result.wallet.revision,s.DB().revision);
 for(const peer of [a2,b]){
  const event=peer.lines.find(line=>line.startsWith('HUB_EVENT|'));assert.ok(event,'other device receives committed update');
  const fields=event.split('|');assert.equal(fields.length,3);assert.equal(fields[2],protocol.Sign(peer.c,'HUB_EVENT',[fields[1]]));
 }
 assert.deepEqual(ok(a2,'arcade.play',body,'ARCADE-SLOT-REPLAY-01'),result,'immediate retry on another device never settles twice');
 assert.deepEqual(ok(a2,'arcade',{game:'SLOTS'}).stats,result.stats,'second device sees current stats');
 const otherRead=ok(b,'arcade',{game:'SLOTS',id:owner});assert.equal(otherRead.stats.played,0);assert.equal(otherRead.wallet.accountId,other);assert.equal(otherRead.wallet.balance,0,'client supplied member id cannot expose another wallet');
 assert.equal(request(a2,'arcade.play',body).reason,'ARCADE_WAIT','rate limit is shared by both devices');
 clock+=300;
 for(const extra of [{balance:100},{points:100},{chips:10},{payout:100},{accountId:other}])assert.equal(request(a,'arcade.play',{...body,...extra}).reason,'INPUT_INVALID');
 assert.equal(request(a,'arcade.play',{...body,amount:0}).reason,'AMOUNT_INVALID');
 assert.equal(request(a,'arcade.play',{game:'SLOTS',choice:'SPIN'}).reason,'ARCADE_RULES_CHANGED','old clients cannot settle invisible or unconfirmed bets');
 const after=ok(a2,'arcade.play',{game:'ROULETTE',choice:'RED',amount:100,rulesRevision:4});assert.equal(after.result.number,36);assert.equal(after.stats.played,1);assert.equal(after.wallet.balance,14910);
 assert.equal(ok(a,'arcade',{game:'SLOTS'}).stats.played,1);assert.deepEqual(untouched(),initial);
 assert.deepEqual(badgeRewards().map(row=>[row.reference,row.amount]).sort(),[['ROULETTE_1',50],['SLOTS_1',50]]);const paidTitles=structuredClone(badgeRewards());assert.equal(after.wallet.points,532);
 // Existing wallet adjustments and later game rounds stay authoritative even
 // when a previous successful request is retried after its reply was lost.
 s.Atomic(()=>s.Ledger(s.ProfileById(owner),2000,'TEST_ADJUSTMENT','REPLAY-ADJUSTMENT'));
 const adjusted=ok(a,'arcade.play',body,'ARCADE-SLOT-REPLAY-01');assert.deepEqual(adjusted.result,result.result);assert.equal(adjusted.wallet.balance,16910);assert.equal(adjusted.wallet.revision,s.DB().revision);
 clock+=300;const second=ok(a2,'arcade.play',body,'ARCADE-SLOT-REPLAY-02');assert.equal(second.stats.played,2);assert.equal(second.wallet.balance,22810);
 const ledgerCount=Object.keys(s.DB().ledger).length,snapshot=JSON.parse(JSON.stringify(s.DB()));s.Import({memberHub:snapshot});
 const restarted=ok(a,'arcade.play',body,'ARCADE-SLOT-REPLAY-01');assert.deepEqual(restarted.result,result.result);assert.equal(restarted.wallet.balance,22810);assert.equal(restarted.stats.played,2);assert.deepEqual(restarted.lastResult,second.result);assert.equal(Object.keys(s.DB().ledger).length,ledgerCount);
 assert.equal(ok(a,'me').profile.balance,22810,'account sees the same wallet');
 assert.equal(ok(a,'rewards').profile.balance,22810,'points view sees the same wallet');
 assert.equal(request(b,'arcade.play',body).reason,'ARCADE_BALANCE_REQUIRED','other member cannot spend owner virtual credits');
 a.c.biometricVerified=false;assert.equal(request(a,'arcade.play',body).reason,'MEMBER_AUTH_REQUIRED');a.c.biometricVerified=true;
 s.ProfileById(owner).blocked=true;assert.equal(request(a,'arcade.play',body).reason,'ACCOUNT_BLOCKED');s.ProfileById(owner).blocked=false;
 assert.deepEqual(untouched(),initial);
 // Revision 4 number wagers use available virtual balance across devices.
 s.Atomic(()=>s.Ledger(s.ProfileById(owner),4000000,'TEST_ADJUSTMENT','FIX50-NUMBER-FUND'));
 clock+=300;crypto.randomInt=max=>{assert.equal(max,37);return 36;};
 const numberBody={game:'ROULETTE',choice:'NUMBER_36',amount:4000000,rulesRevision:4,_wire:'zlib',_delta:true};
 const numberRound=ok(a,'arcade.play',numberBody,'FIX50-NUMBER-REPLAY');assert.equal(numberRound.result.payout,144000000);assert.equal(numberRound.wallet.balance,144022810);
 crypto.randomInt=()=>assert.fail('same-account replay cannot sample another outcome');
 assert.deepEqual(ok(a2,'arcade.play',numberBody,'FIX50-NUMBER-REPLAY'),numberRound);
 s.Atomic(()=>s.Ledger(s.ProfileById(owner),1000,'TEST_ADJUSTMENT','FIX50-POST-NUMBER'));
 const persisted=JSON.parse(fs.readFileSync(require('../config/config').DB_FILE,'utf8'));s.Import(persisted);
 const numberRetry=ok(a2,'arcade.play',numberBody,'FIX50-NUMBER-REPLAY');assert.deepEqual(numberRetry.result,numberRound.result);assert.equal(numberRetry.wallet.balance,144023810);assert.equal(numberRetry.wallet.revision,s.DB().revision);
 assert.equal(ok(a,'me').profile.balance,144023810);assert.equal(ok(a,'rewards').profile.balance,144023810);
 assert.equal(Object.values(s.DB().ledger).filter(row=>row.reference===numberRound.result.id).length,2,'number round has exactly one debit and one payout after restart and retry');
 assert.deepEqual(untouched(),initial);assert.deepEqual(badgeRewards(),paidTitles,'later plays and persisted replays never pay the first-play titles twice');
 console.log('FIX48/FIX50 ARCADE FLOW PASS: signed immediate virtual settlement, same-account multi-device replay/rate guard, notifications, private wallet, forged inputs, authentication, wallet consistency and restart-safe fresh balance with immutable prior result.');
}finally{Date.now=oldNow;crypto.randomInt=oldRandom;fs.rmSync(dir,{recursive:true,force:true});}
