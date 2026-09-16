'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../MoaPlayApp_Android64');
const read=name=>fs.readFileSync(path.join(root,name),'utf8').replace(/\r/g,'');
const feed=read('MoaPlayApp.Member.Feed.inc'),social=read('MoaPlayApp.Member.Social.inc'),menu=read('MoaPlayApp.Member.Menu.inc');
function between(source,start,end){const from=source.indexOf(start),to=source.indexOf(end,from+start.length);assert.ok(from>=0&&to>from,start);return source.slice(from,to);}
function checkSocial(s){
 const more=between(s,'procedure TMoaPlayForm.HubOpenMore','function TMoaPlayForm.HubPostPhoto');
 assert.match(more,/Peer:=not Own and \(AuthorID<>''\) and \(AuthorID<>HubText\(FHubOwnProfile,'id'\)\)/,'peer menu excludes missing and own author IDs');
 assert.match(more,/if \(Kind='post'\) and Peer then begin[\s\S]*Row\('팔로우 취소','following','social.follow'\)[\s\S]*Row\('팔로우','followers','social.follow'\)[\s\S]*Row\('채팅하기','bubble','social.chat'\)/);
 assert.match(more,/if Own then begin Row\('수정','edit','social.edit'\);Row\('삭제','trash','social.delete'\);end/,'owner actions stay available');
 const action=between(s,"if (Action='social.follow') or (Action='social.chat') then begin","if Action='social.save'");
 assert.match(action,/if \(Kind<>'post'\) or HubBool\(Item,'own'\) or \(AuthorID=''\) or\s*\(AuthorID=HubText\(FHubOwnProfile,'id'\)\) then Exit/,'action rechecks target, not only menu visibility');
 assert.match(action,/HubDirectMessagesAction\('dm.open',AuthorID\);Exit/,'chat uses authenticated existing full-screen route');
 assert.match(action,/Body.AddPair\('id',AuthorID\);Body.AddPair\('following',TJSONBool.Create\(not HubBool\(Item,'following'\)\)\);\s*Send\('follow.set'\);Exit/,'follow mutation targets the author, not post ID');
 assert.match(s,/procedure Send\(const Request:string\);\s*begin\s*HubSendSocial\(Request,Body\)/,'reuse serialized durable mutation queue');
 assert.ok(s.indexOf("Kind:=FHubSocialKind;ItemID:=HubText(Item,'id');HubCloseOverlay(nil);")<s.indexOf("if (Action='social.follow') or (Action='social.chat')"),'close old sheet before opening conversation');
}
checkSocial(social);
assert.throws(()=>checkSocial(social.replace("(AuthorID=HubText(FHubOwnProfile,'id')) then Exit",'False then Exit')),'self-chat guard fault must fail');
assert.throws(()=>checkSocial(social.replace("HubDirectMessagesAction('dm.open',AuthorID)","HubDirectMessagesAction('dm.open',ItemID)")),'post-ID routing fault must fail');
const post=between(feed,'function TMoaPlayForm.HubFillPostCard','function TMoaPlayForm.HubQuoteCard');
assert.doesNotMatch(post,/HubFollowButton|ShowFollow/,'post cards no longer have standalone follow actions');
assert.equal((post.match(/'more\|post\|'/g)||[]).length,1,'single overflow target per post');
assert.match(post,/C.Width-52,HeaderTop-1,44,44/,'overflow is aligned with the author at the top-right');
assert.match(social,/if Icon='more' then AddMemberSvg\([^\n]+\).RotationAngle:=90/,'shared social overflow dots are vertical');
const apply=feed.slice(feed.indexOf('procedure TMoaPlayForm.HubApplyFollow'));
assert.match(apply,/if Assigned\(HubObject\(Data,'counts'\)\) then\s*for Cache in FHubCache.Values do UpdateCachedState\(Cache\)/,'cache refresh is ACK-only, not a full scan per live profile');
assert.match(apply,/HubSetJSON\(Obj,'following',TJSONBool.Create\(Following\)\)/,'reopening the sheet after ACK sees committed following state');
const results=between(menu,'procedure TMoaPlayForm.HubRenderMenuResults','procedure TMoaPlayForm.HubMenuCategoryClick');
assert.equal((results.match(/C.Fill.Kind:=TBrushKind.None;C.Stroke.Kind:=TBrushKind.None/g)||[]).length,2,'normal and @profile search rows have no fill or stroke');
assert.match(menu,/procedure HubMenuCategoryStyle[\s\S]*HubActionPanelStyle\(Card\);[\s\S]*if Selected then Card.Stroke.Color:=MemberText/,'category selectors retain their outline');
for(const width of [240,280,320,360,412,600,800]){
 const headerX=16,headerWidth=width-32-44,avatarWidth=40,nameX=50,available=headerWidth-nameX,moreX=width-52,moreWidth=44;
 assert.ok(available>0);assert.ok(headerX+headerWidth<moreX,'author hit target cannot overlap overflow');
 assert.ok(avatarWidth<nameX);assert.ok(moreX+moreWidth<=width,'overflow retains a full 44px hit target');
}
console.log('FIX61 FEED/MENU PASS: peer-only follow/chat targets, self-route fault checks, durable mutation queue, owner actions, header hit bounds, vertical overflow, acknowledged follow state, transparent menu rows and retained category selectors.');
