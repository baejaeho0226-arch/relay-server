'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),apk=path.join(root,'MoaPlayApp_Android64');
const read=name=>fs.readFileSync(path.join(apk,name),'utf8');
for(const folder of ['MoaPlayApp_Android64','MoaPlayConnect_Win64']){
 const base=path.join(root,folder);
 for(const name of fs.readdirSync(base).filter(x=>/\.(pas|inc)$/.test(x))){
  const bytes=fs.readFileSync(path.join(base,name));assert.deepEqual([...bytes.subarray(0,3)],[239,187,191],name+' BOM');
  const text=new TextDecoder('utf8',{fatal:true}).decode(bytes);
  for(const match of text.matchAll(/\{\$I\s+([^}]+)\}/gi))assert.ok(fs.existsSync(path.join(base,match[1].trim())),match[1]);
 }
}
// Include files declare fields in the same form class: grouped names can
// redeclare an older standalone field even when all methods are valid.
const fieldNames=[];
for(const m of read('MoaPlayApp.Fields.inc').matchAll(/^\s*(F\w+(?:\s*,\s*F\w+)*)\s*:/gm))
 fieldNames.push(...m[1].split(',').map(n=>n.trim().toLowerCase()));
assert.equal(new Set(fieldNames).size,fieldNames.length,'Duplicate form fields');
// A missing SVG returns an empty string at runtime, silently hiding an action.
const iconNames=new Set([...read('MoaPlayMemberSvg.pas').matchAll(/Name\s*=\s*'([^']+)'/g)].map(m=>m[1]));
for(const file of fs.readdirSync(apk).filter(n=>/\.(pas|inc)$/.test(n)))
 for(const m of read(file).matchAll(/MemberSvg\(\s*'([^']+)'/g))
  assert.ok(iconNames.has(m[1]),file+' missing SVG '+m[1]);
const declared=[...read('MoaPlayApp.Methods.inc').matchAll(/\b(?:procedure|function)\s+(\w+)/gi)].map(x=>x[1].toLowerCase());
const units=fs.readdirSync(apk).filter(x=>/\.(pas|inc)$/.test(x)).map(read).join('\n');
const implemented=[...units.matchAll(/\b(?:procedure|function)\s+TMoaPlayForm\.(\w+)/gi)].map(x=>x[1].toLowerCase());
assert.equal(new Set(implemented).size,implemented.length,'Duplicate form methods');
for(const name of declared)assert.ok(implemented.includes(name),'Missing '+name);
for(const name of implemented)assert.ok(declared.includes(name),'Undeclared '+name);
for(const [name,type] of [['MoaPlayMemberClient.pas','TMoaPlayMemberClient'],['MoaPlayMemberSwitch.pas','TMoaPlayMemberSwitch'],['MoaPlayMemberMemo.pas','TMoaPlayMemberMemo'],['MoaPlayRewardWheel.pas','TMoaPlayRewardWheel'],['MoaPlayIconPulse.pas','TMoaPlayIconPulse']])
 assert.deepEqual(require('./native-declarations').Check(read(name),type),[],name);
// Cross-layer invariants for the lifecycle bugs: no editor exit saves a partially destroyed form.
const flow=read('MoaPlayApp.Member.Flow.inc'),motion=read('MoaPlayApp.Member.Motion.inc'),compose=read('MoaPlayApp.Member.Compose.inc'),social=read('MoaPlayApp.Member.Social.inc');
assert.match(flow,/if FHubRendering or not Assigned\(FHubDrafts\)/);
assert.match(flow,/HubSaveDraft;\s*FHubRendering:=True;\s*try/);
assert.match(flow,/finally FHubRendering:=False;end;/);
assert.match(motion,/if FClosing or FHubRendering/);
assert.match(compose,/Draft\.AddPair\('imageChanged'/);assert.match(compose,/HubSaveComposeMedia;HubRenderComposeChange/);
assert.match(compose,/for I:=0 to 1 do/);assert.doesNotMatch(compose,/for I:=0 to 3 do/);
assert.match(compose,/제목을 작성하세요/);assert.match(compose,/이야기를 작성하세요/);
assert.match(read('MoaPlayGifPicker.pas'),/ACTION_GET_CONTENT/);assert.match(read('MoaPlayGifPicker.pas'),/image\/gif/);
assert.match(read('MoaPlayMemberGif.pas'),/FAnimated\.LoadFromStream\(Stream\)/);
assert.doesNotMatch(social,/Row\('닫기'/);assert.doesNotMatch(read('MoaPlayApp.Member.MyPage.inc'),/fsUnderline/);
assert.doesNotMatch(read('MoaPlayApp.Member.Feed.inc'),/'reply','reply\|'/);
assert.match(read('MoaPlayApp.Member.Feed.inc'),/'bubble',HubCount\(HubNumber\(Item,'replies'\)\),'reply\|'/);
assert.match(social,/GifView\.LoadFrames\(GifData\)/);
require('./check-native-theme').Check(apk);
console.log('Native source checks passed (encoding, includes, declarations and lifecycle invariants; Delphi compilation not run).');
