'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix21-refresh-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const state=require('../core/state'),store=require('../services/member/store'),db=require('../storage/database');
const closed=[],peers=[];let seq=0;
const server=net.createServer(socket=>{closed.push(new Promise(resolve=>socket.once('close',resolve)));require('../core/connection').CreateConnection(socket);});
function connect(){return new Promise((resolve,reject)=>{
 const socket=net.createConnection({port:server.address().port,host:'127.0.0.1'}),lines=[],waiters=[];let buffer='';
 const peer={socket,send:line=>socket.write(line+'\n'),wait(prefix){const i=lines.findIndex(x=>x.startsWith(prefix));if(i>=0)return Promise.resolve(lines.splice(i,1)[0]);return new Promise((res,rej)=>{const item={prefix,res,rej,timer:setTimeout(()=>rej(Error('Timeout: '+prefix)),4000)};waiters.push(item);});},close(){for(const w of waiters){clearTimeout(w.timer);w.rej(Error('Connection closed'));}waiters.length=0;socket.destroy();}};
 peers.push(peer);socket.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line.startsWith('PING|')){peer.send(line.replace('PING|','PONG|'));continue;}const n=waiters.findIndex(x=>line.startsWith(x.prefix));if(n<0)lines.push(line);else{const w=waiters.splice(n,1)[0];clearTimeout(w.timer);w.res(line);}}});
 socket.once('error',reject);socket.once('connect',()=>resolve(peer));
});}
function mac(p,prefix,fields){return crypto.createHmac('sha256',p.secret).update([prefix,p.c.clientId,p.c.deviceAuthChallengeId,...fields].join('|')).digest('hex').toUpperCase();}
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX21-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX21-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX21-REQUEST-'+(++seq)){
 const encoded=Buffer.from(JSON.stringify(body)).toString('base64');p.send(['HUB',id,action,encoded,mac(p,'HUB',[id,action,encoded])].join('|'));
 const pieces=[];let total;
 do{const parts=(await p.wait('HUB_CHUNK|'+id+'|')).split('|');assert.equal(parts[2],action);assert.equal(parts[6],mac(p,'HUB_RESPONSE',parts.slice(1,6)));total=Number(parts[4]);pieces[Number(parts[3])]=parts[5];}while(pieces.filter(Boolean).length<total);
 return JSON.parse(Buffer.from(pieces.join(''),'base64').toString());
}
async function run(p,action,body,id){const r=await request(p,action,body,id);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}
async function changed(p,revision){for(;;){const parts=(await p.wait('HUB_EVENT|')).split('|');assert.equal(parts[2],mac(p,'HUB_EVENT',[parts[1]]));if(Number(parts[1])>=revision)return;}}
function avatar(color){const {PNG}=require('pngjs'),png=new PNG({width:64,height:64});for(let i=0;i<png.data.length;i+=4){png.data[i]=color;png.data[i+1]=240-color;png.data[i+2]=90;png.data[i+3]=255;}return 'data:image/png;base64,'+PNG.sync.write(png).toString('base64');}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const author=await login(),viewer=await login();
 const a=(await run(author,'me')).profile,b=(await run(viewer,'me')).profile,hub=require('../services/member/service');
 const save=(action,body)=>hub.AdminWrite(action,body,'TEST');
 const news=save('news.save',{title:'사진 공지',body:'열람해야 보는 공지 내용',category:'NOTICE',image:avatar(55),published:true});
 const list=await run(viewer,'news',{summary:true});assert.equal(list.items[0].body,undefined);assert.equal(list.items[0].image,undefined);assert.equal(list.items[0].views,0);assert.ok(list.items[0].imageThumb.startsWith('data:image/jpeg;'));assert.equal(list.viewer.id,b.id);
 const detail=await run(viewer,'article',{id:news.id});assert.equal(detail.article.body,news.body);assert.equal(detail.article.image,news.image);assert.equal(detail.article.views,1);
 assert.equal((await run(viewer,'article',{id:news.id})).article.views,1,'polling must not increase article views');
 assert.equal((await run(author,'article',{id:news.id})).article.views,2);
 const viewedNews=await run(viewer,'news',{summary:true});assert.equal(viewedNews.items.find(x=>x.id===news.id).views,2);assert.equal(viewedNews.items.find(x=>x.id===news.id).body,undefined);assert.equal(viewedNews.items.find(x=>x.id===news.id).unread,false);
 assert.equal((await run(viewer,'news',{summary:true})).items.find(x=>x.id===news.id).views,2,'listing only reads the current view count');
 const privateNews=save('news.save',{title:'개인 공지',body:'개인 본문',category:'ALERT',image:avatar(20),audience:a.id,published:true});assert.equal((await request(viewer,'article',{id:privateNews.id})).reason,'NEWS_NOT_FOUND');assert.ok(!(await run(viewer,'news',{summary:true})).items.some(x=>x.id===privateNews.id));
 const gameDetails={releaseDate:'2005.8.1',developer:'제작 테스트',publisher:'배급 테스트',genre:'레이싱 / PC',ageRating:'전체 이용가',language:'한국어',platform:'Windows',channels:{official:'https://example.com/game',instagram:'https://example.com/social',twitter:'',facebook:'',youtube:''},requirements:{minimum:{os:'Windows 10',cpu:'Core2 Duo',ram:'4GB',gpu:'GPU 예시'},recommended:{os:'Windows 11',cpu:'권장 CPU',ram:'8GB',gpu:'권장 GPU'}}};
 delete gameDetails.requirements;
 const imageData=Buffer.alloc(480*640*4);for(let y=0;y<640;y++)for(let x=0;x<480;x++){const i=(y*480+x)*4;imageData[i]=(x*3+y)%256;imageData[i+1]=(x+y*2)%256;imageData[i+2]=(x*y)%256;imageData[i+3]=255;}
 const gameImage='data:image/jpeg;base64,'+require('jpeg-js').encode({width:480,height:640,data:imageData},60).data.toString('base64');assert.ok(gameImage.length>12000);
 const game=save('product.save',{title:'배너 게임',description:'게임 안내',accessType:'TYPE1',image:gameImage,details:gameDetails,plans:[1,7,15,30].map(days=>({days,price:days*100})),published:true});
 async function webAction(role,body){const req=require('node:stream').Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:'/api/member/action',method:'POST',headers:{},socket:{remoteAddress:'127.0.0.1'}});let status,payload;await require('../web/webApi').HandleApiRequest(req,{writeHead(value){status=value;},end(value){payload=JSON.parse(value);}},{role,id:'MEDIA21'});return {status,payload};}
 const bigBody={action:'product.save',id:game.id,revision:game.revision,title:'큰 사진 웹 저장',description:'사진 처리 확인',accessType:'TYPE1',image:gameImage,details:gameDetails,published:true};
 assert.ok(Buffer.byteLength(JSON.stringify(bigBody))>128*1024,'exercise the increased bounded admin image body limit');
 assert.equal((await webAction('operator',bigBody)).status,403);assert.equal((await webAction('admin',bigBody)).status,200);game.revision=store.DB().products[game.id].revision;
 const product=(await run(viewer,'product',{id:game.id})).product;assert.ok(product.image.length>12000,'photo detail uses signed chunk transport');assert.deepEqual(product.details,Object.fromEntries(Object.entries(gameDetails).filter(([k])=>k!=='channels')));assert.equal((await run(viewer,'catalog')).items[0].image,undefined);assert.ok(product.imageThumb.length<=16100);
 const summaryGame=(await run(viewer,'catalog',{summary:true})).items.find(x=>x.id===game.id);assert.equal(summaryGame.description,undefined);assert.equal(summaryGame.details.platform,'Windows');assert.ok(summaryGame.imagePreview);assert.equal(product.description,'사진 처리 확인');
 const preserved=save('product.save',{id:game.id,revision:game.revision,title:'제목 수정',description:'',accessType:'TYPE1',published:true});assert.deepEqual(store.DB().products[game.id].details,Object.fromEntries(Object.entries(gameDetails).filter(([k])=>k!=='channels')));assert.equal(store.DB().products[game.id].image,product.image);
 const before=JSON.stringify(store.DB()),saveDb=db.SaveDatabase;try{db.SaveDatabase=()=>false;assert.throws(()=>save('news.save',{...news,title:'실패',image:''}),/STORAGE_SAVE_FAILED/);}finally{db.SaveDatabase=saveDb;}assert.equal(JSON.stringify(store.DB()),before);
 for(const image of ['data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,AAAA','https://example.com/photo.png'])assert.throws(()=>save('news.save',{title:'잘못된 사진',body:'본문',category:'NOTICE',image}),/CONTENT_IMAGE_INVALID/);
 assert.equal(require('../services/member/media').GameDetails({channels:{official:'javascript:alert(1)'}}).channels,undefined);
 const updated=save('news.save',{...news,image:''});assert.equal(updated.image,'');assert.equal(updated.imageThumb,'');
 const post=(await run(author,'post.create',{body:'회원 상세에서 여는 게시물'})).post;await run(viewer,'feed');await run(viewer,'follow.set',{id:a.id,following:true});
 const member=await run(viewer,'member',{id:a.id});assert.equal(member.profile.id,a.id);assert.equal(member.viewer.id,b.id);assert.equal(member.isFollowing,true);assert.equal(member.own,false);assert.equal(member.profile.followers,1);assert.equal(member.posts.items[0].id,post.id);assert.ok(member.profile.views>=1);assert.ok(member.profile.handle.startsWith('user_'));
 for(const privateKey of ['balance','subject','activeOrderId','readNews','blocked'])assert.equal(member.profile[privateKey],undefined,privateKey);
 assert.equal((await run(viewer,'follows',{id:a.id,mode:'followers'})).items[0].id,b.id);
 await run(viewer,'report',{postId:post.id,reason:'신고 동작 확인'});assert.equal(Object.values(store.DB().reports).length,1);
 save('profile.block',{id:a.id,blocked:true});assert.equal((await request(viewer,'member',{id:a.id})).reason,'MEMBER_NOT_FOUND');assert.equal((await request(viewer,'follows',{id:a.id,mode:'followers'})).reason,'MEMBER_NOT_FOUND');
 const snapshot=db.BuildDatabaseObject();assert.equal(db.ImportDatabaseObject(snapshot),true);assert.equal(store.DB().products[game.id].image,product.image);assert.deepEqual(store.DB().products[game.id].details,Object.fromEntries(Object.entries(gameDetails).filter(([k])=>k!=='channels')));
 console.log('FIX21 CONTENT TCP PASS: summary privacy, authorized article photos and deduplicated views, signed large photo chunks, metadata preservation/validation, save rollback, public member profile/follow lists and reports');
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
