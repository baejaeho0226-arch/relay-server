'use strict';
// FMX source/geometry regression. Native event dispatch still needs a device.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../MoaPlayApp_Android64');
const read=name=>fs.readFileSync(path.join(root,name),'utf8').replace(/\r/g,'');
function between(source,start,end){const from=source.indexOf(start),to=source.indexOf(end,from+start.length);assert.ok(from>=0&&to>from,start);return source.slice(from,to);}
const feed=read('MoaPlayApp.Member.Feed.inc'),social=read('MoaPlayApp.Member.Social.inc');
function expression(text,values){
 const converted=text.replace(/C\.Width/g,'width').replace(/\bHeaderTop\b/g,'headerTop').replace(/\bMax\b/g,'Math.max');
 assert.match(converted,/^[a-zA-Z0-9_.+*/(),\s-]+$/);
 return Function('width','headerTop',`return (${converted});`)(values.width,values.headerTop);
}
function checkLayout(source){
 const post=between(source,'function TMoaPlayForm.HubFillPostCard','function TMoaPlayForm.HubQuoteCard');
 const comments=between(source,'procedure TMoaPlayForm.HubRenderComments','function TMoaPlayForm.HubFollowButton');
 const postTarget=post.match(/HubIconButton\(C,'more','more\|post\|'\+ID,([^,]+),([^,]+),(\d+),(\d+)\)/);
 const replyTarget=comments.match(/HubIconButton\(C,'more','more\|comment\|'\+ID,([^,]+),([^,]+),(\d+),(\d+)\)/);
 const attribution=post.match(/L.SetBounds\(38,10,(.+?),18\);L.TagString:='repost-time/);
 assert.ok(postTarget&&replyTarget&&attribution,'menu and attribution geometry must be readable');
 assert.equal((post.match(/'more\|post\|'/g)||[]).length,1,'one post menu');
 assert.doesNotMatch(post,/HubFollowButton/,'peer actions remain in menu');
 assert.match(post,/MetaInset:=0;if Interactive then MetaInset:=44/,'author hit target reserves overflow lane');
 assert.match(comments,/TextW-44/,'reply attribution reserves the same lane');
 for(const width of [240,280,320,360,412,480,600,800,1024]){
  const baseY=expression(postTarget[2],{width,headerTop:16});
  for(const headerTop of [16,34,58,82]){
   const x=expression(postTarget[1],{width,headerTop}),y=expression(postTarget[2],{width,headerTop});
   assert.equal(y,baseY,'repost/header growth must not move outer-card overflow');
   assert.equal(width-x-Number(postTarget[3]),8,'right inset stays unchanged');
   assert.equal(Number(postTarget[3]),44);assert.equal(Number(postTarget[4]),44);
   assert.ok(16+width-32-44<x,'profile target cannot intercept overflow taps');
   assert.ok(y+44<=headerTop+42+12,'overflow cannot reach post content');
   const textRight=38+expression(attribution[1],{width,headerTop});
   assert.ok(textRight<=x-8,'long repost names and relative times cannot overlap overflow');
  }
  const commentBase=expression(replyTarget[2],{width,headerTop:12});
  for(const headerTop of [12,32,56,100]){
   const x=expression(replyTarget[1],{width,headerTop}),y=expression(replyTarget[2],{width,headerTop});
   assert.equal(y,commentBase,'reply heading growth cannot move the menu');
   assert.ok(y+Number(replyTarget[4])<=headerTop+38+4);
   assert.ok(16+(width-32-44)<=x-8,'reply header text cannot intercept menu');
  }
 }
 assert.match(post,/L.TextSettings.Trimming:=TTextTrimming.Character;L.ClipChildren:=True;HeaderTop:=34/,'repost attribution truncates inside its reserved lane');
 const quote=between(source,'function TMoaPlayForm.HubQuoteCard','procedure TMoaPlayForm.HubPostCard');
 assert.match(quote,/if Node is TControl then TControl\(Node\).HitTest:=False/,'nested quote decoration stays read-only');
}
checkLayout(feed);
assert.throws(()=>checkLayout(feed.replace('C.Width-52,15,44,44','C.Width-52,HeaderTop-1,44,44')),'reported moving-post-menu regression must fail');
assert.throws(()=>checkLayout(feed.replace('Max(1,C.Width-98),18','C.Width-54,18')),'old attribution overlap must fail');
assert.throws(()=>checkLayout(feed.replace('C.Width-52,9,44,44','C.Width-52,HeaderTop-3,44,44')),'reply header must not move card menu');
const menu=between(social,'procedure TMoaPlayForm.HubOpenMore','function TMoaPlayForm.HubPostPhoto');
assert.match(menu,/if \(Kind='post'\) and Peer then begin[\s\S]*social.follow[\s\S]*social.chat/);
assert.match(menu,/Peer:=not Own and \(AuthorID<>''\) and \(AuthorID<>HubText\(FHubOwnProfile,'id'\)\)/);
const action=between(social,"if (Action='social.follow') or (Action='social.chat') then begin","if Action='social.save'");
assert.match(action,/HubBool\(Item,'own'\)/);assert.match(action,/AuthorID=HubText\(FHubOwnProfile,'id'\)/);
assert.match(action,/HubDirectMessagesAction\('dm.open',AuthorID\)/);
assert.match(action,/Send\('follow.set'\)/);
const badges=read('MoaPlayApp.Member.Badges.inc');
assert.match(badges,/C.HitTest:=Earned and not ReadOnly/,'public badge pages remain read-only');
assert.match(badges,/if Earned and not ReadOnly then begin C.TagString:='badge.select\|'/,'unearned badges cannot equip');
assert.match(badges,/HubBadgeColor\(Item,'iconColor'\)/);assert.match(badges,/HubBadgeColor\(Item,'color'\)/);
assert.doesNotMatch(badges,/ThemeChildLabels\(C,MemberOnPrimary\)/,'selection must not erase purchased title colors');
console.log('FIX62 feed layout PASS: outer-card menus across widths/repost/reply heights, attribution lanes and fault injection, peer-only follow/chat, read-only public badges and custom colors.');
