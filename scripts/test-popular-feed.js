'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-popular-feed-'));process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),protocol=require('../services/member/protocol');
let sequence=0,clock=Date.now();const originalNow=Date.now;Date.now=()=>clock;
const run=(peer,action,body={})=>hub.Execute(peer.c,'POPULAR-REQUEST-'+(++sequence),action,body);
function feedTopTen(peer){const first=run(peer,'feed',{sort:'popular',limit:8});return [...first.items,...(first.nextOffset===null?[]:run(peer,'feed',{sort:'popular',offset:first.nextOffset,limit:2}).items)];}
function client(id){
 const lines=[],c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:'POPULAR-'+id,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(x){lines.push(x.trim());return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(c.installationDeviceKey,{id,serverId:'',createdAt:clock});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:clock});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 return {c,lines};
}
function signed(peer,action,body){
 const id='POPULAR-SIGNED-'+(++sequence),encoded=Buffer.from(JSON.stringify(body)).toString('base64'),fields=[id,action,encoded];peer.lines.length=0;peer.c.hubRate=null;
 hub.Handle(peer.c,['HUB',...fields,protocol.Sign(peer.c,'HUB',fields)].join('|'));
 const chunks=peer.lines.filter(x=>x.startsWith('HUB_CHUNK|')).map(x=>x.split('|')).sort((a,b)=>Number(a[3])-Number(b[3]));assert.ok(chunks.length);
 for(const chunk of chunks)assert.equal(chunk[6],protocol.Sign(peer.c,'HUB_RESPONSE',chunk.slice(1,6)));
 const response=JSON.parse(Buffer.from(chunks.map(x=>x[5]).join(''),'base64'));assert.equal(response.ok,true,JSON.stringify(response));return response.data;
}
function image(){const {PNG}=require('pngjs'),png=new PNG({width:64,height:64});png.data.fill(140);for(let i=3;i<png.data.length;i+=4)png.data[i]=255;return 'data:image/png;base64,'+PNG.sync.write(png).toString('base64');}
try{
 const author=client('1111111111111111'),viewer=client('2222222222222222'),other=client('3333333333333333');
 const authorId=run(author,'me').profile.id,viewerId=run(viewer,'me').profile.id;run(other,'me');
 assert.deepEqual(run(viewer,'popular').items,[]);assert.deepEqual(run(viewer,'live',{scope:'popular'}).scope,[]);
 const posts=[];
 for(let i=0;i<13;i++){clock+=11000;posts.push(run(author,'post.create',{title:'제목 '+i,body:'내용 '+i}).post);}
 const photo=image(),gifData='data:image/gif;base64,'+fs.readFileSync(path.join(__dirname,'fixtures/gallery-animation.gif')).toString('base64');
 clock+=11000;const rich=run(author,'post.create',{title:'사진 GIF 투표',body:'원본 내용',image:photo,gifData,poll:{question:'선택해주세요',options:['하나','둘']}}).post;
 run(viewer,'react',{postId:rich.id,value:1});run(viewer,'poll.vote',{postId:rich.id,optionId:'1'});run(viewer,'follow.set',{id:authorId,following:true});run(viewer,'bookmark.set',{kind:'post',id:rich.id,saved:true});
 let popular=run(viewer,'popular',{_wire:'zlib'}),ranked=feedTopTen(viewer);
 assert.equal(popular.items.length,10);assert.equal(popular.total,10);assert.equal(popular.nextOffset,null);
 assert.deepEqual(popular.items.map(x=>x.id),ranked.map(x=>x.id),'feed and ranked collection have identical popular order');
 const full=popular.items.find(x=>x.id===rich.id),ordinary=run(viewer,'feed',{_wire:'zlib',sort:'popular',limit:10}).items.find(x=>x.id===rich.id);
 assert.deepEqual(full,ordinary,'full cards use the same fields and media quality as the regular feed');
 assert.equal(full.title,'사진 GIF 투표');assert.equal(full.body,'원본 내용');assert.ok(full.image);assert.ok(full.gif.frames.length);assert.equal(full.poll.options.length,2);assert.equal(full.poll.myVote,'1');assert.equal(full.myReaction,1);assert.equal(full.bookmarked,true);assert.equal(full.following,true);
 for(const field of ['points','balance','eventSpins'])assert.equal(full.author[field],undefined,'public author data does not expose '+field);
 assert.equal(run(author,'popular').items.find(x=>x.id===rich.id).myReaction,0,'viewer-specific reaction state is never shared');
 assert.deepEqual(run(viewer,'popular',{limit:1,offset:20,mine:true,following:true,sort:'latest'}).items.map(x=>x.id),ranked.map(x=>x.id),'fixed Top10 ignores ordinary feed paging/filter overrides');
 let scope=run(viewer,'live',{scope:'popular'}).scope;
 assert.deepEqual(scope,popular.items.map(x=>x.id+'/'+x.revision));
 const revision=s.DB().revision;assert.equal(run(viewer,'popular',{_since:revision}).unchanged,true);
 const promoted=posts[0];viewer.lines.length=0;clock+=2000;signed(other,'comment.create',{postId:promoted.id,body:'순위 갱신'});run(other,'react',{postId:promoted.id,value:1});
 const event=viewer.lines.find(x=>x.startsWith('HUB_EVENT|'));assert.ok(event,'another phone publishes a signed revision notice');const fields=event.split('|');assert.equal(fields[2],protocol.Sign(viewer.c,'HUB_EVENT',[fields[1]]));
 const reordered=run(viewer,'live',{scope:'popular'}).scope;assert.notDeepEqual(reordered,scope,'new reactions/comments move an offscreen post into the ranked collection');
 popular=run(viewer,'popular',{_since:revision});assert.equal(popular.unchanged,undefined);assert.equal(popular.items[0].id,promoted.id);assert.deepEqual(popular.items.map(x=>x.id),feedTopTen(viewer).map(x=>x.id));
 const live=run(viewer,'live',{scope:'popular',posts:[promoted.id,rich.id]});assert.equal(live.posts.find(x=>x.id===promoted.id).comments,1);assert.equal(live.posts.find(x=>x.id===promoted.id).likes,1);
 run(other,'poll.vote',{postId:rich.id,optionId:'0'});assert.equal(run(viewer,'live',{scope:'popular',posts:[rich.id]}).posts[0].poll.options[0].votes,1);
 const oldScope=run(viewer,'live',{scope:'popular'}).scope;run(author,'post.edit',{id:rich.id,revision:0,title:'바뀐 제목',body:'수정 내용'});assert.notDeepEqual(run(viewer,'live',{scope:'popular'}).scope,oldScope,'edited content invalidates ranked cards');
 run(author,'post.delete',{id:promoted.id});assert.ok(!run(viewer,'popular').items.some(x=>x.id===promoted.id),'deleted posts are immediately removed and lower ranks fill the collection');
 clock+=11000;run(viewer,'post.create',{title:'내 글',body:'내 내용'});run(viewer,'preferences.save',{profilePostsVisibility:'PRIVATE'});
 assert.ok(run(other,'popular').items.some(x=>x.author.id===viewerId),'profile-only privacy does not hide globally public feed posts');
 run(viewer,'block.set',{id:authorId,blocked:true});assert.ok(run(viewer,'popular').items.every(x=>x.author.id!==authorId));assert.deepEqual(run(viewer,'popular').items.map(x=>x.id),feedTopTen(viewer).map(x=>x.id));
 for(const post of [rich,...posts])assert.equal(s.ViewCount('post',post.id),0,'preview, ranking and live polling never count as explicit post views');
 console.log('POPULAR FEED PASS: full Top10 cards, identical feed order, media/viewer state, live rank changes, edit/delete/block visibility, signed updates and no background views.');
}finally{Date.now=originalNow;fs.rmSync(temp,{recursive:true,force:true});}
