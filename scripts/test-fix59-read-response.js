'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix59-read-response-')),realNow=Date.now,realFetch=global.fetch;
let now=1790000000000,sequence=0,networkCalls=0;Date.now=()=>now;global.fetch=async()=>{networkCalls++;throw Error('UNEXPECTED_NETWORK_REQUEST');};
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
// A current verified cache exercises real currency.list/quote implementations
// without external requests or replacing the authenticated service boundary.
fs.writeFileSync(path.join(temp,'currency-cache.json'),JSON.stringify({version:1,catalogAt:now,catalog:[{id:'bitcoin',name:'Bitcoin',symbol:'btc'},{id:'ethereum',name:'Ethereum',symbol:'eth'}],prices:[{id:'bitcoin',rate:1/150000000,at:now,fetchedAt:now,iconSvg:''},{id:'ethereum',rate:1/4000000,at:now,fetchedAt:now,iconSvg:''}]}));
require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),protocol=require('../services/member/protocol'),wire=require('../services/member/wire'),database=require('../storage/database');
function client(n){
 const id=String(n).padStart(16,'0'),key='FIX59-READ-RESPONSE-'+n,lines=[];
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(line){lines.push(line.trim());return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:now});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:now});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 return {c,lines};
}
const run=(peer,action,body={},id)=>hub.Execute(peer.c,id||'FIX59-READ-REQUEST-'+(++sequence),action,body),own=peer=>s.Account(peer.c),snapshot=()=>JSON.stringify(s.DB());
function request(peer,action,body={},id='FIX59-SIGNED-READ-'+(++sequence)){
 const fields=[id,action,Buffer.from(JSON.stringify(body)).toString('base64')];peer.lines.length=0;peer.c.hubRate=null;
 assert.equal(hub.Handle(peer.c,['HUB',...fields,protocol.Sign(peer.c,'HUB',fields)].join('|')),true);
 const chunks=peer.lines.filter(x=>/^HUB_(?:Z)?CHUNK\|/.test(x)).map(x=>x.split('|')).sort((a,b)=>Number(a[3])-Number(b[3]));assert.ok(chunks.length);
 for(const row of chunks){assert.equal(row[1],id);assert.equal(row[2],action);assert.equal(row[6],protocol.Sign(peer.c,row[0]==='HUB_ZCHUNK'?'HUB_ZRESPONSE':'HUB_RESPONSE',row.slice(1,6)));}
 return JSON.parse(wire.Decode(chunks.map(x=>x[5]).join(''),chunks[0][0]==='HUB_ZCHUNK'));
}
function token(result){assert.match(result.contentTag,/^[0-9a-f]{64}$/);assert.equal(result.revision,s.DB().revision);return result.contentTag;}
function unchanged(result,tag){assert.deepEqual(result,{unchanged:true,revision:s.DB().revision,contentTag:tag,memberProtocol:35});assert.ok(!JSON.stringify(result).includes('avatar'));}
try{
 const a=client(59501),b=client(59502),other=client(59503);for(const peer of [a,b,other])run(peer,'me');
 const image='data:image/png;base64,'+require('pngjs').PNG.sync.write(new (require('pngjs').PNG)({width:8,height:8})).toString('base64');
 s.Atomic(()=>{
  for(const peer of [a,b])Object.assign(own(peer),{avatar:image,avatarThumb:image});
  for(let i=0;i<4;i++){const id='POST-READ-'+i;s.DB().posts[id]={id,accountId:own(b).id,title:'게시글 '+i,body:'내용 '+i,at:now-i,revision:0,deleted:false,hidden:false};}
  for(let i=0;i<3;i++){const id='NEWS-READ-'+i;s.DB().news[id]={id,title:'소식 '+i,body:'소식 상세 '+i,category:'NOTICE',published:true,at:now-i,revision:1};}
  s.DB().news.PRIVATE={id:'PRIVATE',title:'다른 회원 전용',body:'PRIVATE_SECRET',category:'NOTICE',published:true,audience:own(other).id,at:now+1,revision:1};
 });
 const query={sort:'latest',limit:2},initial=run(a,'feed',query),firstTag=token(initial);assert.deepEqual(initial.items.map(x=>x.id),['POST-READ-0','POST-READ-1']);assert.equal(initial.viewer.avatar,image);
 const before=snapshot();unchanged(run(a,'feed',{...query,_ifNoneMatch:firstTag}),firstTag);assert.equal(snapshot(),before,'matching content reads do not persist or mark content read');
 // Global revision alone is not a content change. Return the current revision
 // in the small envelope while preserving the already displayed page/avatar.
 s.Atomic(()=>{s.DB().settings.unrelatedDiagnosticCounter=1;});
 unchanged(run(a,'feed',{...query,_ifNoneMatch:firstTag}),firstTag);
 const news=run(a,'news',{summary:true}),newsTag=token(news);assert.ok(!JSON.stringify(news).includes('PRIVATE_SECRET'));
 s.Atomic(()=>{own(other).bio='irrelevant private profile edit';});unchanged(run(a,'news',{summary:true,_ifNoneMatch:newsTag}),newsTag);
 const secondPage=run(a,'feed',{...query,offset:2,_since:s.DB().revision,_ifNoneMatch:firstTag});assert.notEqual(token(secondPage),firstTag);assert.deepEqual(secondPage.items.map(x=>x.id),['POST-READ-2','POST-READ-3']);
 const following=run(a,'feed',{...query,following:true,_since:s.DB().revision,_ifNoneMatch:firstTag});assert.notEqual(token(following),firstTag);assert.deepEqual(following.items,[],'a tag from a different filter cannot bypass actual page construction');
 // A tag is never an authorization token, including while the underlying
 // database revision is unchanged and the caller has a matching cached body.
 a.c.biometricVerified=false;assert.throws(()=>run(a,'feed',{...query,_ifNoneMatch:firstTag}),/MEMBER_AUTH_REQUIRED/);a.c.biometricVerified=true;
 const otherFeed=run(other,'feed',{...query,_ifNoneMatch:firstTag});assert.notEqual(token(otherFeed),firstTag);assert.equal(otherFeed.viewer.id,own(other).id);
 run(other,'react',{postId:'POST-READ-0',value:1});const liked=run(a,'feed',{...query,_ifNoneMatch:firstTag});assert.notEqual(token(liked),firstTag);assert.equal(liked.items[0].likes,1);
 const likedTag=liked.contentTag;run(b,'profile.save',{nickname:own(b).nickname,bio:'작성자의 변경된 소개'});const changedAuthor=run(a,'feed',{...query,_ifNoneMatch:likedTag});assert.notEqual(token(changedAuthor),likedTag);assert.equal(changedAuthor.items[0].author.bio,'작성자의 변경된 소개');
 const viewerTag=changedAuthor.contentTag;run(a,'profile.save',{nickname:own(a).nickname,bio:'조회자의 변경된 소개'});const changedViewer=run(a,'feed',{...query,_ifNoneMatch:viewerTag});assert.notEqual(token(changedViewer),viewerTag);assert.equal(changedViewer.viewer.bio,'조회자의 변경된 소개');
 const memberQuery={id:own(b).id,postCards:true},member=run(a,'member',memberQuery),memberTag=token(member);assert.equal(member.posts.total,4);
 run(b,'preferences.save',{profilePostsVisibility:'PRIVATE'});const hidden=run(a,'member',{...memberQuery,_ifNoneMatch:memberTag});assert.notEqual(token(hidden),memberTag);assert.equal(hidden.profilePostsHidden,true);assert.deepEqual(hidden.posts.items,[]);
 for(const field of ['balance','points','subject','inventory'])assert.equal(hidden.profile[field],undefined,'public-member projection excludes '+field);
 run(b,'preferences.save',{profilePostsVisibility:'PUBLIC'});
 const thread=run(a,'thread',{postId:'POST-READ-0',countView:false}),threadTag=token(thread),visibleFeed=run(a,'feed',query);
 run(a,'block.set',{id:own(b).id,blocked:true});
 assert.throws(()=>run(a,'member',{...memberQuery,_ifNoneMatch:memberTag}),/MEMBER_NOT_FOUND/);
 assert.throws(()=>run(a,'thread',{postId:'POST-READ-0',countView:false,_ifNoneMatch:threadTag}),/POST_NOT_FOUND/);
 const blocked=run(a,'feed',{...query,_ifNoneMatch:visibleFeed.contentTag});assert.notEqual(token(blocked),visibleFeed.contentTag);assert.equal(blocked.total,0);assert.deepEqual(blocked.items,[]);
 run(a,'block.set',{id:own(b).id,blocked:false});
 const article=run(a,'article',{id:'NEWS-READ-0'}),articleTag=token(article),allNews=run(a,'news',{summary:true});
 s.Atomic(()=>{s.DB().news['NEWS-READ-0'].deleted=true;});assert.throws(()=>run(a,'article',{id:'NEWS-READ-0',_ifNoneMatch:articleTag}),/NEWS_NOT_FOUND/);
 const removed=run(a,'news',{summary:true,_ifNoneMatch:allNews.contentTag});assert.notEqual(token(removed),allNews.contentTag);assert.ok(removed.items.every(x=>x.id!=='NEWS-READ-0'));
 // An unread field changes even when titles and bodies do not.
 const unread=run(a,'news',{summary:true});assert.equal(unread.items.find(x=>x.id==='NEWS-READ-1').unread,true);
 run(a,'article',{id:'NEWS-READ-1'});const read=run(a,'news',{summary:true,_ifNoneMatch:unread.contentTag});assert.notEqual(token(read),unread.contentTag);assert.equal(read.items.find(x=>x.id==='NEWS-READ-1').unread,false);
 // Domain-specific revisions remain meaningful. Only the wrapper's former
 // global revision is replaced; rule revisions still belong to cached content.
 const rewards=run(a,'rewards'),ruleRevision=rewards.rules.revision;s.Atomic(()=>{s.DB().settings.rewards={...require('../services/member/rewards').Rules(),revision:ruleRevision+1};});
 const revisedRules=run(a,'rewards',{_ifNoneMatch:rewards.contentTag});assert.notEqual(token(revisedRules),rewards.contentTag);assert.equal(revisedRules.rules.revision,ruleRevision+1);
 const menu=run(a,'menu'),menuTag=token(menu);s.Atomic(()=>{s.DB().settings.unrelatedDiagnosticCounter++;});unchanged(run(a,'menu',{_ifNoneMatch:menuTag}),menuTag);
 // Signed read responses can use compact envelopes without broadcasting an
 // invalidation storm merely because the action name contains a dot.
 for(const [action,body] of [['currency.list',{query:'bit'}],['currency.quote',{code:'CG:bitcoin'}],['currency.quote',{code:'KRW'}]]){
  for(const peer of [b,other])peer.lines.length=0;const dbBefore=snapshot(),result=request(a,action,{...body,_wire:'zlib'});assert.equal(result.ok,true,JSON.stringify(result));
  if(action==='currency.list'){assert.equal(result.data.items.length,1);assert.equal(result.data.items[0].code,'CG:bitcoin');}else assert.equal(result.data.ready,true);
  assert.equal(snapshot(),dbBefore);assert.ok([b,other].every(peer=>peer.lines.every(line=>!line.startsWith('HUB_EVENT|'))),'a dotted read never broadcasts without a committed database change');
 }
 assert.equal(networkCalls,0,'the verified local quote/catalog fixtures require no external network');
 const fresh=run(a,'feed',query);for(const peer of [b,other])peer.lines.length=0;const signedCached=request(a,'feed',{...query,_ifNoneMatch:fresh.contentTag,_wire:'zlib'});assert.equal(signedCached.ok,true);unchanged(signedCached.data,fresh.contentTag);assert.ok([b,other].every(peer=>peer.lines.length===0));
 // A real write emits a signed invalidation; replay and failed persistence do
 // not emit redundant or phantom changes. Navigation history is explicitly local.
 const mutationBody={nickname:own(a).nickname,bio:'서명 요청으로 수정'};for(const peer of [b,other])peer.lines.length=0;
 assert.equal(request(a,'profile.save',mutationBody,'FIX59-SIGNED-MUTATION').ok,true);
 for(const peer of [b,other]){const events=peer.lines.filter(line=>line.startsWith('HUB_EVENT|'));assert.equal(events.length,1);const fields=events[0].split('|');assert.equal(fields[1],String(s.DB().revision));assert.equal(fields[2],protocol.Sign(peer.c,'HUB_EVENT',[fields[1]]));peer.lines.length=0;}
 assert.equal(request(a,'profile.save',mutationBody,'FIX59-SIGNED-MUTATION').ok,true);assert.ok([b,other].every(peer=>peer.lines.length===0));
 const save=database.SaveDatabase,saveBefore=snapshot();database.SaveDatabase=()=>false;
 try{assert.equal(request(a,'profile.save',{nickname:own(a).nickname,bio:'실패한 변경'},'FIX59-SIGNED-FAIL').reason,'STORAGE_SAVE_FAILED');}finally{database.SaveDatabase=save;}
 assert.equal(snapshot(),saveBefore);assert.ok([b,other].every(peer=>peer.lines.length===0));
 assert.equal(request(a,'history.record',{route:'feed'}).ok,true);assert.ok([b,other].every(peer=>peer.lines.length===0),'navigation history does not broadcast to unrelated clients');
 console.log('FIX59 READ RESPONSE PASS: authenticated viewer/query-specific content tags, unrelated-revision suppression, privacy/block/deletion checks before cache matching, reactions/profile/unread/rules invalidation, compact signed responses, cached currency reads without broadcasts/network, committed-only signed events and rollback/replay.');
}finally{Date.now=realNow;global.fetch=realFetch;fs.rmSync(temp,{recursive:true,force:true});}
