 'use strict';
function memberRichHTML(text,ranges){
 try{return MemberBodyFormat.segments(String(text||''),ranges||[]).map(run=>`<span class="body-style-${run.style}">${esc(run.text)}</span>`).join('');}catch(_){return esc(text||'');}
}
function memberRichField(field){
 return `<div class="member-rich-editor" data-rich-editor="${esc(field.name)}"><label>${esc(field.label)}<textarea data-modal-field="${esc(field.name)}" maxlength="2000" placeholder="이야기를 작성하세요">${esc(field.value||'')}</textarea></label><div class="member-rich-tools" role="toolbar" aria-label="본문 글자 서식">${[[1,'굵게','<path d="M7 4h6a4 4 0 0 1 0 8H7zm0 8h7a4 4 0 0 1 0 8H7z"/>'],[2,'기울임꼴','<path d="M10 4h9M5 20h9M15 4 9 20"/>'],[4,'밑줄','<path d="M6 4v7a6 6 0 0 0 12 0V4M4 21h16"/>'],[8,'취소선','<path d="M17 7c-1-4-10-4-10 1 0 2 3 3 5 4m-5 5c1 4 10 4 10-1M4 12h16"/>']].map(([style,label,svg])=>`<button type="button" data-rich-style="${style}" title="${label}" aria-label="${label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg}</svg></button>`).join('')}<output data-rich-count></output></div><p class="small-note" data-rich-hint>본문에서 글자를 선택한 뒤 서식을 적용하세요.</p><div class="member-rich-preview" data-rich-preview aria-label="본문 서식 미리보기"></div></div>`;
}
function bindMemberRichEditor(container,fields){
 for(const el of container.querySelectorAll('[data-rich-editor]')){
  const field=fields.find(x=>x.name===el.dataset.richEditor),input=el.querySelector('textarea');let text=input.value,ranges=field?.formats||[];
  // Old CRLF textareas normalize line breaks before selection offsets are exposed.
  const normalized=MemberBodyFormat.prepare(field?.value||'',ranges);text=normalized.body;ranges=normalized.bodyFormats;input.value=text;
  const paint=()=>{el.querySelector('[data-rich-count]').textContent=`${input.value.length} / 2000`;el.querySelector('[data-rich-preview]').innerHTML=memberRichHTML(input.value,ranges);};
  input.addEventListener('input',()=>{ranges=MemberBodyFormat.rebase(text,input.value,ranges);text=input.value;paint();});
  el.querySelectorAll('[data-rich-style]').forEach(button=>{
   button.addEventListener('mousedown',event=>event.preventDefault());
   button.addEventListener('click',()=>{const start=input.selectionStart,count=input.selectionEnd-start;if(!count){el.querySelector('[data-rich-hint]').textContent='서식을 적용할 본문 글자를 먼저 선택해주세요.';return;}
    ranges=MemberBodyFormat.toggle(input.value,ranges,start,count,Number(button.dataset.richStyle));paint();input.focus();input.setSelectionRange(start,start+count);el.querySelector('[data-rich-hint]').textContent='선택한 글자에 적용했습니다.';
   });
  });
  el.readFormats=()=>ranges;paint();
 }
}
