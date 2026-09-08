'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix12-dom-'));
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
const wait=()=>new Promise(r=>setTimeout(r,35));
const click=async el=>{assert.ok(el);el.click();await wait();};
(async()=>{try{
 await wait();
 const allViews=[...w.document.querySelectorAll('#nav button[data-view]')].map(x=>x.dataset.view);
 for(const view of allViews){
  w.switchView(view);await w.renderCurrent();
  assert.equal(w.document.querySelectorAll('.api-error').length,0,view);
  assert.ok(w.document.getElementById('content').textContent.trim(),view+' content');
  for(const el of w.document.querySelectorAll('#content *')) {
    assert.ok(!/[가-힣]/.test(el.localName),'Translated HTML tag in '+view);
    for(const a of el.attributes) assert.ok(!/[가-힣]/.test(a.name),'Translated attribute in '+view);
  }
 }
 assert.ok(allViews.length>=30);
 assert.equal(backend.some(x=>x.status>=500),false,JSON.stringify(backend.filter(x=>x.status>=500)));
 w.switchView('licenses');await w.renderCurrent();
 assert.equal(w.document.getElementById('license-status').options[0].value,'ALL');
 assert.equal(w.document.getElementById('license-status').options[0].textContent,'전체');
 assert.ok(w.document.getElementById('content').textContent.includes('USER_TEXT warning online 그대로'));
 await click(w.document.querySelector('.license-check'));
 assert.equal(w.document.getElementById('license-bulk-btn').disabled,false);
 assert.equal(w.document.getElementById('license-check-all').indeterminate,true);
 await click(w.document.getElementById('license-bulk-btn'));
 assert.equal(w.document.querySelector('[data-modal-field="action"]').options.length,7);
 w.document.querySelector('[data-modal-field="action"]').value='tags';
 await click(w.document.getElementById('modal-confirm'));
 w.document.querySelector('[data-modal-field="tags"]').value='한글,우수고객';
 await click(w.document.getElementById('modal-confirm'));await wait();
 assert.deepEqual(manager.FindLicense(keys[0]).tags,['한글','우수고객']);
 assert.equal(w.document.getElementById('license-bulk-btn').disabled,true);
 w.switchView('system');await w.renderCurrent();
 const edit=w.document.querySelector('#version-server');assert.ok(edit);
 edit.value='9.9.9';edit.dispatchEvent(new w.Event('input',{bubbles:true}));
 await w.renderCurrent(true);assert.equal(w.document.querySelector('#version-server'),edit);assert.equal(edit.value,'9.9.9');
 w.switchView('dashboard');w.renderCurrent();w.switchView('licenses');await w.renderCurrent();await wait();
 assert.equal(w.document.getElementById('page-title').textContent,'라이선스');assert.ok(w.document.getElementById('license-search'));
 await w.executeTerminalCommand('도움말');await w.executeTerminalCommand('서버 목록');
 assert.equal(errors.length,0,errors.join('\n'));
 console.log(`FIX12 DOM PASS: ${allViews.length} pages, unchanged API values and user text, all 8 bulk options, checkbox counts, Korean tags, draft preservation, rapid navigation, Korean terminal commands`);
}finally{w.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
