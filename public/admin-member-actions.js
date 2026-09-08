'use strict';
async function handleMemberAction(event){
 const tab=event.target.closest('[data-member-view]');if(tab){memberView=tab.dataset.memberView;memberOffset=0;memberFilter='';memberQuery='';memberSelected.clear();memberSort='recent';await renderMember();return true;}
 const b=event.target.closest('[data-member-action]');if(!b)return false;const action=b.dataset.memberAction,row=memberRows.get(b.dataset.id)||{};
 if(action==='prev'||action==='next'){memberOffset=Math.max(0,memberOffset+(action==='next'?30:-30));await renderMember();return true;}
 if(action==='refresh'){await renderMember();return true;}
 if(action==='reset'){memberQuery='';memberFilter='';memberSort='recent';memberOffset=0;memberSelected.clear();await renderMember();return true;}
 let values,body;
 if(action==='charge.scan'){
  const file=content.querySelector('#member-charge-file')?.files?.[0];if(!file)throw Error('충전 QR 사진을 먼저 선택해주세요.');
  if(!['image/png','image/jpeg'].includes(file.type)||file.size>8*1024*1024)throw Error('8MB 이하의 PNG 또는 JPEG 사진을 선택해주세요.');
  const result=(await api('/api/member/action',{method:'POST',body:{action:'charge.scan',imageData:await fileAsDataUrl(file)}})).result;
  values=await openModal({title:'QR 충전 등록',message:`${result.member.nickname} · ${result.member.id}\n처음 이용하기를 누르면 기간이 시작됩니다.`,fields:[{name:'amount',label:'확인한 충전 금액 (원)',type:'number',value:''},{name:'days',label:'게임 이용 기간 (일)',type:'number',value:30},{name:'accessType',label:'게임',type:'select',value:'TYPE1',options:['TYPE1','TYPE2','TYPE3'].map(value=>({value,label:accessTypeName(value)}))},{name:'memo',label:'확인 메모',type:'textarea',value:''}],confirmLabel:'충전 등록'});
  if(values)body={action:'charge.approve',id:result.request.id,approvalToken:result.approvalToken,amount:Number(values.amount),days:Number(values.days),accessType:values.accessType,memo:values.memo||''};
 }else if(action==='charge.reject'){
  values=await openModal({title:'충전 요청 반려',fields:[{name:'reason',label:'회원에게 전달할 사유',type:'textarea'}],confirmLabel:'반려'});if(values)body={action:'charge.reject',id:row.id,reason:values.reason};
 }else if(action==='product.new'||action==='product.edit'){
  values=await openModal({title:row.id?'게임 안내 수정':'게임 등록',fields:[{name:'title',label:'게임 이름',value:row.title},{name:'description',label:'게임 소개',type:'textarea',value:row.description},{name:'accessType',label:'게임 분류',type:'select',value:row.accessType||'TYPE1',options:['TYPE1','TYPE2','TYPE3'].map(value=>({value,label:accessTypeName(value)}))},{name:'published',label:'공개 상태',type:'select',value:String(row.published||false),options:[{value:'false',label:'비공개'},{value:'true',label:'공개'}]}],confirmLabel:'저장'});
  if(values)body={...values,action:'product.save',...(row.id?{id:row.id,revision:row.revision||0}:{}),published:values.published==='true'};
 }else if(action==='news.new'||action==='news.edit'){
  values=await openModal({title:'소식 작성',fields:[{name:'title',label:'제목',value:row.title},{name:'body',label:'내용',type:'textarea',value:row.body},{name:'category',label:'분류',type:'select',value:row.category||'NOTICE',options:['NOTICE','UPDATE','EVENT','ALERT'].map(value=>({value,label:memberStatus[value]}))},{name:'published',label:'공개',type:'select',value:String(row.published||false),options:[{value:'false',label:'임시 저장'},{value:'true',label:'공개'}]},{name:'pinned',label:'상단 고정',type:'select',value:String(row.pinned||false),options:[{value:'false',label:'사용 안 함'},{value:'true',label:'고정'}]}],confirmLabel:'저장'});
  if(values)body={...values,action:'news.save',...(row.id?{id:row.id,revision:row.revision||0}:{}),published:values.published==='true',pinned:values.pinned==='true'};
 }else if(action==='profile.edit'){
  values=await openModal({title:'회원 프로필 수정',fields:[{name:'nickname',label:'닉네임',value:row.nickname},{name:'bio',label:'소개',type:'textarea',value:row.bio}],confirmLabel:'저장'});if(values)body={...values,action:'profile.save',id:row.id};
 }else if(action==='post.edit'||action==='comment.edit'){
  values=await openModal({title:'본문 수정',fields:[{name:'body',label:'내용',type:'textarea',value:row.body}],confirmLabel:'저장'});if(values)body={...values,action:action==='post.edit'?'post.save':'comment.save',id:row.id,revision:row.revision||0};
 }else if(action.startsWith('content.')||action.startsWith('bulk.')){
  const ids=action.startsWith('bulk.')?[...memberSelected]:[row.id];if(!ids.length){toast('항목을 먼저 선택해주세요.',true);return true;}
  const operation=action.split('.')[1];values=await openModal({title:b.textContent,message:`${ids.length}개 항목에 적용합니다. 삭제한 운영 콘텐츠는 삭제 보관에서 복원할 수 있습니다.`,danger:operation==='delete',confirmLabel:'적용'});
  if(values)body={action:'content.action',table:memberView,operation,ids};
 }else if(action==='report.post'){
  const posts=await api('/api/member?view=posts&id='+encodeURIComponent(row.postId));const post=posts.items.find(x=>x.id===row.postId);if(post){const v=await openModal({title:'신고된 글',message:post.body,confirmLabel:'글 숨기기',danger:true});if(v)body={action:'post.moderate',id:post.id,hidden:true};}else toast('피드 글 목록에서 해당 식별자를 확인해주세요.',true);
 }else if(action==='report.resolve'||action==='report.reopen'){
  values=await openModal({title:b.textContent,fields:[{name:'resolution',label:'처리 메모',type:'textarea',value:row.resolution||''}],confirmLabel:'저장'});if(values)body={...values,action,id:row.id};
 }else{
  const label=action==='order.refund'?`${memberMoney(row.amount)}을 회원 잔액으로 환불합니다. 기존 구매 내역을 환불 처리합니다.`:'선택한 항목을 변경합니다.';
  values=await openModal({title:b.textContent,message:label,danger:['order.refund','profile.block'].includes(action),fields:['order.refund'].includes(action)?[{name:'reason',label:'사유',type:'textarea'}]:[],confirmLabel:b.textContent});
  if(values)body={action,id:row.id,reason:values.reason||'',hidden:!row.hidden,blocked:!row.blocked};
 }
 if(body){await api('/api/member/action',{method:'POST',body});const file=content.querySelector('#member-charge-file');if(file)file.value='';toast('반영되었습니다.');await renderMember();}return true;
}

function updateMemberSelection(){
 const boxes=[...content.querySelectorAll('.member-check')],all=content.querySelector('#member-check-all'),count=content.querySelector('#member-selected-count');
 if(all){all.disabled=!boxes.length;all.checked=boxes.length>0&&boxes.every(x=>memberSelected.has(x.dataset.id));all.indeterminate=boxes.some(x=>memberSelected.has(x.dataset.id))&&!all.checked;}
 if(count)count.textContent=`선택 ${memberSelected.size}개`;
 content.querySelectorAll('[data-member-action^="bulk."]').forEach(b=>b.disabled=!memberSelected.size);
}
content.addEventListener('change',event=>{
 const element=event.target;
 if(element.matches('.member-check')){element.checked?memberSelected.add(element.dataset.id):memberSelected.delete(element.dataset.id);updateMemberSelection();}
 if(element.id==='member-check-all'){content.querySelectorAll('.member-check').forEach(box=>{box.checked=element.checked;element.checked?memberSelected.add(box.dataset.id):memberSelected.delete(box.dataset.id);});updateMemberSelection();}
 if(element.id==='member-filter'||element.id==='member-sort'){
  memberFilter=content.querySelector('#member-filter')?.value||'';memberSort=content.querySelector('#member-sort')?.value||'recent';memberOffset=0;memberSelected.clear();renderMember().catch(e=>toast(e.message,true));
 }
});
content.addEventListener('submit',event=>{
 if(event.target.id!=='member-search-form')return;event.preventDefault();memberQuery=content.querySelector('#member-search').value.trim();memberOffset=0;memberSelected.clear();renderMember().catch(e=>toast(e.message,true));
});
