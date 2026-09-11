'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),apk=path.join(root,'ApkWinSock_Android64');
const read=name=>fs.readFileSync(path.join(apk,name),'utf8');
for(const folder of ['ApkWinSock_Android64','WinSockServer_Win64']){
 const base=path.join(root,folder);
 for(const name of fs.readdirSync(base).filter(x=>/\.(pas|inc)$/.test(x))){
  const bytes=fs.readFileSync(path.join(base,name));assert.deepEqual([...bytes.subarray(0,3)],[239,187,191],name+' BOM');
  const text=new TextDecoder('utf8',{fatal:true}).decode(bytes);
  for(const match of text.matchAll(/\{\$I\s+([^}]+)\}/gi))assert.ok(fs.existsSync(path.join(base,match[1].trim())),match[1]);
 }
}
const declared=[...read('ApkWinSock.Methods.inc').matchAll(/\b(?:procedure|function)\s+(\w+)/gi)].map(x=>x[1].toLowerCase());
const units=fs.readdirSync(apk).filter(x=>/\.(pas|inc)$/.test(x)).map(read).join('\n');
const implemented=[...units.matchAll(/\b(?:procedure|function)\s+TForm1\.(\w+)/gi)].map(x=>x[1].toLowerCase());
assert.equal(new Set(implemented).size,implemented.length,'Duplicate form methods');
for(const name of declared)assert.ok(implemented.includes(name),'Missing '+name);
for(const name of implemented)assert.ok(declared.includes(name),'Undeclared '+name);
for(const name of ['ApkMemberClient.pas'])assert.deepEqual(require('./native-declarations').Check(read(name)),[]);
// Cross-layer invariants for the lifecycle bugs: no editor exit saves a partially destroyed form.
const flow=read('ApkWinSock.Member.Flow.inc'),motion=read('ApkWinSock.Member.Motion.inc'),compose=read('ApkWinSock.Member.Compose.inc'),social=read('ApkWinSock.Member.Social.inc');
assert.match(flow,/if FHubRendering or not Assigned\(FHubDrafts\)/);
assert.match(flow,/HubSaveDraft;\s*FHubRendering:=True;\s*try/);
assert.match(flow,/finally FHubRendering:=False;end;/);
assert.match(motion,/if FClosing or FHubRendering/);
assert.match(compose,/Draft\.AddPair\('imageChanged'/);assert.match(compose,/HubSaveComposeMedia;HubRenderComposeChange/);
assert.match(compose,/for I:=0 to 1 do/);assert.doesNotMatch(compose,/for I:=0 to 3 do/);
assert.match(compose,/제목을 작성하세요/);assert.match(compose,/이야기를 작성하세요/);
assert.match(read('ApkGifPicker.pas'),/ACTION_GET_CONTENT/);assert.match(read('ApkGifPicker.pas'),/image\/gif/);
assert.match(read('ApkMemberGif.pas'),/FAnimated\.LoadFromStream\(Stream\)/);
assert.doesNotMatch(social,/Row\('닫기'/);assert.doesNotMatch(read('ApkWinSock.Member.MyPage.inc'),/fsUnderline/);
assert.doesNotMatch(read('ApkWinSock.Member.Feed.inc'),/'reply','reply\|'/);
assert.match(read('ApkWinSock.Member.Feed.inc'),/'bubble',HubCount\(HubNumber\(Item,'replies'\)\),'reply\|'/);
assert.match(social,/GifView\.LoadFrames\(GifData\)/);
require('./check-native-theme').Check(apk);
console.log('Native source checks passed (encoding, includes, declarations and lifecycle invariants; Delphi compilation not run).');
