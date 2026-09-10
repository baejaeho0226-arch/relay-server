/* Shared file fields keep the original input, validation and change handlers. */
(() => {
 'use strict';
 const states=new WeakMap();
 function sync(input){
  const state=states.get(input);if(!state)return;
  const files=Array.from(input.files||[]);
  state.name.textContent=files.length?files.map(file=>file.name).join(', '):'선택한 파일이 없습니다';
  state.name.title=state.name.textContent;state.button.disabled=input.disabled;
  state.wrapper.classList.toggle('is-disabled',input.disabled);
 }
 function enhance(root){
  if(!root.querySelectorAll)return;
  const inputs=[...(root.matches?.('input[type="file"]')?[root]:[]),...root.querySelectorAll('input[type="file"]')];
  for(const input of inputs){
   if(states.has(input)||input.hidden||input.classList.contains('visually-hidden'))continue;
   const wrapper=document.createElement('span'),button=document.createElement('button'),name=document.createElement('span');
   wrapper.className='control-file';button.className='control-file-button';button.type='button';button.textContent='파일 선택';
   button.setAttribute('aria-label',input.getAttribute('aria-label')||'파일 선택');
   name.className='control-file-name';name.setAttribute('aria-live','polite');
   input.before(wrapper);wrapper.append(input,button,name);input.classList.add('control-file-input');input.tabIndex=-1;
   button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(!input.disabled)input.click();});
   input.addEventListener('change',()=>sync(input));input.addEventListener('cancel',()=>sync(input));
   states.set(input,{wrapper,button,name});sync(input);
  }
 }
 function start(){
  enhance(document);
  new MutationObserver(changes=>{for(const change of changes){if(change.type==='attributes')sync(change.target);else for(const node of change.addedNodes)if(node.nodeType===1)enhance(node);}})
   .observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
  document.addEventListener('reset',event=>queueMicrotask(()=>{for(const input of event.target.querySelectorAll('input[type="file"]'))sync(input);}));
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
