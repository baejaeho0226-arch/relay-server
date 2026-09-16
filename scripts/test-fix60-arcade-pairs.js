'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix60-pairs-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const s=require('../services/member/store'),arcade=require('../services/member/arcade'),db=require('../storage/database');
const oldNow=Date.now,oldRandom=crypto.randomInt;let clock=1900000000000,serial=0;
Date.now=()=>clock;
function member(balance=1000000){const subject='FIX60-PAIR-'+(++serial),id='USR-'+subject;s.Atomic(()=>{s.DB().profiles[subject]={id,subject,nickname:'페어',avatar:'',createdAt:clock,balance,points:17,eventSpins:3};});return ()=>s.ProfileById(id);}
function body(game,bets,rulesRevision=5){return {game,bets,rulesRevision};}
function play(p,request,id='FIX60-PLAY-'+(++serial)){return s.Operation(p(),id,'arcade.play',request,()=>arcade.Play(p(),request));}
function unchanged(fn,error){const digest=()=>crypto.createHash('sha256').update(JSON.stringify(s.DB())).digest('hex'),before=digest();assert.throws(fn,error);assert.equal(digest(),before,'rejected operation leaves the complete database unchanged');}
function cards(ranks){clock+=300;const shoe=Array.from({length:416},(_,i)=>i);let calls=0;crypto.randomInt=max=>{assert.equal(max,shoe.length);assert.ok(calls<ranks.length);const rank=ranks[calls++],index=shoe.findIndex(id=>id%13===rank);assert.ok(index>=0);shoe[index]=shoe[shoe.length-1];shoe.pop();return index;};return ()=>assert.equal(calls,ranks.length);}
function number(n){clock+=300;let calls=0;crypto.randomInt=max=>{assert.equal(max,37);calls++;return n;};return ()=>assert.equal(calls,1);}
function ledger(p,out,before){const r=out.result,rows=Object.values(s.DB().ledger).filter(row=>row.reference===r.id);assert.equal(rows.length,2);assert.equal(rows.find(x=>x.kind==='ARCADE_BET').amount,-r.betAmount);assert.equal(rows.find(x=>x.kind==='ARCADE_PAYOUT').amount,r.payout);assert.equal(p().balance,before-r.betAmount+r.payout);assert.equal(p().balance,out.wallet.balance);assert.equal(p().points,17);assert.equal(p().eventSpins,3);}
try{
 const p=member(),rules=arcade.Read(p()).rules;
 assert.equal(rules.revision,5);assert.equal(rules.maxBets,50);assert.equal(rules.payoutIncludesStake,true);
 assert.deepEqual(rules.choices.BACCARAT,['PLAYER','TIE','BANKER','PLAYER_PAIR','BANKER_PAIR']);
 assert.deepEqual(rules.paytable.BACCARAT.PLAYER_PAIR,{numerator:12,denominator:1});assert.equal(rules.paytable.BACCARAT.pairTiePush,false);
 assert.equal(rules.choices.ROULETTE.length,50);assert.equal(new Set(rules.choices.ROULETTE).size,50);
 const allPairs=body('BACCARAT',rules.choices.BACCARAT.map(choice=>({choice,amount:100})));
 // First-two rank matching is independent of the main winner; both pairs can
 // win on a tie. Two face cards worth zero are not necessarily the same rank.
 const scenarios=[
  {ranks:[3,3,3,3],winner:'TIE',player:true,banker:true,payout:3500},
  {ranks:[3,0,3,1],winner:'PLAYER',player:true,banker:false,payout:1400},
  {ranks:[0,3,1,3],winner:'BANKER',player:false,banker:true,payout:1395},
  {ranks:[2,1,3,4],winner:'TIE',player:false,banker:false,payout:1100},
  {ranks:[9,3,10,3],winner:'BANKER',player:false,banker:true,payout:1395},
  // Player 2,3,2 and banker 2,4: a first/third match is not a pair.
  {ranks:[1,1,2,3,1],winner:'PLAYER',player:false,banker:false,payout:200}
 ];
 for(const expected of scenarios){const verify=cards(expected.ranks),before=p().balance,out=play(p,allPairs);verify();ledger(p,out,before);assert.equal(out.result.winner,expected.winner);assert.equal(out.result.playerPair,expected.player);assert.equal(out.result.bankerPair,expected.banker);assert.equal(out.result.payout,expected.payout);assert.equal(out.result.betCount,5);assert.equal(out.result.bets.find(x=>x.choice==='PLAYER_PAIR').payout,expected.player?1200:0);assert.equal(out.result.bets.find(x=>x.choice==='BANKER_PAIR').payout,expected.banker?1200:0);}
 // Pair-only stakes and repeated placement on the same area aggregate once.
 const duplicate=body('BACCARAT',[{choice:'PLAYER_PAIR',amount:100},{choice:'PLAYER_PAIR',amount:500},{choice:'BANKER_PAIR',amount:100}]);
 let verify=cards([3,0,3,1]),before=p().balance,out=play(p,duplicate,'FIX60-PAIR-REPLAY');verify();ledger(p,out,before);assert.equal(out.result.payout,7200);assert.equal(out.result.betCount,2);assert.equal(out.result.bets[0].betAmount,600);
 crypto.randomInt=()=>assert.fail('replay cannot draw');assert.deepEqual(play(p,duplicate,'FIX60-PAIR-REPLAY'),out);unchanged(()=>play(p,{...duplicate,bets:[{choice:'PLAYER_PAIR',amount:100}]},'FIX60-PAIR-REPLAY'),/REQUEST_REUSED/);
 // Exhaust every rank pair, with varying suits and an irrelevant third card.
 const ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
 for(const a of ranks)for(const b of ranks){const result={winner:'TIE',player:[{rank:a,suit:'SPADE'},{rank:b,suit:'HEART'},{rank:a,suit:'CLUB'}],banker:[{rank:b},{rank:a},{rank:b}]};for(const choice of ['PLAYER_PAIR','BANKER_PAIR']){const settled=arcade.Settlement('BACCARAT',choice,100,result);assert.equal(settled.payout,a===b?1200:0);assert.equal(settled.matched,a===b);}}
 // All fifty areas are occupied at once; exact number, colour, parity, half,
 // dozen and column each settle against one server result. Zero loses all
 // outside bets and wins only GREEN plus NUMBER_0.
 const allRoulette=body('ROULETTE',rules.choices.ROULETTE.map(choice=>({choice,amount:100})));
 for(let n=0;n<=36;n++){verify=number(n);before=p().balance;const round=play(p,allRoulette);verify();ledger(p,round,before);assert.equal(round.result.betCount,50);assert.equal(round.result.payout,n===0?7200:4800);assert.equal(round.result.bets.filter(x=>x.matched).length,n===0?2:6);for(const bet of round.result.bets){const c=bet.choice;let expected;if(c==='EVEN')expected=n>0&&n%2===0?200:0;else if(c==='ODD')expected=n%2===1?200:0;else if(c==='LOW')expected=n>=1&&n<=18?200:0;else if(c==='HIGH')expected=n>=19?200:0;else if(c.startsWith('DOZEN_'))expected=n>=1+12*(Number(c.slice(6))-1)&&n<=12*Number(c.slice(6))?300:0;else if(c.startsWith('COLUMN_'))expected=n>0&&(n-1)%3+1===Number(c.slice(7))?300:0;else continue;assert.equal(bet.payout,expected,c+' at '+n);}}
 // Previous clients retain rules-4 main wagers; new side bets require the
 // new published rules. Client result flags are rejected before any RNG.
 verify=cards([3,0,3,1]);assert.equal(play(p,body('BACCARAT',[{choice:'PLAYER',amount:100}],4)).result.payout,200);verify();
 clock+=300;crypto.randomInt=()=>assert.fail('rejected stake must not draw');
 for(const request of [body('BACCARAT',[{choice:'PLAYER_PAIR',amount:100}],4),body('ROULETTE',[{choice:'EVEN',amount:100}],4)])unchanged(()=>play(p,request),/ARCADE_RULES_CHANGED/);
 for(const request of [{...allPairs,playerPair:true},body('BACCARAT',[{choice:'PAIR',amount:100}]),body('BACCARAT',[{choice:'PLAYER_PAIR',amount:100,payout:1200}]),body('ROULETTE',[{choice:'COLUMN_0',amount:100}]),body('ROULETTE',[{choice:'DOZEN_4',amount:100}]),body('ROULETTE',Array(51).fill({choice:'RED',amount:100}))])unchanged(()=>play(p,request),/INPUT_INVALID/);
 const insufficient=member(100);unchanged(()=>play(insufficient,allPairs),/ARCADE_BALANCE_REQUIRED/);
 // Pair overflow and reserved cash must be rejected before a sampled result.
 const max=Number.MAX_SAFE_INTEGER,capped=member(max);unchanged(()=>play(capped,allPairs),/ARCADE_BALANCE_LIMIT/);
 const stake=Math.floor(max/12/100)*100,edge=member(stake);verify=cards([3,0,3,1]);const edgeRound=play(edge,body('BACCARAT',[{choice:'PLAYER_PAIR',amount:stake}]));verify();assert.equal(edgeRound.result.payout,Number(BigInt(stake)*12n));
 crypto.randomInt=()=>assert.fail('overflow cannot draw');const overflow=member(stake+100);unchanged(()=>play(overflow,body('BACCARAT',[{choice:'PLAYER_PAIR',amount:stake+100}])),/ARCADE_BALANCE_LIMIT/);
 // Opposite halves and parity cannot win together; shared maxima allow a
 // hedged round at the account limit without summing impossible outcomes.
 const hedged=body('ROULETTE',['EVEN','ODD','LOW','HIGH'].map(choice=>({choice,amount:100})));verify=number(1);assert.equal(play(capped,hedged).wallet.balance,max);verify();
 const rollback=member(),save=db.SaveDatabase;verify=cards([3,3,3,3]);
 try{db.SaveDatabase=()=>false;unchanged(()=>play(rollback,allPairs,'FIX60-SAVE-RETRY'),/STORAGE_SAVE_FAILED/);}finally{db.SaveDatabase=save;}verify();
 cards([3,3,3,3]);const committed=play(rollback,allPairs,'FIX60-SAVE-RETRY');
 const persisted=JSON.parse(fs.readFileSync(require('../config/config').DB_FILE,'utf8'));s.Import(persisted);crypto.randomInt=()=>assert.fail('persisted replay cannot draw');assert.deepEqual(play(rollback,allPairs,'FIX60-SAVE-RETRY'),committed);assert.deepEqual(play(p,duplicate,'FIX60-PAIR-REPLAY'),out);
 for(const key of ['pointLedger','orders','shopPurchases','pointConversions','chargeRequests'])assert.deepEqual(s.DB()[key],{});
 console.log('FIX60 ARCADE PAIRS PASS: first-two ranks and independent pairs, all 169 rank combinations, simultaneous pair/main bets, duplicate stacks, all 50 roulette areas over all 37 outcomes, legacy rules, one authoritative draw, linked ledger, exact shared overflow guards, save rollback and durable replay.');
}finally{Date.now=oldNow;crypto.randomInt=oldRandom;fs.rmSync(temp,{recursive:true,force:true});}
