'use strict';
let memberView='overview',memberOffset=0,memberRows=new Map(),memberRenderSerial=0;
const memberTabs={overview:'운영 요약',products:'상품',news:'소식',topups:'충전 요청',orders:'구매 내역',ledger:'결제 내역',profiles:'회원',posts:'피드 글',comments:'댓글',reports:'신고'};
const memberStatus={PAID:'구매 완료',ACTIVE:'사용 중',REFUNDED:'환불 완료',PENDING:'확인 대기',APPROVED:'충전 완료',REJECTED:'반려',CANCELED:'취소',TOPUP:'충전',PURCHASE:'구매',REFUND:'환불',OPEN:'접수',RESOLVED:'처리 완료',UPDATE:'업데이트',NOTICE:'공지',EVENT:'이벤트',ALERT:'알림'};
function memberMoney(n){return Number(n||0).toLocaleString('ko-KR')+'원';}
function memberButton(action,id,label,danger=false){return `<button data-member-action="${action}" data-id="${esc(id||'')}" class="${danger?'danger':''}">${label}</button>`;}
async function renderMember(){
 if(currentView!=='member')return;
 const serial=++memberRenderSerial,view=memberView,offset=memberOffset;
 const r=await api(`/api/member?view=${view}&offset=${offset}&limit=30`);
 if(serial!==memberRenderSerial||currentView!=='member'||view!==memberView||offset!==memberOffset)return;
 memberRows=new Map((r.items||[]).map(x=>[x.id,x]));
 let html=`<div class="toolbar member-tabs">${Object.entries(memberTabs).map(([id,label])=>`<button data-member-view="${id}" class="${id===memberView?'primary':''}">${label}</button>`).join('')}</div>`;
 if(memberView==='overview')html+=`<div class="cards"><div class="card"><span>회원</span><strong>${r.members}</strong></div><div class="card"><span>상품</span><strong>${r.products}</strong></div><div class="card"><span>충전 확인 대기</span><strong>${r.pendingTopups}</strong></div><div class="card"><span>미처리 신고</span><strong>${r.openReports}</strong></div></div><div class="section-card"><h3>충전 안내</h3><p>입금 사실을 확인한 뒤 충전을 승인하세요. 승인 전에는 잔액이 늘어나지 않습니다.</p><p>${esc(r.settings.topupInstructions)}</p><p>충전 접수: ${r.settings.topupEnabled?'사용':'중지'}</p>${memberButton('settings','','충전 설정')}</div>`;
 else{
  if(memberView==='products')html+=memberButton('product.new','','상품 등록');
  if(memberView==='news')html+=memberButton('news.new','','소식 작성');
  const rows=(r.items||[]).map(x=>{
   let title=x.title||x.nickname||x.id,detail='',actions='';
   if(memberView==='products'){detail=`${accessTypeName(x.accessType)} · ${x.days}일 · ${memberMoney(x.price)} · ${x.published?'판매 중':'비공개'} · 재고 ${x.stock===-1?'무제한':x.stock}`;actions=memberButton('product.edit',x.id,'수정');}
   if(memberView==='news'){detail=`${memberStatus[x.category]} · ${x.published?'공개':'비공개'} · ${x.body}`;actions=memberButton('news.edit',x.id,'수정');}
   if(memberView==='topups'){detail=`${x.accountId} · ${x.depositor} · ${memberMoney(x.amount)} · ${memberStatus[x.status]} · ${x.note||''}`;if(x.status==='PENDING')actions=memberButton('topup.approve',x.id,'입금 확인·충전')+memberButton('topup.reject',x.id,'반려',true);}
   if(memberView==='orders'){detail=`${x.accountId} · ${memberMoney(x.amount)} · ${memberStatus[x.status]} · ${x.activatedAt?'사용 시작 '+fmtTime(x.activatedAt):'미사용'}`;if(!x.activatedAt&&x.status==='PAID')actions=memberButton('order.refund',x.id,'잔액 환불',true);}
   if(memberView==='ledger')detail=`${x.accountId} · ${memberStatus[x.kind]} · ${memberMoney(x.amount)} · 잔액 ${memberMoney(x.balance)} · ${x.reference}`;
   if(memberView==='profiles'){detail=`${x.id} · 잔액 ${memberMoney(x.balance)} · ${x.blocked?'이용 제한':'정상'} · ${x.bio}`;actions=memberButton('profile.block',x.id,x.blocked?'제한 해제':'이용 제한',!x.blocked);}
   if(memberView==='posts'||memberView==='comments'){title=x.author?.nickname||x.accountId;detail=`${x.deleted?'삭제됨':x.hidden?'숨김':'공개'} · ${x.body}`;if(!x.deleted)actions=memberButton(memberView==='posts'?'post.moderate':'comment.moderate',x.id,x.hidden?'다시 공개':'숨기기',!x.hidden);}
   if(memberView==='reports'){detail=`${x.accountId} · 글 ${x.postId} · ${memberStatus[x.status]} · ${x.reason}`;actions=memberButton('report.post',x.id,'신고 글 보기');if(x.status==='OPEN')actions+=memberButton('report.resolve',x.id,'처리 완료');}
   return `<tr><td><strong>${esc(title)}</strong><div class="small-note">${esc(fmtTime(x.at||x.updatedAt||x.createdAt))}</div></td><td class="member-detail">${esc(detail)}</td><td><div class="actions">${actions}</div></td></tr>`;
  }).join('');
  html+=`<div class="section-card"><div class="table-wrap"><table><thead><tr><th>항목</th><th>내용</th><th>작업</th></tr></thead><tbody>${rows||'<tr><td colspan="3" class="empty">등록된 항목이 없습니다.</td></tr>'}</tbody></table></div><div class="toolbar"><span>전체 ${r.total||0}개</span>${memberOffset?memberButton('prev','','이전'):''}${r.nextOffset!==null?memberButton('next','','다음'):''}</div></div>`;
 }
 content.innerHTML=html;content.dataset.topupEnabled=String(r.settings?.topupEnabled||false);content.dataset.topupInstructions=r.settings?.topupInstructions||'';
}
async function handleMemberAction(event){
 const tab=event.target.closest('[data-member-view]');if(tab){memberView=tab.dataset.memberView;memberOffset=0;await renderMember();return true;}
 const b=event.target.closest('[data-member-action]');if(!b)return false;const action=b.dataset.memberAction,row=memberRows.get(b.dataset.id)||{};
 if(action==='prev'||action==='next'){memberOffset=Math.max(0,memberOffset+(action==='next'?30:-30));await renderMember();return true;}
 let values,body;
 if(action.startsWith('product.')){
  values=await openModal({title:row.id?'상품 수정':'상품 등록',fields:[{name:'title',label:'상품명',value:row.title},{name:'description',label:'설명',type:'textarea',value:row.description},{name:'accessType',label:'콘텐츠',type:'select',value:row.accessType||'TYPE1',options:['TYPE1','TYPE2','TYPE3'].map(value=>({value,label:accessTypeName(value)}))},{name:'price',label:'가격 (원)',type:'number',value:row.price},{name:'days',label:'이용 기간 (일)',type:'number',value:row.days||30},{name:'stock',label:'재고 (무제한은 -1)',type:'number',value:row.stock??-1},{name:'published',label:'판매 상태',type:'select',value:String(row.published||false),options:[{value:'false',label:'비공개'},{value:'true',label:'판매 중'}]}],confirmLabel:'저장'});
  if(values)body={...values,action:'product.save',...(row.id?{id:row.id}:{}),price:Number(values.price),days:Number(values.days),stock:Number(values.stock),published:values.published==='true'};
 }else if(action.startsWith('news.')){
  values=await openModal({title:'소식 작성',fields:[{name:'title',label:'제목',value:row.title},{name:'body',label:'내용',type:'textarea',value:row.body},{name:'category',label:'분류',type:'select',value:row.category||'NOTICE',options:['NOTICE','UPDATE','EVENT','ALERT'].map(value=>({value,label:memberStatus[value]}))},{name:'published',label:'공개',type:'select',value:String(row.published||false),options:[{value:'false',label:'임시 저장'},{value:'true',label:'공개'}]},{name:'pinned',label:'상단 고정',type:'select',value:String(row.pinned||false),options:[{value:'false',label:'사용 안 함'},{value:'true',label:'고정'}]}],confirmLabel:'저장'});
  if(values)body={...values,action:'news.save',...(row.id?{id:row.id}:{}),published:values.published==='true',pinned:values.pinned==='true'};
 }else if(action==='settings'){
  values=await openModal({title:'충전 설정',fields:[{name:'topupInstructions',label:'입금 계좌·입금 안내',type:'textarea',value:content.dataset.topupInstructions},{name:'topupEnabled',label:'충전 신청',type:'select',value:content.dataset.topupEnabled,options:[{value:'false',label:'중지'},{value:'true',label:'접수'}]}],confirmLabel:'저장'});if(values)body={...values,action:'settings.save',topupEnabled:values.topupEnabled==='true'};
 }else if(action==='report.post'){
  const posts=await api('/api/member?view=posts&id='+encodeURIComponent(row.postId));const post=posts.items.find(x=>x.id===row.postId);if(post){const v=await openModal({title:'신고된 글',message:post.body,confirmLabel:'글 숨기기',danger:true});if(v)body={action:'post.moderate',id:post.id,hidden:true};}else toast('피드 글 목록에서 해당 식별자를 확인해주세요.',true);
 }else{
  const label=action==='topup.approve'?`실제 입금 ${memberMoney(row.amount)}을 확인했습니까? 승인하면 해당 회원의 잔액에 반영됩니다.`:action==='order.refund'?`${memberMoney(row.amount)}을 회원 잔액으로 환불합니다. 외부 계좌 환불은 수행하지 않습니다.`:'선택한 항목을 변경합니다.';
  values=await openModal({title:b.textContent,message:label,danger:['topup.reject','order.refund','profile.block'].includes(action),fields:['topup.reject','order.refund'].includes(action)?[{name:'reason',label:'사유',type:'textarea'}]:[],confirmLabel:b.textContent});
  if(values)body={action:action.startsWith('topup.')?'topup.decide':action,id:row.id,approve:action==='topup.approve',reason:values.reason||'',hidden:!row.hidden,blocked:!row.blocked};
 }
 if(body){await api('/api/member/action',{method:'POST',body});toast('반영되었습니다.');await renderMember();}return true;
}
