'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix50-arcade-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const s=require('../services/member/store'),arcade=require('../services/member/arcade'),database=require('../storage/database');
const oldNow=Date.now,oldRandom=crypto.randomInt;let clock=1900000000000,sequence=0,accounts=0;
Date.now=()=>clock;
function member(balance,stats){
 const subject='FIX50-ARCADE-'+(++accounts),id='USR-'+subject;
 s.Atomic(()=>{s.DB().profiles[subject]={id,subject,nickname:'테스트',avatar:'',createdAt:clock,balance,points:432,eventSpins:9,...(stats?{arcade:{ROULETTE:stats}}:{})};});
 return ()=>s.ProfileById(id);
}
function request(extra={}){return {game:'ROULETTE',choice:'NUMBER_0',amount:100,rulesRevision:4,...extra};}
function play(p,body,id='FIX50-ROUND-'+String(++sequence).padStart(8,'0')){return s.Operation(p(),id,'arcade.play',body,()=>arcade.Play(p(),body));}
function unchanged(fn,reason){const before=JSON.stringify(s.DB());assert.throws(fn,reason);assert.equal(JSON.stringify(s.DB()),before,'rejection changes neither wallet, ledger, stats nor replay receipt');}
function nextNumber(number){clock+=300;let calls=0;crypto.randomInt=max=>{calls++;assert.equal(max,37);return number;};return ()=>assert.equal(calls,1,'exactly one server outcome per accepted roulette round');}
try{
 const p=member(500000),rules=arcade.Read(p()).rules;
 assert.equal(rules.revision,5);assert.equal(rules.currency,'BALANCE');assert.equal(rules.virtual,true);assert.equal(rules.redeemable,false);
 assert.equal(rules.maxBet,null);assert.equal(rules.maxBetMode,'AVAILABLE_BALANCE');assert.equal(rules.maxBalance,Number.MAX_SAFE_INTEGER);assert.equal(rules.minBet,100);assert.equal(rules.step,100);
 assert.equal(rules.paytable.ROULETTE.NUMBER,36);assert.equal(rules.payoutIncludesStake,true);
 assert.deepEqual(rules.choices.ROULETTE.slice(0,40),['RED','GREEN','BLACK',...Array.from({length:37},(_,n)=>'NUMBER_'+n)]);
 // Every exact number, including green zero and both table endpoints, wins at
 // its own number and loses on the adjacent number. Color does not qualify.
 for(let selected=0;selected<=36;selected++)for(const winning of [true,false]){
  const number=winning?selected:(selected+1)%37,verify=nextNumber(number),before=p().balance;
  const out=play(p,request({choice:'NUMBER_'+selected}));verify();
  assert.equal(out.result.choice,'NUMBER_'+selected);assert.equal(out.result.number,number);assert.equal(out.result.matched,winning);
  assert.equal(out.result.payout,winning?3600:0);assert.equal(out.result.net,winning?3500:-100);assert.equal(out.result.status,winning?'WIN':'LOSS');
  assert.equal(out.wallet.balance,before-100+out.result.payout);assert.equal(out.wallet.points,432);assert.equal(out.wallet.eventSpins,9);
  const debit=s.DB().ledger[out.result.betId],credit=s.DB().ledger[out.result.payoutId];
  assert.equal(debit.amount,-100);assert.equal(credit.amount,out.result.payout);assert.equal(debit.reference,out.result.id);assert.equal(credit.reference,out.result.id);
 }
 assert.equal(arcade.Read(p(),{game:'ROULETTE'}).stats.played,74);
 crypto.randomInt=()=>assert.fail('invalid inputs cannot draw');
 for(const choice of ['NUMBER_-1','NUMBER_37','NUMBER_00','NUMBER_01','NUMBER_1.0','NUMBER_1e0','number_1','NUMBER_+1','NUMBER_1 ','NUMBER_',1,null])unchanged(()=>play(p,request({choice})),/INPUT_INVALID/);
 for(const amount of [100001,100.5,'200000',Number.MAX_SAFE_INTEGER+1,Infinity])unchanged(()=>play(p,request({amount})),/AMOUNT_INVALID/);
 for(const extra of [{number:0},{outcome:{number:0}},{winner:'NUMBER_0'},{payout:3600},{accountId:p().id},{balance:99999999},{points:999}])unchanged(()=>play(p,request(extra)),/INPUT_INVALID/);
 unchanged(()=>play(p,request({rulesRevision:3})),/ARCADE_RULES_CHANGED/);
 // A complete available stack above 100k is valid; number payouts may exceed
 // the former 100M account limit and remain usable by the shared ledger.
 const large=member(4000000),verifyLarge=nextNumber(36),largeBody=request({choice:'NUMBER_36',amount:4000000});
 const won=play(large,largeBody,'FIX50-LARGE-REPLAY');verifyLarge();
 assert.equal(won.result.payout,144000000);assert.equal(won.wallet.balance,144000000);
 crypto.randomInt=()=>assert.fail('durable replay cannot draw');assert.deepEqual(play(large,largeBody,'FIX50-LARGE-REPLAY'),won);
 unchanged(()=>play(large,{...largeBody,choice:'NUMBER_35'},'FIX50-LARGE-REPLAY'),/REQUEST_REUSED/);
 s.Atomic(()=>s.Ledger(large(),-100,'TEST_PURCHASE','FIX50-LARGE-DEBIT'));assert.equal(large().balance,143999900);
 s.Atomic(()=>s.Ledger(large(),100,'TEST_REFUND','FIX50-LARGE-CREDIT'));assert.equal(large().balance,144000000);
 const loser=member(200100),verifyLoss=nextNumber(2),lost=play(loser,request({choice:'NUMBER_1',amount:200100}));verifyLoss();assert.equal(lost.wallet.balance,0);
 clock+=300;crypto.randomInt=()=>assert.fail('insufficient balance cannot draw');unchanged(()=>play(loser,request()),/ARCADE_BALANCE_REQUIRED/);
 const remainder=member(200195),verifyRemainder=nextNumber(2);assert.equal(play(remainder,request({choice:'NUMBER_1',amount:200100})).wallet.balance,95);verifyRemainder();
 const empty=member(199);unchanged(()=>play(empty,request({amount:200})),/ARCADE_BALANCE_REQUIRED/);
 // Integer-range guards reserve every possible payout before any RNG call.
 const max=Number.MAX_SAFE_INTEGER;
 const tooLarge=member(max);unchanged(()=>play(tooLarge,request({amount:100})),/ARCADE_BALANCE_LIMIT/);
 const amount=Math.floor(max/36/100)*100,edge=member(amount),verifyEdge=nextNumber(0),edgeResult=play(edge,request({amount}));verifyEdge();
 assert.equal(edgeResult.result.payout,Number(BigInt(amount)*36n));assert.ok(Number.isSafeInteger(edgeResult.wallet.balance));
 const overflow=member(amount+100);crypto.randomInt=()=>assert.fail('numeric overflow cannot draw');unchanged(()=>play(overflow,request({amount:amount+100})),/ARCADE_BALANCE_LIMIT/);
 // Cumulative statistics must not reject a sampled win selectively.
 for(const stats of [{played:max},{matched:max},{score:max},{streak:max},{totalStaked:max-99},{totalPayout:max-3599},{netWin:max-3499},{netWin:-max+99}]){
  const bounded=member(500000,stats);unchanged(()=>play(bounded,request()),/ARCADE_BALANCE_LIMIT/);
 }
 // The banker multiplier divides first, avoiding a rounded intermediate.
 const bankerAmount=4619076540892100,banker=member(bankerAmount),shoe=Array.from({length:416},(_,i)=>i),ranks=[0,3,1,4];let cards=0;
 clock+=300;crypto.randomInt=maxCards=>{assert.equal(maxCards,shoe.length);const rank=ranks[cards++],index=shoe.findIndex(id=>id%13===rank);shoe[index]=shoe[shoe.length-1];shoe.pop();return index;};
 const banked=play(banker,request({game:'BACCARAT',choice:'BANKER',amount:bankerAmount}));assert.equal(cards,4);assert.equal(banked.result.winner,'BANKER');
 assert.equal(banked.result.payout,Number(BigInt(bankerAmount)*195n/100n));assert.equal(banked.wallet.balance,9007199254739595);
 // Shared wallet actions keep integer validation and action/points defaults.
 unchanged(()=>s.Atomic(()=>s.Ledger({id:'BAD',balance:max+1},-1,'TEST','BAD')),/BALANCE_INVALID/);
 unchanged(()=>s.Atomic(()=>s.Ledger({id:'BAD',balance:4503599627370496},0.5,'TEST','BAD')),/BALANCE_INVALID/);
 unchanged(()=>s.Atomic(()=>s.Ledger(large(),max,'TEST','BAD')),/BALANCE_INVALID/);
 assert.throws(()=>s.Money(10000001),/AMOUNT_INVALID/);
 for(const key of ['pointLedger','eventSpins','orders','shopPurchases','pointConversions','chargeRequests'])assert.deepEqual(s.DB()[key],{},'arcade leaves '+key+' unchanged');
 // Failed persistence also rolls back a large number payout and receipt.
 const rollback=member(4000000),before=JSON.stringify(s.DB()),save=database.SaveDatabase;nextNumber(36);
 try{database.SaveDatabase=()=>false;unchanged(()=>play(rollback,largeBody,'FIX50-SAVE-FAILED'),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 assert.equal(JSON.stringify(s.DB()),before);assert.equal(play(rollback,largeBody,'FIX50-SAVE-FAILED').wallet.balance,144000000);
 const persisted=JSON.parse(fs.readFileSync(require('../config/config').DB_FILE,'utf8'));
 s.Import(persisted);crypto.randomInt=()=>assert.fail('persisted retry cannot draw');
 assert.deepEqual(play(large,largeBody,'FIX50-LARGE-REPLAY'),won);assert.equal(large().balance,144000000);
 // A large arcade winner can still use the existing member wallet flows.
 const commerce=require('../services/member/commerce'),points=require('../services/member/points'),rewards=require('../services/member/rewards'),charges=require('../services/member/charges');
 const product=commerce.SaveProduct({title:'잔액 이용권',genre:'테스트',accessType:'TYPE1',published:true,plans:[{days:1,price:1000}]});
 const purchased=s.Atomic(()=>commerce.Purchase(large(),{productId:product.id,days:1,price:1000,revision:product.revision}));assert.equal(purchased.profile.balance,143999000);
 commerce.Refund({id:purchased.order.id,reason:'TEST REFUND'},'TEST');assert.equal(large().balance,144000000);
 s.Atomic(()=>{s.DB().settings.rewards={...rewards.Rules(),pointExchange:{enabled:true,cashUnit:10,pointUnit:1}};});
 const converted=s.Atomic(()=>points.Exchange(large(),{amount:100,revision:rewards.Rules().revision}));assert.equal(converted.profile.balance,144001000);assert.equal(converted.profile.points,332);
 const reversed=points.Reverse({id:converted.conversion.id,reason:'TEST REVERSAL'},'TEST');assert.equal(reversed.profile.balance,144000000);assert.equal(reversed.profile.points,432);
 const charge=charges.Issue(large()),approval=charges.Inspect('QRC1.'+charge.id+'.'+charge.token);
 charges.Approve({id:charge.id,approvalToken:approval.approvalToken,mode:'WALLET',amount:1000,memo:'TEST CREDIT'},'TEST');assert.equal(large().balance,144001000);
 unchanged(()=>s.Atomic(()=>rewards.Credit(large(),100000000,'TEST','POINT-CAP')),/POINT_BALANCE_INVALID/);
 console.log('FIX50 ARCADE BALANCE PASS: all 37 numbers win/lose, >100k full available chip stacks, >100M payouts, exact large banker payout, pre-RNG balance/stat overflow guards, unchanged points/action caps, large-wallet purchase/refund/exchange/reversal/credit compatibility, paired settlement, atomic save failure and disk-persisted replay.');
}finally{Date.now=oldNow;crypto.randomInt=oldRandom;fs.rmSync(temp,{recursive:true,force:true});}
