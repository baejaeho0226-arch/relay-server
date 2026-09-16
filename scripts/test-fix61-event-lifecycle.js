'use strict';
// Exercise the exact native admission/cancellation expressions and server
// receipts: leaving is an uncredited abandonment, never an implicit Finish.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const native = path.resolve(__dirname, '../../MoaPlayApp_Android64');
const read = name => fs.readFileSync(path.join(native, name), 'utf8').replace(/\r/g, '');
const board = read('MoaPlaySkillGames.pas'), form = read('MoaPlayApp.Member.EventGames.inc');
function method(source, name) {
  const start = source.indexOf('procedure ' + name + '(');
  assert.ok(start >= 0, name);
  const next = source.slice(start + 10).search(/\n(?:procedure|function|constructor|destructor) /);
  return next < 0 ? source.slice(start) : source.slice(start, start + 10 + next);
}
function expression(source) {
  const js = source.replace(/Assigned\(Parent\)/g, 'Parent')
    .replace(/<>/g, '!==').replace(/\bnot\b/gi, '!').replace(/\band\b/gi, '&&')
    .replace(/\bor\b/gi, '||').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
  assert.match(js, /^[\w\s!&|()'=]+$/);
  const names = [...new Set(js.match(/\b[A-Z]\w*\b/g) || [])];
  const evaluate = Function(...names, 'return (' + js + ');');
  return values => evaluate(...names.map(name => values[name]));
}
const startMethod = method(board, 'TMoaPlaySkillGame.StartSession');
const startGuard = startMethod.match(/if (not FActive[^;]+) then Exit;/);
assert.ok(startGuard, 'late receipt guard is inside the board, not only its caller');
const rejectsStart = expression(startGuard[1]);
for (let mask = 0; mask < 16; mask++) {
  const state = {FActive: !!(mask & 1), FWaitingStart: !!(mask & 2), Visible: !!(mask & 4), Parent: !!(mask & 8)};
  assert.equal(rejectsStart(state), mask !== 15, 'start receipt is accepted only by its currently mounted active waiting board');
}
const active = method(board, 'TMoaPlaySkillGame.SetActive');
const cancelGuard = active.match(/if (not Value[\s\S]+?) then\s+AbandonSession\(''\);/);
assert.ok(cancelGuard);
const abandons = expression(cancelGuard[1]);
const idle = {Value:false,CancelRun:true,FRunning:false,FWaitingStart:false,FSettling:false,FEnded:false,FSessionID:''};
for (const field of ['FRunning','FWaitingStart','FSettling','FEnded','FSessionID']) {
  const state = {...idle,[field]:field === 'FSessionID' ? 'RUN-OLD' : true};
  assert.equal(abandons(state),true,'exit cancels '+field);
  assert.equal(abandons({...state,Value:true}),false,'activation cannot cancel '+field);
  assert.equal(abandons({...state,CancelRun:false}),false,'same-page reparenting preserves '+field);
}
assert.equal(abandons(idle),false);
assert.ok(active.indexOf('AbandonSession') < active.indexOf('if FActive = Value then Exit'), 'an already suspended board still gets abandoned on real exit');
const abandon = method(board, 'TMoaPlaySkillGame.AbandonSession');
for (const flag of ['FRunning','FWaitingStart','FSettling','FPaused','FEnded','FHasAward','FPressed','FPendingTap']) assert.match(abandon,new RegExp(flag+' := False'));
assert.match(abandon,/FSessionID := ''/);
assert.match(abandon,/SetLength\(FInputs, 0\); SetLength\(FSchedules, 0\); UpdateTimer/);
assert.doesNotMatch(abandon,/EndRun|FOnFinish|FinishBody/,'exiting cannot submit an earned-score trace');
assert.match(form,/Board\.SetActive\(False,False\);Board\.Parent:=nil/,'refresh uses the explicit non-canceling suspension');
assert.match(form,/procedure TMoaPlayForm\.HubEventGameStop;[\s\S]*?Board\.SetActive\(False\);[\s\S]*?FHubRewardWheel\.CancelAnimation;[\s\S]*?FHubSpinVisualPending:=False;FHubSpinResultID:='';/);
assert.match(form,/if not Active then begin HubEventGameStop;Exit;end;/);
assert.match(form,/if Board\.WaitingStart and FForeground and FFinalPanel\.Visible and[\s\S]*?\(FHubView='event\.'\+LowerCase\(Game\)\)/);
const wheel = read('MoaPlayRewardWheel.pas');
assert.match(wheel,/procedure TMoaPlayRewardWheel\.CancelAnimation;[\s\S]*?FTurn\.Stop;[\s\S]*?FAnimating:=False;/);
const flow=read('MoaPlayApp.Member.Flow.inc');
assert.match(method(flow,'TMoaPlayForm.HubNavigate'),/HubEventGameStop/);
const backStart=flow.indexOf('procedure TMoaPlayForm.HubGoBack;'),backEnd=flow.indexOf('function TMoaPlayForm.HubReadAction');
assert.match(flow.slice(backStart,backEnd),/HubEventGameStop/);
assert.match(flow,/FHubSpinVisualPending/,'spin acknowledgement must respect abandoned visual intent');
assert.match(read('MoaPlayApp.Lifecycle.Construction.inc'),/FForeground := False;HubEventGameActive\(False\)/);
// The implementation can never skip a Start waiting-state guard without these
// race cases detecting it (delayed ACK after exit/re-entry, duplicate start).
const unguarded=expression(startGuard[1].replace('not FWaitingStart or ',''));
assert.equal(unguarded({FActive:true,FWaitingStart:false,Visible:true,Parent:true}),false);
assert.equal(rejectsStart({FActive:true,FWaitingStart:false,Visible:true,Parent:true}),true);

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix61-events-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const state=require('../core/state'), store=require('../services/member/store'), hub=require('../services/member/service');
const lm=require('../license/licenseManager'),rewards=require('../services/member/rewards'),engine=require('../services/member/eventEngine');
let request=0,now=Date.parse('2026-09-16T00:00:00Z');const realNow=Date.now;Date.now=()=>now;
try {
  const id='0000000000000061',key='FIX61-EVENT-LIFECYCLE';
  const client={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
  state.clients.set(id,client);state.clientIdentities.set(key,{id,serverId:'',createdAt:now});
  state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:now});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
  client.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(client.licenseKey).boundClient=id;
  const run=(action,body={},requestId)=>hub.Execute(client,requestId||'FIX61-EVENT-'+(++request),action,body);
  const account=()=>store.Account(client);
  store.Account(client);const points=()=>account().points||0;
  for (const game of engine.GAME_IDS) {
    const before=points(),startId='FIX61-PENDING-'+game;
    const old=run('event.start',{game,revision:rewards.Rules().revision},startId).session;
    // No finish is sent when navigation/background invalidates the local trace.
    now+=10000;
    assert.equal(run('event.start',{game,revision:rewards.Rules().revision},startId).session.id,old.id,'late ACK/replay resolves original durable start');
    run('rewards');assert.equal(points(),before,'reads or a canceled local start cannot credit points');
    const fresh=run('event.start',{game,revision:rewards.Rules().revision}).session;
    assert.notEqual(fresh.id,old.id,'re-entry starts a fresh run');
    assert.equal(account().skillEvents.sessions.find(row=>row.id===old.id).status,'ABANDONED');
    assert.throws(()=>run('event.finish',{sessionId:old.id,ticks:1,actions:[]}),/EVENT_SESSION_NOT_FOUND/);
    assert.equal(points(),before);
  }
  // A completed finish already in flight is still authoritative exactly once.
  const session=run('event.start',{game:'WHACK',revision:rewards.Rules().revision}).session;
  const finish={sessionId:session.id,ticks:20,actions:[{t:2,a:'tap',lane:engine.Schedule('WHACK',session.seed)[0].lane}]};
  now+=1000;const before=points(),receipt=run('event.finish',finish,'FIX61-FINISH-BEFORE-EXIT');
  assert.equal(receipt.result.points,10);assert.equal(points(),before+10);
  assert.deepEqual(run('event.finish',finish,'FIX61-FINISH-BEFORE-EXIT').result,receipt.result);
  assert.equal(points(),before+10,'leaving during settlement cannot cancel or duplicate a committed award');
  console.log('FIX61 EVENT LIFECYCLE PASS: native late-ACK admission matrix, exit/background cancellation, same-page refresh preservation, wheel visual cancellation, fresh runs, uncredited abandonments, and once-only in-flight settlement.');
} finally {Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true});}
