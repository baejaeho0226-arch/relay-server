'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const zlib=require('node:zlib');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix35-cards-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const state=require('../core/state'),store=require('../services/member/store'),db=require('../storage/database');
const closed=[],peers=[];let seq=0;
const server=net.createServer(socket=>{closed.push(new Promise(resolve=>socket.once('close',resolve)));require('../core/connection').CreateConnection(socket);});
function matches(line,prefix){return prefix.startsWith('RESPONSE|')?/^HUB_(?:Z)?CHUNK\|/.test(line)&&line.split('|')[1]===prefix.slice(9):line.startsWith(prefix);}
function connect(){return new Promise((resolve,reject)=>{
 const socket=net.createConnection({port:server.address().port,host:'127.0.0.1'}),lines=[],waiters=[];let buffer='';
 const peer={socket,send:line=>socket.write(line+'\n'),wait(prefix){const i=lines.findIndex(x=>matches(x,prefix));if(i>=0)return Promise.resolve(lines.splice(i,1)[0]);return new Promise((res,rej)=>{const item={prefix,res,rej,timer:setTimeout(()=>rej(Error('Timeout: '+prefix)),4000)};waiters.push(item);});},close(){for(const w of waiters){clearTimeout(w.timer);w.rej(Error('Connection closed'));}waiters.length=0;socket.destroy();}};
 peers.push(peer);socket.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line.startsWith('PING|')){peer.send(line.replace('PING|','PONG|'));continue;}const n=waiters.findIndex(x=>matches(line,x.prefix));if(n<0)lines.push(line);else{const w=waiters.splice(n,1)[0];clearTimeout(w.timer);w.res(line);}}});
 socket.once('error',reject);socket.once('connect',()=>resolve(peer));
});}
function mac(p,prefix,fields){return crypto.createHmac('sha256',p.secret).update([prefix,p.c.clientId,p.c.deviceAuthChallengeId,...fields].join('|')).digest('hex').toUpperCase();}
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX35-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX35-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX35-REQUEST-'+(++seq)){
 p.c.hubRate=null;const plain=Buffer.from(JSON.stringify(body)),packed=body._wire==='zlib'&&plain.length>24000?zlib.deflateSync(plain,{level:1}):null;
 const compressed=packed&&packed.length<plain.length*.95,encoded=(compressed?packed:plain).toString('base64');
 if(encoded.length>40000||compressed){const total=Math.ceil(encoded.length/12000),prefix=compressed?'HUB_ZUPLOAD':'HUB_UPLOAD';for(let i=0;i<total;i++){const fields=[id,action,String(i),String(total),encoded.slice(i*12000,(i+1)*12000)];p.send([prefix,...fields,mac(p,prefix,fields)].join('|'));}}
 else p.send(['HUB',id,action,encoded,mac(p,'HUB',[id,action,encoded])].join('|'));
 const pieces=[];let total,responseCompressed;
 do{const parts=(await p.wait('RESPONSE|'+id)).split('|');assert.equal(parts[2],action);const zipped=parts[0]==='HUB_ZCHUNK';assert.equal(parts[6],mac(p,zipped?'HUB_ZRESPONSE':'HUB_RESPONSE',parts.slice(1,6)));if(responseCompressed!==undefined)assert.equal(zipped,responseCompressed);responseCompressed=zipped;total=Number(parts[4]);pieces[Number(parts[3])]=parts[5];}while(pieces.filter(Boolean).length<total);
 const result=Buffer.from(pieces.join(''),'base64');p.lastWire={uploadBytes:encoded.length,uploadPlain:plain.length,downloadBytes:pieces.join('').length,compressed:responseCompressed};
 return JSON.parse((responseCompressed?zlib.inflateSync(result,{maxOutputLength:8000000}):result).toString());
}
async function run(p,action,body,id){const r=await request(p,action,body,id);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}
async function changed(p,revision){for(;;){const parts=(await p.wait('HUB_EVENT|')).split('|');assert.equal(parts[2],mac(p,'HUB_EVENT',[parts[1]]));if(Number(parts[1])>=revision)return;}}
function avatar(color){const {PNG}=require('pngjs'),png=new PNG({width:64,height:64});for(let i=0;i<png.data.length;i+=4){png.data[i]=color;png.data[i+1]=240-color;png.data[i+2]=90;png.data[i+3]=255;}return 'data:image/png;base64,'+PNG.sync.write(png).toString('base64');}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const [a,b,c]=[await login(),await login(),await login()],fast={_wire:'zlib',_delta:true};
 const pa=(await run(a,'me')).profile,pb=(await run(b,'me')).profile,pc=(await run(c,'me')).profile;
 const gifData='data:image/gif;base64,'+fs.readFileSync(path.join(__dirname,'fixtures/gallery-animation.gif')).toString('base64');
 const source=(await run(b,'post.create',{...fast,title:'상대 원글',body:'인용할 본문'})).post;
 const text='내 긴 본문입니다. '.repeat(32);
 const mine=(await run(a,'post.create',{...fast,title:'내 카드',body:text,image:avatar(70),gifData,quotePostId:source.id,poll:{question:'고르기',options:['첫째','둘째']}})).post;
 await run(b,'react',{...fast,postId:mine.id,value:1});
 await run(c,'comment.create',{...fast,postId:mine.id,body:'다른 기기의 댓글'});
 await run(a,'poll.vote',{...fast,postId:mine.id,optionId:'0'});
 const feed=(await run(a,'feed',fast)).items.find(p=>p.id===mine.id);
 const page=await run(a,'me',{...fast,postCards:true,offset:0,limit:12});
 assert.equal(page.posts.total,1);assert.equal(page.posts.items[0].id,mine.id);
 const card=page.posts.items[0];
 for(const key of ['title','body','image','gif','poll','quote','own','likes','myReaction','comments','reposts','bookmarked','author'])assert.deepEqual(card[key],feed[key],key);
 assert.equal(card.body,text.trim());assert.ok(card.body.length>140);assert.ok(card.image.startsWith('data:image/'));assert.ok(card.gif.frames.length>1);assert.ok(card.gif.intervals.length>1);
 assert.equal(card.quote.id,source.id);assert.equal(card.likes,1);assert.equal(card.comments,1);assert.equal(card.poll.myVote,'0');
 assert.equal(card.own,true);assert.equal(card.author.id,pa.id);
 const legacy=(await run(a,'me')).posts.items[0];assert.equal(legacy.image,undefined);assert.equal(legacy.author,undefined);assert.ok(legacy.imageThumb);
 const foreign=await run(b,'me',{...fast,postCards:true,id:pa.id,handle:pa.handle});assert.ok(foreign.posts.items.every(p=>p.author.id===pb.id));
 const q={postCards:true,offset:0,limit:12},input={...fast,posts:[mine.id],profiles:[pa.id],scope:'me',query:q};
 let live=await run(a,'live',input);assert.deepEqual(live.scope,page.posts.items.map(p=>p.id+'/'+p.revision));
 await run(c,'react',{...fast,postId:mine.id,value:1});await run(c,'poll.vote',{...fast,postId:mine.id,optionId:'1'});
 live=await run(a,'live',input);assert.equal(live.posts[0].likes,2);assert.equal(live.posts[0].comments,1);assert.equal(live.posts[0].poll.total,2);assert.equal(live.posts[0].poll.myVote,'0');
 assert.deepEqual(live.scope,page.posts.items.map(p=>p.id+'/'+p.revision),'counters do not redownload my-page media');
 const next=(await run(a,'post.edit',{...fast,id:mine.id,revision:0,title:'수정',body:'수정된 본문'})).post;
 assert.notDeepEqual((await run(a,'live',input)).scope,live.scope);
 assert.equal((await run(a,'me',{...fast,postCards:true})).posts.items[0].body,'수정된 본문');
 // Multiple pages and new/deleted cards use the exact same scope order as me.
 for(let i=0;i<13;i++){store.ProfileById(pa.id).last_post=0;await run(a,'post.create',{...fast,body:'내 글 '+i});}
 const second=await run(a,'me',{...fast,postCards:true,offset:12,limit:12});
 const secondLive=await run(a,'live',{...input,query:{postCards:true,offset:12,limit:12}});
 assert.equal(second.posts.items.length,2);assert.deepEqual(secondLive.scope,second.posts.items.map(p=>p.id+'/'+p.revision));
 const zero=await run(c,'me',{...fast,postCards:true});assert.equal(zero.posts.total,0);assert.deepEqual(zero.posts.items,[]);
 // An unblock acknowledgement itself must carry the final empty state.
 await run(a,'follow.set',{...fast,id:pb.id,following:true});
 let block=await run(a,'block.set',{...fast,id:pb.id,blocked:true});assert.equal(block.blocks.total,1);assert.equal(block.blocks.items[0].id,pb.id);
 block=await run(a,'block.set',{...fast,id:pc.id,blocked:true});assert.equal(block.blocks.total,2);
 let unblocked=await run(a,'block.set',{...fast,id:pb.id,blocked:false});assert.equal(unblocked.blocks.total,1);assert.deepEqual(unblocked.blocks.items.map(p=>p.id),[pc.id]);
 const save=db.SaveDatabase;
 try{db.SaveDatabase=()=>false;assert.equal((await request(a,'block.set',{...fast,id:pc.id,blocked:false})).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save;}
 assert.equal((await run(a,'blocks')).total,1);
 unblocked=await run(a,'block.set',{...fast,id:pc.id,blocked:false},'FIX35-LAST-UNBLOCK');
 assert.equal(unblocked.blocks.total,0);assert.deepEqual(unblocked.blocks.items,[]);assert.equal(unblocked.blocks.nextOffset,null);
 assert.deepEqual(await run(a,'block.set',{...fast,id:pc.id,blocked:false},'FIX35-LAST-UNBLOCK'),unblocked);
 assert.equal((await run(a,'blocks')).total,0);
 await run(a,'post.delete',{...fast,id:mine.id});
 const removed=await run(a,'live',input);assert.ok(removed.removedPosts.includes(mine.id));assert.ok(!removed.scope.some(x=>x.startsWith(mine.id+'/')));
 console.log('FIX35 PASS: signed TCP own feed cards, full media/quotes/polls, viewer isolation, live my-page totals, pagination/edit/delete scopes, empty unblock acknowledgement and durable rollback.');
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
