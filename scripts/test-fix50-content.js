'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix50-content-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),store=require('../services/member/store'),hub=require('../services/member/service'),database=require('../storage/database'),lm=require('../license/licenseManager'),build=require('../services/buildGate');
const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
const original=fs.readFileSync(root+'/public/index.html','utf8');
const dom=new JSDOM(original.replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,''),{url:'https://fixture.invalid',runScripts:'outside-only',virtualConsole:vc});
const w=dom.window;w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;w.matchMedia=()=>({matches:false,addListener(){}});w.EventSource=class{addEventListener(){}close(){}};
const calls=[];
w.fetch=async(url,options={})=>{
 if(url==='/api/session')return {status:200,ok:true,text:async()=>JSON.stringify({role:'admin',csrf:'TEST',expiresAt:Date.now()+100000})};
 const req=require('node:stream').Readable.from(options.body?[Buffer.from(options.body)]:[]);Object.assign(req,{url,method:options.method||'GET',headers:{},socket:{remoteAddress:'127.0.0.1'}});
 let status,response;await require('../web/webApi').HandleApiRequest(req,{writeHead(n){status=n;},end(t){response=t;}},{role:'admin',id:'FIX50-CONTENT'});
 calls.push({url,status,body:options.body?JSON.parse(options.body):null});return {status,ok:status>=200&&status<300,text:async()=>response};
};
for(const m of original.matchAll(/<script src="\/([^?]+)\?/g))new vm.Script(fs.readFileSync(root+'/public/'+m[1],'utf8')).runInContext(dom.getInternalVMContext());
Object.defineProperty(w.document,'hidden',{get:()=>false});
const pause=()=>new Promise(resolve=>setTimeout(resolve,35));
const click=async selector=>{const element=w.document.querySelector(selector);assert.ok(element,selector);element.click();await pause();};
const field=(name,value)=>{const input=w.document.querySelector('[data-modal-field="'+name+'"]');assert.ok(input,name);input.value=value;};
const admin=(action,body)=>hub.AdminWrite(action,body,'FIX50-CONTENT');
let seq=0;const c={type:'client',clientId:'5050505050505050',connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:'FIX50-CONTENT-CLIENT',deviceAuthChallengeId:'FIX50-CONTENT-AUTH',socket:{destroyed:false,write(){return true;}}};
state.clients.set(c.clientId,c);state.clientIdentities.set(c.installationDeviceKey,{id:c.clientId,serverId:'',createdAt:Date.now()});state.deviceAuthStatus.set('CLIENT:'+c.clientId,{verified:true,verifiedAt:Date.now()});state.deviceSecrets.set('CLIENT:'+c.clientId,crypto.randomBytes(32).toString('hex'));
c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=c.clientId;
const run=(action,body={},id)=>hub.Execute(c,id||'FIX50-CONTENT-'+(++seq),action,body);
const privateFields=['image','imageFeed','imageThumb','imagePreview','details'];
function noRetired(row){for(const key of privateFields)assert.equal(Object.hasOwn(row,key),false,'retired field '+key);}
function noGameRetired(row){for(const key of ['imageFeed','imageThumb','imagePreview','details'])assert.equal(Object.hasOwn(row,key),false,'retired game field '+key);assert.equal(typeof row.imageCover,'string');}
function categoryLabel(text){const label=w.document.querySelector('.member-category-label');assert.ok(label);assert.equal(label.textContent,text);const icon=label.querySelector('svg');assert.ok(icon);assert.equal(icon.getAttribute('stroke'),'currentColor');assert.equal(icon.getAttribute('fill'),'none');assert.equal(w.document.querySelector('.member-category-badge,[data-category-tone]'),null);}
function gamePhoto(genre,parent=w.document){assert.equal(parent.querySelector('.member-game-icon,.member-category-label,.member-category-badge,[data-category-tone]'),null);assert.equal(parent.querySelector('.member-game-genre').textContent,genre);assert.ok(parent.querySelector('.member-game-photo'));}
(async()=>{try{
 await pause();
 const customGenre=w.document.createElement('tbody');customGenre.innerHTML=w.memberRow({id:'CUSTOM',title:'자유 장르',genre:'constructor',accessType:'TYPE1',plans:[]},'products');gamePhoto('constructor',customGenre);assert.equal(customGenre.querySelector('svg'),null);
 // The real editor has only the retained game fields and a selectable required genre.
 await click('[data-view="member-products"]');await click('[data-member-action="product.new"]');
 assert.deepEqual([...w.document.querySelectorAll('[data-modal-field]')].map(x=>x.dataset.modalField),['title','image','description','genre','accessType','published']);
 assert.ok(w.document.querySelector('[data-modal-image="image"]'));assert.equal(w.document.querySelector('.modal-section'),null);
 field('title','텍스트 게임');field('description','게임 안내\n'+ '긴 소개 '.repeat(60));field('genre','레이싱');field('published','true');
 const firstPlan=w.document.querySelector('[data-plan-row]');firstPlan.querySelector('[data-plan-days]').value='3';firstPlan.querySelector('[data-plan-price]').value='300';
 await click('#modal-confirm');await pause();
 let game=Object.values(store.DB().products)[0];assert.ok(game);assert.equal(game.genre,'레이싱');assert.equal(game.plans[0].days,3);assert.equal(game.plans[0].price,300);assert.equal(game.image,'');assert.equal(game.details,undefined);gamePhoto('레이싱');
 const saveCall=calls.filter(x=>x.body?.action==='product.save').at(-1);assert.equal(saveCall.body.image,'');assert.equal(saveCall.body.details,undefined);
 const legacy={image:'legacy-original-bytes',imageFeed:'legacy-feed-bytes',imageThumb:'legacy-thumbnail-bytes',imagePreview:'legacy-preview-bytes',details:{genre:'레이싱',developer:'보존 제작사',platform:'보존 플랫폼',channels:{official:'https://example.invalid'},extra:['unchanged']}};
 store.Atomic(()=>Object.assign(store.DB().products[game.id],structuredClone(legacy)));
 await w.renderMember();assert.equal(w.document.querySelector('.member-content-thumb'),null);await click('[data-member-action="product.edit"]');field('title','수정한 텍스트 게임');field('genre','퍼즐');await click('#modal-confirm');
 game=store.DB().products[game.id];for(const key of privateFields)assert.deepEqual(game[key],legacy[key]);gamePhoto('퍼즐');
 for(const genre of ['', ' '.repeat(3)])assert.throws(()=>admin('product.save',{id:game.id,title:game.title,accessType:game.accessType,genre,published:true}),/INPUT_INVALID/);
 const omittedGenre=admin('product.save',{title:'이전 형식의 새 게임',accessType:'TYPE1'});assert.equal(omittedGenre.genre,'게임');noGameRetired(omittedGenre);
 // All public and administrator projections retain only top-level genre and text.
 for(const row of [hub.AdminRead({view:'products'}).items.find(x=>x.id===game.id),hub.AdminRead({view:'products',id:game.id}).items[0],run('product',{id:game.id}).product,run('catalog').items[0],run('catalog',{summary:true}).items[0]]){noGameRetired(row);assert.equal(row.genre,'퍼즐');assert.ok(row.description);assert.ok(row.plans.some(p=>p.days===3&&p.price===300&&p.available));}
 assert.equal(run('catalog',{summary:true}).items[0].description,game.description.replace(/\s+/g,' ').trim().slice(0,140));assert.equal(run('product',{id:game.id}).product.description,game.description);
 // Normalized legacy UPDATE news stays visible and editable as NOTICE.
 const news=admin('news.save',{title:'이전 소식',body:'보존할 본문',category:'NOTICE',published:true});
 store.Atomic(()=>Object.assign(store.DB().news[news.id],{category:'UPDATE',...structuredClone(legacy)}));
 assert.equal(run('news',{category:'NOTICE'}).items.find(x=>x.id===news.id).category,'NOTICE');
 assert.equal(run('article',{id:news.id}).article.category,'NOTICE');assert.equal(hub.AdminRead({view:'news',category:'NOTICE'}).items[0].category,'NOTICE');
 await click('[data-view="member-news"]');categoryLabel('공지');assert.equal(w.document.querySelector('.member-content-thumb'),null);await click('[data-member-action="news.edit"]');
 const choices=w.document.querySelector('[data-modal-field="category"]');assert.deepEqual([...choices.options].map(x=>x.value),['NOTICE','ALERT','EVENT']);assert.equal(choices.value,'NOTICE');assert.equal(w.document.querySelector('[data-modal-image]'),null);
 field('body','수정한 보존 본문');await click('#modal-confirm');assert.equal(store.DB().news[news.id].category,'NOTICE');assert.equal(store.DB().news[news.id].deleted,false);assert.equal(Object.keys(store.DB().news).length,1);for(const key of privateFields)assert.deepEqual(store.DB().news[news.id][key],legacy[key]);
 for(const category of ['NOTICE','ALERT','EVENT'])assert.equal(admin('news.save',{title:category,body:'허용 분류',category,published:true}).category,category);
 const invalid=await w.fetch('/api/member/action',{method:'POST',body:JSON.stringify({action:'news.save',title:'새 업데이트',body:'지원하지 않음',category:'UPDATE',published:true})});assert.equal(invalid.status,400);
 assert.throws(()=>admin('news.save',{id:news.id,title:'잘못된 분류 수정',body:'본문',category:'UPDATE',published:true}),/CATEGORY_INVALID/);
 store.Atomic(()=>{store.DB().news[news.id].category='UPDATE';});assert.equal(admin('news.save',{id:news.id,title:'이전 클라이언트 저장',body:'본문',category:'UPDATE',published:true}).category,'NOTICE');
 for(const row of [run('news').items.find(x=>x.id===news.id),run('article',{id:news.id}).article,hub.AdminRead({view:'news',id:news.id}).items[0]])noRetired(row);
 // Purchase, first use and an active QR-bound Build lease survive ordinary game edits.
 const profile=store.Account(c);store.Atomic(()=>store.Ledger(profile,5000,'QR_TOPUP','FIX50-CONTENT-FUND'));
 const quote={productId:game.id,days:3,price:300,revision:game.revision};
 const purchase=run('purchase',quote,'FIX50-CONTENT-PURCHASE');assert.equal(purchase.profile.balance,4700);assert.equal(purchase.order.days,3);assert.equal(purchase.order.accessType,'TYPE1');assert.deepEqual(run('purchase',quote,'FIX50-CONTENT-PURCHASE'),purchase);
 const active=run('order.activate',{orderId:purchase.order.id});assert.equal(active.order.status,'ACTIVE');assert.equal(require('../services/member/entryPass').ForClient(c).accessType,'TYPE1');
 const serverId='5151515151515151';state.clientIdentities.get(c.installationDeviceKey).serverId=serverId;c.serverId=serverId;state.servers.set(serverId,{type:'server',serverId,connected:true,registered:true,deviceAuthVerified:true,clients:new Set([c.clientId]),socket:{destroyed:false,write(){return true;}}});state.deviceAuthStatus.set('SERVER:'+serverId,{verified:true,verifiedAt:Date.now()});state.deviceCapabilities.set('SERVER:'+serverId,new Set(['BUILD_SESSION_LEASE']));state.deviceSecrets.set('SERVER:'+serverId,crypto.randomBytes(32).toString('hex'));
 const queued=build.Queue(c,'FIX50-CONTENT-BUILD');assert.equal(queued.ok,true);assert.equal(build.Complete(c.clientId,'FIX50-CONTENT-BUILD').ok,true);
 const lease=structuredClone(build.ActiveSessionForClient(c.clientId)),order=structuredClone(store.DB().orders[purchase.order.id]),license=structuredClone(state.licenses.get(c.licenseKey));
 const edited=admin('product.save',{id:game.id,revision:game.revision,title:'이용 중인 게임 소개 수정',description:'새 텍스트',genre:'액션',accessType:'TYPE1',published:true});noGameRetired(edited);
 assert.deepEqual(build.ActiveSessionForClient(c.clientId),lease);assert.deepEqual(store.DB().orders[purchase.order.id],order);assert.deepEqual(state.licenses.get(c.licenseKey),license);assert.equal(store.ProfileById(profile.id).activeOrderId,order.id);
 for(const key of privateFields)assert.deepEqual(store.DB().products[game.id][key],legacy[key]);
 const before=JSON.stringify(store.DB()),save=database.SaveDatabase;try{database.SaveDatabase=()=>false;assert.throws(()=>admin('product.save',{...edited,title:'실패한 저장'}),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}assert.equal(JSON.stringify(store.DB()),before);
 const snapshot=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(snapshot),true);for(const table of ['products','news'])for(const key of privateFields)assert.deepEqual(store.DB()[table][table==='products'?game.id:news.id][key],legacy[key]);
 const style=w.document.createElement('style');style.textContent=fs.readFileSync(root+'/public/admin-member.css','utf8');w.document.head.append(style);for(const theme of ['light','dark']){w.document.documentElement.dataset.theme=theme;assert.equal(w.getComputedStyle(w.document.querySelector('.member-category-label')).backgroundColor,'rgba(0, 0, 0, 0)');}
 assert.equal(errors.length,0,errors.join('\n'));assert.ok(!calls.some(x=>x.status>=500));
 console.log('FIX50 CONTENT PASS: actual admin choices/editors, UPDATE display/filter/save migration, genre selection and omitted-genre compatibility, text previews, all API privacy projections, legacy data rollback/import, real purchase idempotency and unchanged active QR-bound Build lease');
}finally{w.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
