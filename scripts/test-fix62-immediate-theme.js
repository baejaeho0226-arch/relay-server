'use strict';
// Execute the native theme choice and the actual render admission expressions.
// This is a control-flow regression, not a Delphi/device rendering test.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const apk=path.resolve(__dirname,'../../MoaPlayApp_Android64');
const read=n=>fs.readFileSync(path.join(apk,n),'utf8').replace(/^\uFEFF/,'').replace(/\r/g,'');
function routine(text,name){
 const rows=[...text.matchAll(/^(?:procedure|function)\s+([\w.]+)/gm)];
 const i=rows.findIndex(m=>m[1]===name);assert.ok(i>=0,name);
 return text.slice(rows[i].index,rows[i+1]?.index??text.length).replace(/\{[\s\S]*?\}/g,'');
}
const settings=read('MoaPlayApp.Member.Settings.inc'),flow=read('MoaPlayApp.Member.Flow.inc');
function choice(source){
 let body=routine(source,'TMoaPlayForm.HubQueueTheme').split(/\bbegin\b/)[1].replace(/\bend;\s*$/,'').trim();
 const tokens=body.match(/:=|<>|=|'[^']*'|[A-Za-z_]\w*|[();]/g)||[];
 assert.equal(tokens.join(''),body.replace(/\s/g,''),'no unhandled native syntax');
 let code=body.replace(/if\s+Dark=MemberDark\s+then\s+Exit;/,'if (Dark===s.MemberDark) return;');
 code=code.replace(/(FHub\w+)\s*:=\s*(Dark|True|False);/g,(_,key,v)=>`s.${key}=${v==='True'?'true':v==='False'?'false':v};`);
 code=code.replace(/\b(SetMemberDark|HubApplyTheme|HubSaveDraft|HubRender)\s*(\(Dark\))?;/g,(_,name,arg)=>`s.${name}(${arg?'Dark':''});`);
 assert.doesNotMatch(code,/:=|\bbegin\b|\bthen\b|\bend\b/);
 return Function('s','Dark',code);
}
function expression(text){
 let js=text.replace(/Assigned\(([^)]+)\)/g,'Boolean($1)').replace(/<>/g,'!==').replace(/(?<![!<>=])=(?!=)/g,'===')
  .replace(/\bnot\b/gi,'!').replace(/\band\b/gi,'&&').replace(/\bor\b/gi,'||').replace(/\bTrue\b/g,'true').replace(/\bFalse\b/g,'false');
 assert.match(js,/^[\w\s.'()!<>=&|]+$/,'limited Pascal predicate');
 return Function('s','with(s){return ('+js+');}');
}
function gates(text){
 const body=routine(text,'TMoaPlayForm.HubRenderTimerTimer').split('FHubLocalRender:=False;')[0];
 return [...body.matchAll(/(?:^|\n)\s*if\s+([^;]+?)\s+then\s+Exit;/g)].map(m=>expression(m[1]));
}
function state(){return {
 MemberDark:true,FHubNextDark:true,FHubThemePending:false,FHubLocalRender:false,FHubPageChanged:false,
 FClosing:false,FHubReadyPayload:'',FHubReadyAction:'',HubInputFocused:false,HubScrollDragging:false,
 FHubOverlay:{Visible:false},FHubThemeSwitch:{Animating:true},FHubRewardWheel:{Animating:false},
 FHubCommentEdit:{IsFocused:false},FHubView:'settings',FHubTouch:{Busy:false},FHubComboUntil:0,
 TStopwatch:{GetTimeStamp:1000},calls:[],writes:0,paints:0,
 HubSaveDraft(){this.calls.push('draft');},SetMemberDark(v){this.MemberDark=v;this.writes++;this.calls.push('persist');},
 HubApplyTheme(){this.paints++;this.calls.push('chrome');},HubRender(){this.calls.push('queue');}
};}
function check(source=flow,settingSource=settings){
 const toggle=choice(settingSource),s=state();toggle(s,false);
 assert.equal(s.MemberDark,false,'palette is committed in the click, before any animation callback');
 assert.deepEqual(s.calls,['draft','persist','chrome','queue']);
 assert.equal(s.FHubNextDark,false);assert.equal(s.FHubThemePending,true);assert.equal(s.FHubLocalRender,true);
 const blocked=gates(source).some(g=>g(s));
 assert.equal(blocked,false,'a switch whose finish callback never fires cannot block page recoloring');
 assert.equal(gates(source).some(g=>g({...s,FHubTouch:{Busy:true},HubScrollDragging:true})),true,'a newly held control is protected until release');
 assert.equal(gates(source).some(g=>g({...s,FHubOverlay:{Visible:true}})),true,'visible modal retains its controls');
 const writes=s.writes;toggle(s,false);assert.equal(s.writes,writes,'same choice is idempotent');
 toggle(s,true);assert.equal(s.MemberDark,true);assert.equal(s.FHubNextDark,true,'latest rapid toggle wins');
 assert.doesNotMatch(routine(settingSource,'TMoaPlayForm.HubQueueTheme'),/HubRenderNow|FreeAndNil/,'do not free the switch inside its own callback');
}
check();
assert.throws(()=>check(flow.replace('if FHubLocalRender then begin', 'if FHubThemePending and FHubThemeSwitch.Animating then Exit;\n  if FHubLocalRender then begin')));
assert.throws(()=>check(flow,settings.replace('SetMemberDark(Dark);HubApplyTheme;','HubApplyTheme;')));
const schedule=routine(flow,'TMoaPlayForm.HubRender');
const predicate=schedule.match(/if\s+([^;]+?)\s+then\s+FHubRenderTimer.Enabled:=True;/);assert.ok(predicate);
const admits=expression(predicate[1]);let writes=0,enabled=false;
const scheduled={FClosing:false,FHubRenderTimer:{get Enabled(){return enabled;},set Enabled(v){writes++;enabled=v;}}};
for(let i=0;i<100;i++)if(admits(scheduled))scheduled.FHubRenderTimer.Enabled=true;
assert.equal(writes,1,'a burst of updates cannot continually restart the due paint timer');
for(const [file,name] of [['MoaPlayApp.Member.Actions.inc','HubActionClick'],['MoaPlayApp.Member.Settings.inc','HubSettingsChanged']]){
 const body=routine(read(file),'TMoaPlayForm.'+name);
 assert.match(body,/FHubTouch\.Cancel;[\s\S]*FDashboardScroll\.AniCalculations\.MouseLeave;/,'accepted clicks clear captured parent state');
}
const switchCode=routine(read('MoaPlayMemberSwitch.pas'),'TMoaPlayMemberSwitch.Toggle');
assert.doesNotMatch(switchCode,/if FAnimating\s+or/,'missing finish callback cannot lock later settings taps');
assert.match(switchCode,/FAnimating:=False;FAnimation.Stop;[\s\S]*FChecked:=not FChecked/);
assert.match(flow,/if not FHubPageChanged and FHubTouch.Busy then Exit;/,'network paints still protect real held controls');
console.log('FIX62 IMMEDIATE THEME PASS: actual native choice/paint gates, missing animation completion, rapid toggles, no inline destruction, true-hold/modal protection and coalesced paint scheduling. Delphi/device not executed.');
