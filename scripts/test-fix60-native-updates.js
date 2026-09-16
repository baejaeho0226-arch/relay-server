'use strict';
// Source regression checks for FMX lifecycle/IME/portrait paths. A Delphi build
// and an Android device are still required to validate platform dispatch.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const apk=path.resolve(__dirname,'../../MoaPlayApp_Android64');
const read=name=>fs.readFileSync(path.join(apk,name),'utf8').replace(/^\uFEFF/,'');
function routine(source,name){
 const starts=[...source.matchAll(/^(?:constructor|destructor|procedure|function)\s+([\w.]+)/gm)];
 const i=starts.findIndex(x=>x[1]===name);assert.ok(i>=0,name);
 return source.slice(starts[i].index,starts[i+1]?.index??source.length).replace(/\{[\s\S]*?\}|\/\/[^\r\n]*/g,'');
}
function gateCheck(motion,flow,loading){
 const dragging=routine(motion,'TMoaPlayForm.HubScrollDragging');
 assert.doesNotMatch(dragging,/AniCalculations\.Down/,'captured Android taps must not defer every page forever');
 assert.match(dragging,/Assigned\(FHubTouch\) and FHubTouch\.Busy/,'real touch/dispatch/inertia remain protected');
 const timer=routine(flow,'TMoaPlayForm.HubRenderTimerTimer');
 assert.match(timer,/if not FHubPageChanged and FHubTouch\.Busy then Exit;/,'a live click sender stays alive until dispatch ends');
 assert.match(timer,/HubInputFocused[\s\S]*?then Exit;/,'background refresh cannot replace a live editor');
 const reply=routine(flow,'TMoaPlayForm.HubReply');
 assert.match(reply,/not FHubPageChanged and not FHubSkeleton and HubEventGameMounted then begin/,'only an actually mounted event board may skip page painting');
 const render=routine(flow,'TMoaPlayForm.HubRenderNow');
 assert.ok(render.indexOf("if FHubView.StartsWith('event.')")<render.indexOf('then HubRenderSkeleton'),'first event paints its shell before a server response');
 assert.ok(render.indexOf("FHubView.StartsWith('settings')")<render.indexOf('then HubRenderSkeleton'),'local settings are not hidden behind a server skeleton');
 assert.match(loading,/FHubSkeleton or \(FHubRefreshAction<>''\)/,'a cached page remains usable during background refresh');
 assert.doesNotMatch(loading,/FHubSkeleton or FHubVisualLoading/,'opening a populated event cannot show an indefinite dimmed veil');
}
function progressCheck(client,flow,live,currency){
 const pending=routine(client,'TMoaPlayMemberClient.ReadPending');
 assert.match(pending,/FLatestReads\.TryGetValue\(Action,ID\)/);
 assert.match(pending,/FRequests\.TryGetValue\(ID,Entry\)/,'canceled reads must not keep a UI loading flag set');
 assert.match(pending,/MemberTick-Entry\.StartedAt<15000/,'timeout is time since last progress, not initial page open');
 assert.match(routine(client,'TMoaPlayMemberClient.HandleLine'),/R\.Parts\[Index\]:=P\[5\];R\.StartedAt:=MemberTick/,'verified chunks refresh the idle deadline');
 const poll=routine(flow,'TMoaPlayForm.HubPollTimerTimer');
 assert.match(poll,/FHubLoading and not FMember\.ReadPending\(HubReadAction\)/);
 assert.match(live,/FMember\.ReadPending\('live'\)/);
 for(const action of ['currency.list','currency.quote'])assert.ok(currency.includes("FMember.ReadPending('"+action+"')"));
 assert.match(currency,/FHubCurrencyLoading:=False;FHubCurrencyDueAt:=0;\s*try\s*if FMember\.Request\('preferences.save'/,'saving a selected currency clears the canceled catalogue wait');
 assert.match(routine(client,'TMoaPlayMemberClient.RetryPending'),/MemberTick - FLastRetryAt < 12000/,'durable mutation recovery must retain its independent idempotent retry policy');
}
function Check(){
 const motion=read('MoaPlayApp.Member.Motion.inc'),flow=read('MoaPlayApp.Member.Flow.inc'),loading=read('MoaPlayApp.Member.Loading.inc');
 const client=read('MoaPlayMemberClient.pas'),live=read('MoaPlayApp.Member.Live.inc'),currency=read('MoaPlayApp.Member.Currency.inc');
 gateCheck(motion,flow,loading);progressCheck(client,flow,live,currency);
 const dashboard=read('MoaPlayApp.Dashboard.inc');
 assert.doesNotMatch(dashboard+read('MoaPlayApp.Fields.inc'),/FHubCommentSend/);
 assert.match(dashboard,/ReturnKeyType:=TReturnKeyType\.Done/);
 assert.match(dashboard,/KillFocusByReturn:=False/);
 const key=routine(dashboard,'TMoaPlayForm.HubCommentKeyDown');
 assert.match(key,/Key<>vkReturn/);assert.match(key,/FMember\.HasPending/);assert.match(key,/FHubCommentContext<>FHubPostID/);
 assert.match(key,/HubActionClick\(FHubCommentEdit\)/,'IME completion reuses server validation and reply/edit logic');
 assert.doesNotMatch(routine(dashboard,'TMoaPlayForm.HubCommentChanged'),/HubActionClick/,'typing and IME composition cannot submit');
 assert.match(dashboard,/FHubDirectMessages\.Back/);
 const unit=read('MoaPlaySkillGames.pas');
 assert.match(unit.split(/\bimplementation\b/i)[1],/uses[^;]*MoaPlayMemberOptions;/i,'MemberLanguage import regression');
 const imports=read('MoaPlayApp.pas');assert.match(imports,/MoaPlayAndroidUi/);
 assert.match(read('MoaPlayAndroidUi.pas'),/setRequestedOrientation\(1\)/);
 assert.match(read('MoaPlayApp.Lifecycle.Construction.inc'),/AndroidLockPortrait;/);
 for(const name of ['AndroidManifest.template.xml','AndroidManifest.full.xml'])
  assert.match(read(name),/<activity[\s\S]*?FMXNativeActivity[\s\S]*?android:screenOrientation="portrait"/);
 // Fault injection proves these guards catch the reported permanent stalls
 // and a too-short timer that would starve progressing multipart responses.
 assert.throws(()=>gateCheck(motion.replace('Result:=Assigned(FHubTouch) and FHubTouch.Busy;', 'Result:=FDashboardScroll.AniCalculations.Down;'),flow,loading));
 assert.throws(()=>gateCheck(motion,flow.replace('not FHubPageChanged and not FHubSkeleton and HubEventGameMounted then begin','not FHubPageChanged then begin'),loading));
 assert.throws(()=>progressCheck(client,flow.replace('FHubLoading and not FMember.ReadPending(HubReadAction)','FHubLoading and (TStopwatch.GetTimeStamp-FHubRequestedAt>TStopwatch.Frequency*6)'),live,currency));
}
module.exports={Check};
if(require.main===module){Check();console.log('FIX60 native updates PASS: released-touch rendering, first event/settings shell, progress-aware read recovery, currency cancellation, keyboard-only comment actions and portrait source paths (Delphi/device not run).');}
