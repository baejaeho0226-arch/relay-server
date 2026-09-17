'use strict';
// FMX source invariants and execution of its density/width invalidation predicate.
// This verifies application decisions, not Android raster quality or Delphi compilation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const apk=path.resolve(__dirname,'../../MoaPlayApp_Android64');
const read=name=>fs.readFileSync(path.join(apk,name),'utf8').replace(/^\uFEFF/,'');
function verifyDecode(source){
 const implementation=source.split(/\bimplementation\b/i)[1];
 assert.match(implementation,/Assigned\(Control\) and Assigned\(Control\.Scene\)[\s\S]*?Control\.Scene\.GetSceneScale/);
 assert.match(implementation,/SupportsPlatformService\(IFMXScreenService,IInterface\(ScreenService\)\)[\s\S]*?ScreenService\.GetScreenScale/);
 assert.match(implementation,/IsNan\(Result\) or IsInfinite\(Result\) or \(Result<=0\) then Result:=1/);
 assert.match(implementation,/Bitmap\.BitmapScale:=1;Target\.Assign\(Bitmap\);Target\.BitmapScale:=1/);
 assert.match(implementation,/Cache\.TryGetValue\(Encoded,Bitmap\) then begin Target\.Assign\(Bitmap\);Target\.BitmapScale:=1/);
 assert.doesNotMatch(implementation,/SetSize\(|\.Resize\(|CreateThumbnail\(/,'original source pixels are retained, independent of current display density');
 assert.match(implementation,/Budget=32\*1024\*1024/,'full resolution retention remains bounded');
}
function redrawPredicate(source){
 const match=source.match(/if (\(Abs\(FLastWidth-W\)>0\.5\)[\s\S]*?) then begin FSignature:='';FDirty:=True;end;/);
 assert.ok(match,'density changes must invalidate DM rows at the same logical width');
 let expression=match[1].replace('MemberDisplayScale(FHost)','scale').replace(/\bAbs\(/g,'Math.abs(').replace(/\bor\b/g,'||');
 assert.match(expression,/FLastDisplayScale-scale/);
 assert.doesNotMatch(expression,/[;{}]/);
 return new Function('FLastWidth','W','FLastDisplayScale','scale','return '+expression+';');
}
function Check(){
 const images=read('MoaPlayMemberImages.pas');verifyDecode(images);
 const dm=read('MoaPlayDirectMessages.pas'),redraw=redrawPredicate(dm);
 let transitions=0;
 for(const width of [240,280,320,360,393,412,480,600,800])for(const previous of [0.75,1,1.25,1.5,2,2.625,3,3.5,4])for(const next of [0.75,1,1.25,1.5,2,2.625,3,3.5,4]){
  assert.equal(redraw(width,width,previous,next),previous!==next,'same logical width, new physical pixel density');transitions++;
  assert.equal(redraw(width,width+20,previous,next),true,'logical width change still reflows rows');
 }
 assert.equal(redraw(360,360,2.625,2.6250001),false,'floating point noise cannot churn the transcript');
 assert.match(dm,/FLastDisplayScale:=MemberDisplayScale\(FHost\);FSignature:=Signature/);
 const resize=dm.slice(dm.indexOf('procedure TMoaPlayDirectMessages.Resize(KeyboardTop:Single);'));
 assert.doesNotMatch(resize.split('procedure TMoaPlayDirectMessages.SaveDraft;')[0],/FreeAndNil\(FInput\)|FInput\.Text:=/,'resize preserves native editor and draft');
 const dashboard=read('MoaPlayApp.Dashboard.inc'),flow=read('MoaPlayApp.Member.Flow.inc'),lifecycle=read('MoaPlayApp.Lifecycle.Construction.inc');
 const scaleRoutine=dashboard.slice(dashboard.indexOf('procedure TMoaPlayForm.HubRefreshDisplayScale;'),dashboard.indexOf('procedure TMoaPlayForm.ResizeDashboardUI;'));
 assert.match(scaleRoutine,/CurrentScale:=MemberDisplayScale\(FRoot\)/,'use actual scene density');
 assert.match(scaleRoutine,/Abs\(CurrentScale-FHubDisplayScale\)<=0\.001/,'same-width density changes are observable without polling churn');
 assert.match(scaleRoutine,/HubSaveDraft;FHubComposeMeasuredWidth:=0;FHubComposeMeasuredText:=''/,'preserve text while invalidating measurements');
 assert.match(scaleRoutine,/FHubPage\.Repaint;HubRender/,'queue a safe page reflow');
 assert.match(scaleRoutine,/FSupportMessagesDirty:=True;FSupportHelpDirty:=True/);
 assert.match(scaleRoutine,/HubDirectMessagesResize/);
 assert.doesNotMatch(scaleRoutine,/FRoot\.Scale|HubRenderNow|FreeAndNil/,'density never rescales app coordinates or destroys active controls inline');
 assert.match(dashboard.slice(dashboard.indexOf('procedure TMoaPlayForm.ResizeDashboardUI;')),/HubRefreshDisplayScale/);
 assert.match(flow,/if FForeground then HubRefreshDisplayScale/);
 assert.match(lifecycle,/procedure TMoaPlayForm\.FormActivated[\s\S]*?HubRefreshDisplayScale/);
 const memo=read('MoaPlayMemberMemo.pas'),toast=read('MoaPlayUiFeedback.pas');
 assert.match(memo,/DisplayScale:=MemberDisplayScale\(Self\)/);
 assert.match(memo,/Abs\(FMeasuredScale-DisplayScale\)<0\.001/);
 assert.match(toast,/DisplayScale:=MemberDisplayScale\(FParent\)/);
 assert.match(toast,/Abs\(FMeasuredScale-DisplayScale\)>0\.001/);
 for(const text of [memo,toast])assert.match(text,/FMeasuredScale:=DisplayScale/);
 assert.match(read('MoaPlayApp.Member.Media.inc'),/MemberLoadBitmap\(FHubTabAvatar\.Fill\.Bitmap\.Bitmap,Encoded\)/);
 assert.throws(()=>verifyDecode(images.replaceAll('Target.BitmapScale:=1;','')),'detect unnormalized cached bitmap regression');
 assert.throws(()=>redrawPredicate(dm.replace('Abs(FLastDisplayScale-MemberDisplayScale(FHost))>0.001','False')),'detect width-only density regression');
 return transitions;
}
module.exports={Check};
if(require.main===module)console.log('FIX62 density PASS: '+Check()+' display transitions, source-pixel retention, cache/measurement invalidation and composer preservation (source checks; Delphi/device not run).');
