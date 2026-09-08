'use strict';
// Source checks are safeguards, not a substitute for Delphi/Android compilation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const dir=path.join(__dirname,'ApkWinSock_Android64'),read=name=>fs.readFileSync(path.join(dir,name),'utf8');
const fields=read('ApkWinSock.Fields.inc'),methods=read('ApkWinSock.Methods.inc');
const files=fs.readdirSync(dir).filter(n=>/^ApkWinSock\..+\.inc$/.test(n));const all=files.map(read).join('\n');
const declared=new Set([...fields.matchAll(/^\s*(F\w+)\s*:/gm)].map(m=>m[1]));
for(const m of all.matchAll(/\b(FHub\w+|FSplashMinUntil)\b/g))assert.ok(declared.has(m[1]),'Missing field '+m[1]);
for(const m of all.matchAll(/\b(?:procedure|function) TForm1\.(Hub\w+)\s*\(([^)]*)\)/g)){
 const decl=methods.match(new RegExp('\\b(?:procedure|function) '+m[1]+'\\s*\\(([^)]*)\\)'));
 assert.ok(decl,'Missing method '+m[1]);
 const parameters=x=>x.replace(/\s*=\s*[^;]+/g,'').split(';').flatMap(part=>{const [names,type]=part.trim().split(':');return type?names.replace(/^(const|var|out)\s+/,'').split(',').map(n=>n.trim()+':'+type.trim()):[]});
 assert.deepEqual(parameters(m[2]),parameters(decl[1]),'Signature '+m[1]);
}
const svg=read('ApkMemberSvg.pas');assert.match(svg,/uses System\.Classes, FMX\.Types, FMX\.Skia;/);
const {JSDOM}=require('./WebRelay_Node_v6.7.0_WebAdmin_v3.5.0/node_modules/jsdom');let count=0;
for(const m of svg.matchAll(/Name = '([^']+)'\) and \(Filled = (True|False)\) then Exit\('([^']+)'\)/g)){
 const source=m[3].replaceAll('%COLOR%','#171717'),file=m[1]+'-'+(m[2]==='True'?'filled':'outline')+'.svg';
 assert.equal(source,read('Svg/'+file).trim(),'SVG/source mismatch '+file);
 const dom=new JSDOM(source,{contentType:'image/svg+xml'}),root=dom.window.document.documentElement;
 assert.equal(root.getAttribute('viewBox'),'0 0 24 24');assert.equal(root.querySelectorAll('script,foreignObject,image,filter').length,0);dom.window.close();count++;
}
assert.equal(count,42);
const flow=read('ApkWinSock.Member.Flow.inc'),dashboard=read('ApkWinSock.Dashboard.inc'),menu=read('ApkWinSock.Member.Menu.inc');
const render=flow.split('procedure TForm1.HubRender;')[1].split('procedure TForm1.HubRenderTimerTimer')[0];
assert.ok(render.includes('FHubRenderTimer.Enabled:=True'));assert.ok(!render.includes('FreeAndNil'));assert.ok(flow.includes('FHubRenderedView<>FHubView'));
assert.ok(flow.indexOf('FHubMemo:=nil;FHubSearchEdit:=nil;FHubPlanCombo:=nil;FHubMenuResults:=nil;')<flow.indexOf('FreeAndNil(FHubPage)'));
assert.ok(!dashboard.includes('FHubNavShape'));assert.ok(dashboard.includes('FHubTitleBar.SetBounds(0,0,W,56)'));assert.ok(dashboard.includes('FHubFilledIcons[I].SetBounds(FDashboardIcons[I].Position.X'));
assert.ok(!dashboard.includes('FHubNavIndicator'));assert.ok(!dashboard.includes('TApkTapRectangle.Create'));assert.ok(dashboard.includes('FHubTouch.Cancel'));
assert.ok(!dashboard.includes('FHubHeaderRefresh'));assert.ok(!dashboard.includes('FHubHeaderCount'));
assert.ok(!menu.includes('security'));assert.ok(!menu.includes('connection'));assert.ok(menu.includes('HubRenderMenuResults'));
assert.ok(read('ApkWinSock.Lifecycle.Construction.inc').includes('TStopwatch.Frequency * 5'));
assert.ok(read('ApkWinSock.Lifecycle.Startup.inc').includes('if TStopwatch.GetTimeStamp < FSplashMinUntil then Exit;'));
const biometric=read('ApkUiText.pas');assert.ok(!/Result\s*:=\s*Value\b/i.test(biometric));
assert.ok(!read('ApkWinSock.pas').includes('GlobalUseSkia := True'));
const touch=read('ApkMemberTouch.pas'),actions=read('ApkWinSock.Member.Actions.inc');
for(const marker of ['procedure Click; override','procedure TApkTapRectangle.MouseUp','CheckMovement(LocalToAbsolute(PointF(X,Y)))','if not Rejected then inherited Click','FMovingUntil','RemoveFreeNotification','OnMouseLeave:=Leave'])assert.ok(touch.includes(marker),marker);
assert.ok(flow.includes("FHubTouch.Busy or (HubInputFocused and not ((Action='thread')"));
assert.ok(flow.includes('FHubReadyPayload:=Payload'));
assert.ok(flow.includes('TStopwatch.Frequency*12'));
for(const source of ['ApkWinSock.Member.NewsShop.inc','ApkWinSock.Member.MyPage.inc','ApkWinSock.Member.Menu.inc','ApkWinSock.Member.Flow.inc']){
 assert.ok(!/HubTitle\(/.test(read(source)),source);
 assert.ok(!/HubNumber\([^\n]*'views'/.test(read(source)),source);
 assert.ok(!read(source).includes("'topup"),source);
 assert.ok(!read(source).includes("'refresh'"),source);
}
assert.ok(read('ApkWinSock.Member.NewsShop.inc').includes('TComboBox.Create'));
assert.ok(actions.includes("Send('post.edit')"));
assert.ok(!fs.existsSync(path.join(dir,'ApkWinSock.Member.Coins.inc')));
for(const key of ['Names','Details','Actions','Groups','Icons']){
 const match=menu.slice(menu.indexOf('procedure TForm1.HubRenderMenuResults;')).match(new RegExp(key+':=\\s*\\[([^\\]]+)\\]'));
 assert.ok(match,key);assert.equal([...match[1].matchAll(/'[^']*'/g)].length,12,key);
}
assert.ok(!touch.includes('FHighlight'));assert.ok(!touch.includes('Feedback('));
const poll=flow.split('procedure TForm1.HubPollTimerTimer')[1].split('procedure TForm1.HubRender;')[0];
assert.ok(!poll.includes('if not FForeground or FHubTouch.Busy'));
assert.ok(read('ApkMemberClient.pas').includes("RelayHmacSha256Hex(FSecurity.Secret,'HUB_EVENT|"));
assert.ok(read('ApkWinSock.Member.Charge.inc').includes('RenderQrMatrix'));
console.log('FIX18 UI SOURCE PASS: fields/signatures, 42 SVG sources, native click/drag guards, bounded busy state, signed automatic refresh, menu arrays, feed-only views, QR charge UI, game purchases, rectangular bars and no press effects');

assert.ok(touch.includes('function TApkTapRectangle.PointInObjectLocal'));
assert.ok(touch.includes('AutoCapture:=True'));
assert.ok(read('ApkWinSock.Member.Feed.inc').includes('W,48'));
for(const icon of ['like','dislike'])assert.notEqual(read('Svg/'+icon+'-filled.svg'),read('Svg/'+icon+'-outline.svg'));
assert.ok(read('ApkWinSock.Member.Purchase.inc').includes('HubApplyReaction'));
assert.ok(read('ApkWinSock.Member.Actions.inc').includes("Send('purchase')"));
assert.ok(read('ApkWinSock.Lifecycle.Construction.inc').includes('FullScreen := False'));
assert.ok(read('ApkSystemBars.pas').includes('Controller.show(3)'));
assert.ok(read('ApkSystemBars.pas').includes('Insets.getInsets(1 or 2 or 128)'));

const newsShop=read('ApkWinSock.Member.NewsShop.inc'),motion=read('ApkWinSock.Member.Motion.inc'),feed=read('ApkWinSock.Member.Feed.inc');
assert.ok(motion.includes('FHubPlanCombo.DroppedDown'),'native picker must survive polling');
assert.ok(read('ApkWinSock.pas').includes('FMX.Pickers'),'TDropDownKind is unit-scoped');
assert.ok(dashboard.includes('FHubCommentEdit.Parent:=FHubCommentBar'));
assert.ok(!feed.includes("HubEditField('댓글 작성'"));assert.ok(!feed.includes("'댓글 등록'"));
assert.ok(actions.includes("Trim(FHubCommentEdit.Text)=''"));
assert.ok(flow.includes("FHubCommentContext<>FHubPostID"),'comment drafts remain scoped to the thread');
assert.ok(flow.includes("Action='thread') and FHubCommentEdit.IsFocused"),'comment refresh must preserve the fixed composer');
assert.ok(motion.includes("Outline.Visible:=not Active")&&motion.includes('Filled.Visible:=Active'));
assert.ok(!read('ApkWinSock.Member.Purchase.inc').includes('TSkSvg(Child).Svg.Source:='));
assert.ok(flow.includes('TBitmap.Create(256,256)')&&flow.includes('RectF(X,Y,X+Side,Y+Side)'));
assert.ok(read('ApkMemberClient.pas').includes("'HUB_UPLOAD|'"));
assert.ok(read('ApkMemberTheme.pas').includes('member-appearance.txt'));
assert.ok(!newsShop.includes("'전체 게임'")&&!newsShop.includes("'사용 가능한 잔액 '"));
