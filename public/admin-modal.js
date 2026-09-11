'use strict';

function openModal(options) {
  return new Promise(resolve => {
    modalTitle.textContent = options.title || '확인';
    const fields = options.fields || [];let active=true,pending=0;modalConfirm.disabled=false;
    modalBody.innerHTML = `${options.message ? `<p>${esc(options.message)}</p>` : ''}${options.html || ''}${fields.map(f => {
      if (f.type === 'plans') return `<fieldset class="modal-plans" data-modal-plans="${esc(f.name)}"><legend>${esc(f.label)}</legend><p class="small-note">1~3650일, 최대 24개. 가격 0원은 판매 준비 중입니다.</p><div data-plan-rows>${(f.value||[]).map(memberPlanRow).join('')}</div><button type="button" data-plan-add>기간 추가</button><p role="alert" data-plan-error></p></fieldset>`;
      if (f.type === 'section') return `<h3 class="modal-section">${esc(f.label)}</h3>`;
      if (f.type === 'image') return `<div class="modal-media"><label>${esc(f.label)}<input type="hidden" data-modal-field="${esc(f.name)}" value="${esc(f.value||'')}"><input type="file" accept="image/png,image/jpeg" data-modal-image="${esc(f.name)}" aria-label="${esc(f.label)} 선택"></label><img data-modal-preview="${esc(f.name)}" ${f.value?`src="${esc(f.value)}"`:'hidden'} alt="사진 미리보기"><button type="button" data-modal-image-remove="${esc(f.name)}">사진 삭제</button><p class="small-note" data-modal-image-status="${esc(f.name)}">PNG·JPEG 사진을 선택하세요. 앱 표시 크기로 최적화합니다.</p></div>`;
      if (f.type === 'richtext') return memberRichField(f);
      if (f.type === 'textarea') return `<label>${esc(f.label)}<textarea ${f.readOnly?'readonly aria-readonly="true"':''} data-modal-field="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea></label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select data-modal-field="${esc(f.name)}">${(f.options || []).map(o => `<option value="${esc(o.value ?? o)}" ${String(o.value ?? o)===String(f.value ?? '')?'selected':''}>${esc(o.label ?? o)}</option>`).join('')}</select></label>`;
      if (f.type === 'password') return `<label>${esc(f.label)}<div class="password-input-row"><input data-modal-field="${esc(f.name)}" type="password" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" inputmode="${esc(f.inputmode || 'numeric')}" autocomplete="new-password" maxlength="${Number(f.maxLength || 8)}"><button type="button" data-modal-reveal="${esc(f.name)}">보기</button></div></label>`;
      return `<label>${esc(f.label)}<input ${f.readOnly?'readonly aria-readonly="true"':''} data-modal-field="${esc(f.name)}" type="${esc(f.type || 'text')}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"></label>`;
    }).join('')}`;
    bindMemberRichEditor(modalBody,fields);
    modalConfirm.textContent = options.confirmLabel || '확인';
    modalConfirm.className = options.danger ? 'danger' : 'primary';
    modalEl.classList.remove('hidden');
    modalEl.setAttribute('aria-hidden', 'false');

    const close = value => {
      active=false;modalBody.onchange=null;modalConfirm.disabled=false;
      modalEl.classList.add('hidden');
      modalEl.setAttribute('aria-hidden', 'true');
      modalConfirm.onclick = null;
      modalCancel.onclick = null;
      modalBody.onclick = null;
      modalEl.querySelectorAll('[data-modal-close]').forEach(x => x.onclick = null);
      resolve(value);
    };
    modalCancel.onclick = () => close(null);
    modalEl.querySelectorAll('[data-modal-close]').forEach(x => x.onclick = () => close(null));
    modalBody.onclick = event => {
      const planAdd=event.target.closest('[data-plan-add]');if(planAdd){const rows=planAdd.closest('[data-modal-plans]').querySelector('[data-plan-rows]');if(rows.children.length<24)rows.insertAdjacentHTML('beforeend',memberPlanRow({days:'',price:0}));return;}
      const planRemove=event.target.closest('[data-plan-remove]');if(planRemove){planRemove.closest('[data-plan-row]').remove();return;}
      const previewTap=event.target.closest('[data-modal-preview]');if(previewTap&&!previewTap.hidden){previewTap.classList.toggle('media-expanded');return;}
      const remove=event.target.closest('[data-modal-image-remove]');
      if(remove){const name=CSS.escape(remove.dataset.modalImageRemove);const file=modalBody.querySelector(`[data-modal-image="${name}"]`);file.dataset.sequence=String(Number(file.dataset.sequence||0)+1);file.value='';modalBody.querySelector(`[data-modal-field="${name}"]`).value='';const preview=modalBody.querySelector(`[data-modal-preview="${name}"]`);preview.removeAttribute('src');preview.hidden=true;modalBody.querySelector(`[data-modal-image-status="${name}"]`).textContent='사진을 삭제하도록 선택했습니다.';return;}
      const reveal = event.target.closest('[data-modal-reveal]');
      if (!reveal) return;
      const input = modalBody.querySelector(`[data-modal-field="${CSS.escape(reveal.dataset.modalReveal)}"]`);
      if (!input) return;
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      reveal.textContent = visible ? '보기' : '숨기기';
      input.focus();
    };
    modalBody.onchange=async event=>{
      const input=event.target;if(!input.matches('[data-modal-image]'))return;
      const file=input.files?.[0];if(!file)return;
      const name=CSS.escape(input.dataset.modalImage),serial=Number(input.dataset.sequence||0)+1;input.dataset.sequence=String(serial);
      const status=modalBody.querySelector(`[data-modal-image-status="${name}"]`);pending++;modalConfirm.disabled=true;status.textContent='사진을 준비하고 있어요.';
      try{
        const data=await normalizeMemberImage(file);if(!active||Number(input.dataset.sequence)!==serial)return;
        modalBody.querySelector(`[data-modal-field="${name}"]`).value=data;const preview=modalBody.querySelector(`[data-modal-preview="${name}"]`);preview.src=data;preview.hidden=false;status.textContent='사진이 준비되었습니다. 저장을 눌러 적용하세요.';
      }catch(error){if(active&&Number(input.dataset.sequence)===serial)status.textContent=error.message||'사진을 다시 선택해주세요.';}
      finally{pending--;if(active)modalConfirm.disabled=pending>0;}
    };
    modalConfirm.onclick = () => {
      if(pending)return;
      const values = {};
      modalBody.querySelectorAll('[data-modal-field]').forEach(el => values[el.dataset.modalField] = el.value);
      for(const editor of modalBody.querySelectorAll('[data-rich-editor]')){const input=editor.querySelector('textarea');const prepared=MemberBodyFormat.prepare(input.value,editor.readFormats());values[editor.dataset.richEditor]=prepared.body;values.bodyFormats=prepared.bodyFormats;}
      for(const group of modalBody.querySelectorAll('[data-modal-plans]')){const rows=[...group.querySelectorAll('[data-plan-row]')].map(row=>({days:Number(row.querySelector('[data-plan-days]').value),price:Number(row.querySelector('[data-plan-price]').value)}));const valid=rows.length>0&&rows.length<=24&&new Set(rows.map(x=>x.days)).size===rows.length&&rows.every(x=>Number.isSafeInteger(x.days)&&x.days>=1&&x.days<=3650&&Number.isSafeInteger(x.price)&&x.price>=0&&x.price<=10000000);if(!valid){group.querySelector('[data-plan-error]').textContent='중복 없이 기간(1~3650일)과 금액(0~1천만 원)을 입력해주세요.';return;}values[group.dataset.modalPlans]=JSON.stringify(rows);}
      close(values);
    };
    const first = modalBody.querySelector('input:not([type=hidden]):not([readonly]),textarea:not([readonly]),select');
    if (first) setTimeout(() => first.focus(), 20);
  });
}


async function normalizeMemberImage(file){
 if(!(['image/jpeg','image/png'].includes(file.type)||(!file.type&&/\.(png|jpe?g)$/i.test(file.name)))||file.size>8*1024*1024)throw Error('8MB 이하의 PNG 또는 JPEG 사진을 선택해주세요.');
 const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('사진 파일을 읽을 수 없습니다.'));reader.readAsDataURL(file);}),picture=new Image();
 try{
  await new Promise((resolve,reject)=>{picture.onload=resolve;picture.onerror=()=>reject(Error('사진을 읽지 못했습니다.'));picture.src=url;});
  if(!picture.naturalWidth||!picture.naturalHeight||picture.naturalWidth*picture.naturalHeight>40000000)throw Error('사진 크기가 너무 큽니다.');
  const ratio=Math.min(1,1024/Math.max(picture.naturalWidth,picture.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(picture.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(picture.naturalHeight*ratio));
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(picture,0,0,canvas.width,canvas.height);
  let result='';for(let pass=0;pass<6;pass++){for(const quality of [.86,.74,.62,.50,.38]){result=canvas.toDataURL('image/jpeg',quality);if(result.length<=280000)return result;}canvas.width=Math.max(1,Math.round(canvas.width*.8));canvas.height=Math.max(1,Math.round(canvas.height*.8));context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(picture,0,0,canvas.width,canvas.height);}
  throw Error('사진 용량을 줄여 다시 선택해주세요.');
 }finally{picture.onload=null;picture.onerror=null;}
}

function memberPlanRow(row){return `<div data-plan-row><label>기간 (일)<input type="number" min="1" max="3650" step="1" data-plan-days value="${esc(row.days)}"></label><label>가격 (원)<input type="number" min="0" max="10000000" step="1" data-plan-price value="${esc(row.price)}"></label><button type="button" data-plan-remove aria-label="기간 삭제">삭제</button></div>`;}
