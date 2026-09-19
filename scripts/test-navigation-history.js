'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const zlib=require('node:zlib');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix54-history-profiles-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX54-HISTORY-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX54-HISTORY-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX54-HISTORY-REQUEST-'+(++seq)){
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
let done=false;process.once('exit',()=>{if(!done)process.exitCode=1;});
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const [a,b,a2]=[await login(),await login(),await login()];
 a2.c.installationDeviceKey=require('../identity/identityManager').FindClientDeviceKey(a.c.clientId);
 const pa=(await run(a,'me')).profile,pb=(await run(b,'me')).profile;
 const history=require('../services/member/history'),commerce=require('../services/member/commerce');
 assert.deepEqual(history.Read(store.ProfileById(pa.id)),{recentProducts:[],recentServices:[]});
 await run(a,'history.record',{route:'support'});await run(a,'history.record',{route:'settings'});
 assert.deepEqual((await run(a2,'history')).recentServices.map(x=>x.route),['settings','support']);
 assert.deepEqual((await run(b,'history')).recentServices,[]);
 for(const body of [{route:'member|'+pb.id},{route:'https://example.test'},{route:'__proto__'},{route:'settings',accountId:pb.id},{route:'settings',at:1}])
  assert.equal((await request(a,'history.record',body)).reason,'INPUT_INVALID');
 const before=structuredClone(history.Read(store.ProfileById(pa.id))),revision=store.DB().revision;
 for(let i=0;i<3;i++){await run(a,'history');await run(a,'history.record',{route:'settings'});}
 assert.deepEqual(history.Read(store.ProfileById(pa.id)),before);
 assert.equal(store.DB().revision,revision,'history refresh and repeated newest navigation are read-only');
 const routes=Object.keys(history.SERVICES).slice(0,25);
 for(const route of routes)await run(a,'history.record',{route});
 const services=(await run(a,'history')).recentServices;
 assert.equal(services.length,20);assert.deepEqual(services.map(x=>x.route),routes.slice(-20).reverse());
 await run(a,'history.record',{route:services[5].route});
 const moved=(await run(a,'history')).recentServices;assert.equal(moved[0].route,services[5].route);assert.equal(new Set(moved.map(x=>x.route)).size,20);
 const products=[];
 for(let i=0;i<23;i++)products.push(commerce.SaveProduct({title:'최근 본 상품 '+i,description:'이용권',genre:'게임',accessType:'TYPE1',published:true,plans:[{days:1,price:100}]}));
 await run(a,'catalog',{summary:true});await run(a,'product',{id:products[0].id,countView:false});await run(a,'product',{id:products[1].id});
 assert.deepEqual((await run(a,'history')).recentProducts,[],'previews and implicit reads never add history');
 for(const product of products)await run(a,'product',{id:product.id,countView:true});
 let viewed=(await run(a2,'history')).recentProducts;
 assert.equal(viewed.length,20);assert.deepEqual(viewed.map(x=>x.id),products.slice(-20).reverse().map(x=>x.id));
 const opened=structuredClone(viewed);
 await run(a,'product',{id:products[5].id,countView:false});await run(a,'product',{id:products[22].id,countView:true});
 assert.deepEqual((await run(a,'history')).recentProducts,opened,'refresh or repeated newest detail cannot change recency');
 await run(a,'product',{id:products[5].id,countView:true});viewed=(await run(a,'history')).recentProducts;
 assert.equal(viewed[0].id,products[5].id);assert.equal(new Set(viewed.map(x=>x.id)).size,20);
 store.Atomic(()=>{store.DB().products[products[5].id].published=false;store.DB().products[products[22].id].deleted=true;});
 for(const product of [products[5],products[22]])assert.equal((await request(a,'product',{id:product.id,countView:true})).reason,'PRODUCT_UNAVAILABLE');
 viewed=(await run(a,'history')).recentProducts;assert.ok(viewed.every(x=>![products[5].id,products[22].id].includes(x.id)));
 assert.deepEqual((await run(b,'history')).recentProducts,[]);
 assert.equal((await run(b,'member',{id:pa.id})).profile.recentHistory,undefined,'history never leaks through public profiles');
 a.c.biometricVerified=false;assert.equal((await request(a,'history.record',{route:'support'})).reason,'MEMBER_AUTH_REQUIRED');a.c.biometricVerified=true;
 const preserved=history.Read(store.ProfileById(pa.id)),save=db.SaveDatabase;
 try{db.SaveDatabase=()=>false;assert.equal((await request(a,'history.record',{route:'support'})).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save;}
 assert.deepEqual(history.Read(store.ProfileById(pa.id)),preserved,'failed save rolls history back');
 assert.equal(db.SaveDatabase(),true);store.Import({memberHub:store.Empty()});db.LoadDatabase();
 assert.deepEqual(history.Read(store.ProfileById(pa.id)),preserved,'server restart restores private bounded history');
 assert.deepEqual(history.Read(store.ProfileById(pb.id)),{recentProducts:[],recentServices:[]});
 console.log('FIX54 history PASS: signed authenticated multi-device history, account isolation, whitelist validation, 20-entry bounds, explicit detail opens, refresh no-ops, unavailable filtering, rollback and disk reload.');done=true;
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
