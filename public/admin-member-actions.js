'use strict';
async function handleMemberAction(event){
 const b=event.target.closest('[data-member-action]');if(!b)return false;const action=b.dataset.memberAction;let row=memberRows.get(b.dataset.id)||{};
 if(action==='rewards.edit'){await editMemberRewards();return true;}
 if(action==='profile.lookup'){memberLookupHandle=row.handle||b.dataset.id;memberLookupSection='';memberLookupOffset=0;await renderMemberLookup();return true;}
 if(action==='lookup.support'){supportSelectedClient=b.dataset.id;memberLookupHandle='';currentView='support';document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view==='support'));await renderCurrent();return true;}
 if(action==='lookup.qr'){qrMemberQuery='@'+memberLookupHandle.replace(/^@/,'');switchView('qrauth');await renderQrAuth();return true;}
 if(action==='lookup.manage'){const [section,id]=b.dataset.id.split('|');const view={orders:'orders',payments:'ledger',posts:'posts',comments:'comments',reports:'reports',followers:'profiles',following:'profiles'}[section];if(view){memberLookupHandle='';switchView('member-'+view);memberQuery=id;memberFilter='';memberOffset=0;await renderMember();}return true;}
 if(action==='lookup.back'){memberLookupHandle='';if(memberQuery.startsWith('@'))memberQuery='';memberOffset=0;await renderMember();return true;}
 if(action==='lookup.section'){memberLookupSection=b.dataset.id||'';memberLookupOffset=0;await renderMemberLookup();return true;}
 if(action==='lookup.prev'||action==='lookup.next'){memberLookupOffset=Math.max(0,memberLookupOffset+(action==='lookup.next'?30:-30));await renderMemberLookup();return true;}
 if(action==='prev'||action==='next'){memberOffset=Math.max(0,memberOffset+(action==='next'?30:-30));await renderMember();return true;}
 if(action==='refresh'){await renderMember();return true;}
 if(action==='reset'){memberQuery='';memberFilter='';memberSort='recent';memberOffset=0;memberSelected.clear();await renderMember();return true;}
 let values,body;
 if(['product.edit','news.edit','post.edit'].includes(action)){const view=action==='product.edit'?'products':action==='post.edit'?'posts':'news';const data=await api('/api/member?view='+view+'&id='+encodeURIComponent(row.id));row=data.items?.[0]||row;}
 if(action==='policy.edit'){
  values=await openModal({title:row.title||'문서 수정',fields:[{name:'body',label:'본문',type:'textarea',value:row.body||''},{name:'published',label:'게시 상태',type:'select',value:String(!!row.published),options:[{value:'false',label:'임시 저장'},{value:'true',label:'앱에 게시'}]}],confirmLabel:'저장'});
  if(values)body={action:'policy.save',kind:row.kind||b.dataset.id,body:values.body,published:values.published==='true',revision:row.revision||0};
 }else if(action==='product.new'||action==='product.edit'){
  values=await openModal({title:row.id?'게임 안내 수정':'게임 등록',fields:[{name:'title',label:'게임 이름',value:row.title},{name:'description',label:'게임 소개',type:'textarea',value:row.description},{name:'image',label:'게임 배너 사진',type:'image',value:row.image},...gameDetailFields(row.details||{}),{name:'accessType',label:'게임 분류',type:'select',value:row.accessType||'TYPE1',options:['TYPE1','TYPE2','TYPE3'].map(value=>({value,label:accessTypeName(value)}))},{name:'plans',label:'이용 기간 · 가격',type:'plans',value:row.plans||[1,7,15,30].map(days=>({days,price:0}))},{name:'published',label:'공개 상태',type:'select',value:String(row.published||false),options:[{value:'false',label:'비공개'},{value:'true',label:'공개'}]}],confirmLabel:'저장'});
  if(values)body={...values,action:'product.save',...(row.id?{id:row.id,revision:row.revision||0}:{}),published:values.published==='true',details:gameDetailValues(values),plans:JSON.parse(values.plans)};
 }else if(action==='news.new'||action==='news.edit'){
  values=await openModal({title:'소식 작성',fields:[{name:'title',label:'제목',value:row.title},{name:'body',label:'내용',type:'textarea',value:row.body},{name:'image',label:'소식 사진',type:'image',value:row.image},{name:'category',label:'분류',type:'select',value:row.category||'NOTICE',options:['NOTICE','UPDATE','EVENT','ALERT'].map(value=>({value,label:memberStatus[value]}))},{name:'published',label:'공개',type:'select',value:String(row.published||false),options:[{value:'false',label:'임시 저장'},{value:'true',label:'공개'}]},{name:'pinned',label:'상단 고정',type:'select',value:String(row.pinned||false),options:[{value:'false',label:'사용 안 함'},{value:'true',label:'고정'}]}],confirmLabel:'저장'});
  if(values)body={...values,action:'news.save',...(row.id?{id:row.id,revision:row.revision||0}:{}),published:values.published==='true',pinned:values.pinned==='true'};
 }else if(action==='profile.edit'){
  values=await openModal({title:'회원 프로필 수정',fields:[{name:'handle',label:'@아이디 · 최초 1회 변경'+(row.handleEditable?'':' (변경 완료)'),value:row.handle,readOnly:!row.handleEditable},{name:'nickname',label:'닉네임 · 변경 후 30일 유지'+(row.nicknameChangeAt>Date.now()?' / '+fmtTime(row.nicknameChangeAt)+'부터 변경 가능':''),value:row.nickname,readOnly:row.nicknameChangeAt>Date.now()},{name:'bio',label:'소개',type:'textarea',value:row.bio}],confirmLabel:'저장'});if(values)body={...values,action:'profile.save',memberHandle:'@'+row.handle,id:row.id};
 }else if(action==='post.edit'||action==='comment.edit'){
  values=await openModal({title:'본문 수정',fields:[...(action==='post.edit'?[{name:'title',label:'제목',value:row.title||''}]:[]),{name:'body',label:'내용',type:'textarea',value:row.body},...(action==='post.edit'?[{name:'image',label:'게시물 사진',type:'image',value:row.image},{name:'imagePosition',label:'글과 사진 배치',type:'select',value:row.imagePosition||'after',options:[{value:'after',label:'사진 위에 글'},{value:'before',label:'사진 아래에 글'}]}]:[])],confirmLabel:'저장'});if(values)body={...values,action:action==='post.edit'?'post.save':'comment.save',id:row.id,revision:row.revision||0};
 }else if(action.startsWith('content.')||action.startsWith('bulk.')){
  const ids=action.startsWith('bulk.')?[...memberSelected]:[row.id];if(!ids.length){toast('항목을 먼저 선택해주세요.',true);return true;}
  const operation=action.split('.')[1];values=await openModal({title:b.textContent,message:`${ids.length}개 항목에 적용합니다. 삭제한 운영 콘텐츠는 삭제 보관에서 복원할 수 있습니다.`,danger:operation==='delete',confirmLabel:'적용'});
  if(values)body={action:'content.action',table:memberView,operation,ids};
 }else if(action==='report.post'){
  const isComment=!!row.commentId,view=isComment?'comments':'posts',id=isComment?row.commentId:row.postId;const result=await api('/api/member?view='+view+'&id='+encodeURIComponent(id));const item=result.items.find(x=>x.id===id);if(item){const v=await openModal({title:isComment?'신고된 댓글':'신고된 글',message:item.body,confirmLabel:'숨기기',danger:true});if(v)body={action:isComment?'comment.moderate':'post.moderate',id:item.id,hidden:true};}else toast('삭제되었거나 찾을 수 없는 내용입니다.',true);
 }else if(action==='report.resolve'||action==='report.reopen'){
  values=await openModal({title:b.textContent,fields:[{name:'resolution',label:'처리 메모',type:'textarea',value:row.resolution||''}],confirmLabel:'저장'});if(values)body={...values,action,id:row.id};
 }else{
  const label=action==='order.refund'?`${memberMoney(row.amount)}을 회원 잔액으로 환불합니다. 기존 구매 내역을 환불 처리합니다.`:'선택한 항목을 변경합니다.';
  values=await openModal({title:b.textContent,message:label,danger:['order.refund','profile.block'].includes(action),fields:['order.refund'].includes(action)?[{name:'reason',label:'사유',type:'textarea'}]:[],confirmLabel:b.textContent});
  if(values)body={action,id:row.id,reason:values.reason||'',hidden:!row.hidden,blocked:!row.blocked};
 }
 if(body){await api('/api/member/action',{method:'POST',body});toast('반영되었습니다.');await renderMember();}return true;
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
 if(event.target.id!=='member-search-form')return;event.preventDefault();memberQuery=content.querySelector('#member-search').value.trim();memberOffset=0;memberSelected.clear();if(memberView==='profiles'&&memberQuery.startsWith('@')){memberLookupHandle=memberQuery;memberLookupSection='';memberLookupOffset=0;}renderMember().catch(e=>{memberLookupHandle='';toast(e.message,true);});
});

function gameDetailFields(details){
 const basic=[['releaseDate','출시일'],['developer','제작사'],['publisher','배급사'],['genre','장르'],['ageRating','이용 등급'],['language','지원 언어'],['platform','플랫폼']];
 const fields=[{type:'section',label:'게임 상세 정보'},...basic.map(([name,label])=>({name:'detail_'+name,label,value:details[name]||''}))];
 const genre=fields.find(x=>x.name==='detail_genre');genre.type='select';genre.value=details.genre||'기타';genre.options=[...new Set(['RPG','레이싱','액션','리듬','캐주얼','스포츠','전략','시뮬레이션','어드벤처','퍼즐','슈팅','기타',...(details.genre?[details.genre]:[])])];
 return fields;
}
function gameDetailValues(values){
 const details={};
 for(const name of ['releaseDate','developer','publisher','genre','ageRating','language','platform'])details[name]=values['detail_'+name]||'';
 return details;
}
