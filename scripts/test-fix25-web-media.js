'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix25-media-dom-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const api=require('../web/webApi'),manager=require('../license/licenseManager');
const keys=[manager.CreateLicense(30,'USER_TEXT warning online 그대로').key,manager.CreateLicense(30,'두 번째').key];
const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
const originalHtml=fs.readFileSync(root+'/public/index.html','utf8');
const dom=new JSDOM(originalHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,''),{url:'https://fixture.invalid',runScripts:'outside-only',virtualConsole:vc});
const w=dom.window;w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;w.matchMedia=()=>({matches:false,addListener(){}});w.EventSource=class{addEventListener(){}close(){}};
const backend=[];
w.fetch=async(url,options={})=>{
 if(url==='/api/session')return {status:200,ok:true,text:async()=>JSON.stringify({role:'admin',csrf:'TEST',expiresAt:Date.now()+100000})};
 const req=require('node:stream').Readable.from(options.body?[Buffer.from(options.body)]:[]);Object.assign(req,{url,method:options.method||'GET',headers:{},socket:{remoteAddress:'127.0.0.1'}});
 let status,text;await api.HandleApiRequest(req,{writeHead(n){status=n;},end(t){text=t;}},{role:'admin',id:'TEST_ADMIN'});
 backend.push({url,status});return {status,ok:status>=200&&status<300,text:async()=>text};
};
for(const m of originalHtml.matchAll(/<script src="\/([^?]+)\?/g))new vm.Script(fs.readFileSync(root+'/public/'+m[1],'utf8')).runInContext(dom.getInternalVMContext());
Object.defineProperty(w.document,'hidden',{get:()=>false});
const wait=()=>new Promise(r=>setTimeout(r,35));
const click=async el=>{assert.ok(el);el.click();await wait();};
(async()=>{try{
 await wait();w.switchView('member-products');await w.renderMember();
 const {PNG}=require('pngjs'),png=new PNG({width:96,height:64});for(let i=0;i<png.data.length;i+=4){png.data[i]=180;png.data[i+1]=100;png.data[i+2]=80;png.data[i+3]=255;}const bytes=PNG.sync.write(png);let loadedData=false;
 // jsdom does not rasterize: image decoding/canvas adapters below use the same
 // PNG/JPEG codecs as the server; FileReader and modal events remain real DOM.
 w.Image=class{set src(value){assert.ok(value.startsWith('data:image/'),'CSP-safe image source');loadedData=true;this.decoded=PNG.sync.read(Buffer.from(value.split(',')[1],'base64'));this.naturalWidth=this.decoded.width;this.naturalHeight=this.decoded.height;queueMicrotask(()=>this.onload());}};
 w.HTMLCanvasElement.prototype.getContext=function(){const canvas=this;return {fillRect(){},drawImage(image){canvas.decoded=image.decoded;}};};
 w.HTMLCanvasElement.prototype.toDataURL=function(){return 'data:image/jpeg;base64,'+require('jpeg-js').encode(this.decoded,80).data.toString('base64');};
 await click(w.document.querySelector('[data-member-action="product.new"]'));
 assert.equal(w.document.querySelector('[data-modal-field="channel_official"]'),null);
 const genre=w.document.querySelector('[data-modal-field="detail_genre"]');assert.equal(genre.tagName,'SELECT');genre.value='RPG';
 const input=w.document.querySelector('[data-modal-image="image"]');Object.defineProperty(input,'files',{value:[new w.File([bytes],'banner.png',{type:'image/png'})]});input.dispatchEvent(new w.Event('change',{bubbles:true}));await wait();await wait();assert.equal(loadedData,true);
 const preview=w.document.querySelector('[data-modal-preview="image"]');assert.equal(preview.hidden,false);assert.ok(preview.src.startsWith('data:image/jpeg;'));await click(preview);assert.ok(preview.classList.contains('media-expanded'));
 const rows=w.document.querySelector('[data-plan-rows]');while(rows.children.length>1)await click(rows.lastElementChild.querySelector('[data-plan-remove]'));
 rows.querySelector('[data-plan-days]').value='45';rows.querySelector('[data-plan-price]').value='4200';await click(w.document.querySelector('[data-plan-add]'));rows.lastElementChild.querySelector('[data-plan-days]').value='45';rows.lastElementChild.querySelector('[data-plan-price]').value='6000';
 w.document.querySelector('[data-modal-field="title"]').value='관리자 배너 테스트';w.document.querySelector('[data-modal-field="published"]').value='true';
 await click(w.document.querySelector('#modal-confirm'));assert.equal(w.document.querySelector('#modal').classList.contains('hidden'),false);assert.ok(w.document.querySelector('[data-plan-error]').textContent.includes('중복'));
 rows.lastElementChild.querySelector('[data-plan-days]').value='90';await click(w.document.querySelector('#modal-confirm'));await wait();
 const s=require('../services/member/store'),game=Object.values(s.DB().products)[0];assert.ok(game.image.startsWith('data:image/jpeg;'));assert.equal(game.details.genre,'RPG');assert.deepEqual(game.plans,[{days:45,price:4200},{days:90,price:6000}]);
 await click(w.document.querySelector('[data-member-action="product.edit"]'));assert.equal(w.document.querySelectorAll('[data-plan-row]').length,2);assert.equal(w.document.querySelector('[data-modal-preview="image"]').hidden,false);await click(w.document.querySelector('#modal-cancel'));
 assert.deepEqual(errors,[]);console.log('FIX25 WEB DOM PASS: CSP-safe FileReader upload, decoded banner preview/expand, genre selection, arbitrary plans add/remove, duplicate prevention before closing, persistence and edit reload.');
}finally{w.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
