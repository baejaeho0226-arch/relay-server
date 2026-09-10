'use strict';
const {JSDOM,VirtualConsole}=require('jsdom'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../public'),errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
const dom=new JSDOM('<!doctype html><html><body><form><label>사진<input id="photo" type="file" aria-label="소식 사진 선택"></label><input id="qr" class="visually-hidden" type="file"><button type="reset">초기화</button></form></body></html>',{runScripts:'outside-only',virtualConsole:vc});
const w=dom.window,d=w.document;const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
w.eval(fs.readFileSync(path.join(root,'admin-controls.js'),'utf8'));
(async()=>{try{
 await tick();const photo=d.querySelector('#photo'),button=d.querySelector('.control-file-button'),name=d.querySelector('.control-file-name');
 assert.equal(d.querySelectorAll('.control-file').length,1);assert.equal(button.getAttribute('aria-label'),'소식 사진 선택');assert.equal(name.textContent,'선택한 파일이 없습니다');
 let clicks=0,changes=0;photo.addEventListener('click',()=>clicks++);photo.addEventListener('change',()=>changes++);button.click();assert.equal(clicks,1,'label and button do not launch two pickers');
 Object.defineProperty(photo,'files',{configurable:true,value:[new w.File(['image'],'사진 <script>.jpg',{type:'image/jpeg'})]});photo.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(changes,1);assert.equal(name.textContent,'사진 <script>.jpg');assert.equal(d.querySelectorAll('script').length,0);
 photo.dispatchEvent(new w.Event('cancel'));assert.equal(name.textContent,'사진 <script>.jpg');photo.disabled=true;await tick();assert.equal(button.disabled,true);button.click();assert.equal(clicks,1);
 photo.disabled=false;await tick();assert.equal(button.disabled,false);
 const modal=d.createElement('section');modal.innerHTML='<label>배포 파일<input type="file" accept=".apk,.zip" multiple></label>';d.body.append(modal);await tick();assert.equal(modal.querySelectorAll('.control-file').length,1);assert.equal(modal.querySelector('input').accept,'.apk,.zip');assert.equal(modal.querySelector('input').multiple,true);
 const input=modal.querySelector('input');input.dispatchEvent(new w.Event('change',{bubbles:true}));await tick();assert.equal(modal.querySelectorAll('.control-file').length,1,'observer does not duplicate controls');
 Object.defineProperty(photo,'files',{value:[]});d.querySelector('form').reset();await tick();assert.equal(name.textContent,'선택한 파일이 없습니다');
 const style=d.createElement('style');style.textContent=fs.readFileSync(path.join(root,'admin-controls.css'),'utf8');d.head.append(style);assert.ok(style.sheet.cssRules.length>30);assert.equal(errors.length,0,errors.join('\n'));
 console.log('Web controls PASS: dynamic upload dialogs, single picker activation, preserved original inputs/change handlers, safe filenames, disabled and cancel/reset states, QR custom control preservation and CSS parsing.');
}finally{w.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
