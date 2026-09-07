'use strict';
async function handleMemberAction(event){
 const tab=event.target.closest('[data-member-view]');if(tab){memberView=tab.dataset.memberView;memberOffset=0;memberFilter='';memberQuery='';memberSelected.clear();await renderMember();return true;}
 const b=event.target.closest('[data-member-action]');if(!b)return false;const action=b.dataset.memberAction,row=memberRows.get(b.dataset.id)||{};
 if(action==='prev'||action==='next'){memberOffset=Math.max(0,memberOffset+(action==='next'?30:-30));await renderMember();return true;}
 if(action==='refresh'){await renderMember();return true;}
 if(action==='reset'){memberQuery='';memberFilter='';memberSort='recent';memberOffset=0;memberSelected.clear();await renderMember();return true;}
 if(action==='copy'){await navigator.clipboard.writeText(row.address);toast('주소를 복사했습니다.');return true;}
 let values,body;
 if(action==='product.new'||action==='product.edit'){
  values=await openModal({title:row.id?'상품 수정':'상품 등록',fields:[{name:'title',label:'상품명',value:row.title},{name:'description',label:'설명',type:'textarea',value:row.description},{name:'accessType',label:'콘텐츠',type:'select',value:row.accessType||'TYPE1',options:['TYPE1','TYPE2','TYPE3'].map(value=>({value,label:accessTypeName(value)}))},{name:'price',label:'가격 (원)',type:'number',value:row.price},{name:'days',label:'이용 기간 (일)',type:'number',value:row.days||30},{name:'stock',label:'재고 (무제한은 -1)',type:'number',value:row.stock??-1},{name:'published',label:'판매 상태',type:'select',value:String(row.published||false),options:[{value:'false',label:'비공개'},{value:'true',label:'판매 중'}]}],confirmLabel:'저장'});
  if(values)body={...values,action:'product.save',...(row.id?{id:row.id,revision:row.revision||0}:{}),price:Number(values.price),days:Number(values.days),stock:Number(values.stock),published:values.published==='true'};
 }else if(action==='news.new'||action==='news.edit'){
  values=await openModal({title:'소식 작성',fields:[{name:'title',label:'제목',value:row.title},{name:'body',label:'내용',type:'textarea',value:row.body},{name:'category',label:'분류',type:'select',value:row.category||'NOTICE',options:['NOTICE','UPDATE','EVENT','ALERT'].map(value=>({value,label:memberStatus[value]}))},{name:'published',label:'공개',type:'select',value:String(row.published||false),options:[{value:'false',label:'임시 저장'},{value:'true',label:'공개'}]},{name:'pinned',label:'상단 고정',type:'select',value:String(row.pinned||false),options:[{value:'false',label:'사용 안 함'},{value:'true',label:'고정'}]}],confirmLabel:'저장'});
  if(values)body={...values,action:'news.save',...(row.id?{id:row.id,revision:row.revision||0}:{}),published:values.published==='true',pinned:values.pinned==='true'};
 }else if(action==='coin.new'||action==='coin.edit'){
  values=await openModal({title:'코인·네트워크·입금 주소',message:'실제 수신 주소를 등록하세요. 환산 기준은 시세 자동 연동이 아닌 운영 설정입니다. 같은 코인이라도 네트워크마다 별도로 등록합니다.',fields:[{name:'symbol',label:'코인 코드 (BTC, ETH, USDT 등)',value:row.symbol||''},{name:'name',label:'코인 이름',value:row.name||''},{name:'network',label:'네트워크 (Bitcoin, Ethereum, TRON 등)',value:row.network||''},{name:'address',label:'실제 수신 주소',value:row.address||''},{name:'memo',label:'메모 / 태그 (필요한 경우)',value:row.memo||''},{name:'decimals',label:'코인 소수 자릿수 (BTC 8, ETH 18 등)',type:'number',value:row.decimals??8},{name:'krwPerCoin',label:'1 코인당 반영할 잔액 (원)',value:row.krwPerCoin||''},{name:'confirmations',label:'필요한 입금 확인 횟수',type:'number',value:row.confirmations||3},{name:'enabled',label:'앱에서 선택',type:'select',value:String(row.enabled||false),options:[{value:'false',label:'중지'},{value:'true',label:'사용'}]}],confirmLabel:'저장'});
  if(values)body={...values,action:'coin.save',...(row.id?{id:row.id,revision:row.revision}:{}),decimals:Number(values.decimals),confirmations:Number(values.confirmations),enabled:values.enabled==='true'};
 }else if(action==='profile.edit'){
  values=await openModal({title:'회원 프로필 수정',fields:[{name:'nickname',label:'닉네임',value:row.nickname},{name:'bio',label:'소개',type:'textarea',value:row.bio}],confirmLabel:'저장'});if(values)body={...values,action:'profile.save',id:row.id};
 }else if(action==='post.edit'||action==='comment.edit'){
  values=await openModal({title:'본문 수정',fields:[{name:'body',label:'내용',type:'textarea',value:row.body}],confirmLabel:'저장'});if(values)body={...values,action:action==='post.edit'?'post.save':'comment.save',id:row.id,revision:row.revision||0};
 }else if(action.startsWith('content.')||action.startsWith('bulk.')){
  const ids=action.startsWith('bulk.')?[...memberSelected]:[row.id];if(!ids.length){toast('항목을 먼저 선택해주세요.',true);return true;}
  const operation=action.split('.')[1];values=await openModal({title:b.textContent,message:`${ids.length}개 항목에 적용합니다. 삭제한 운영 콘텐츠는 삭제 보관에서 복원할 수 있습니다.`,danger:operation==='delete',confirmLabel:'적용'});
  if(values)body={action:'content.action',table:memberView,operation,ids};
 }else if(action==='settings'){
  values=await openModal({title:'충전 설정',fields:[{name:'topupInstructions',label:'코인 입금 공통 안내',type:'textarea',value:content.dataset.topupInstructions},{name:'topupEnabled',label:'충전 신청',type:'select',value:content.dataset.topupEnabled,options:[{value:'false',label:'중지'},{value:'true',label:'접수'}]}],confirmLabel:'저장'});if(values)body={...values,action:'settings.save',topupEnabled:values.topupEnabled==='true'};
 }else if(action==='report.post'){
  const posts=await api('/api/member?view=posts&id='+encodeURIComponent(row.postId));const post=posts.items.find(x=>x.id===row.postId);if(post){const v=await openModal({title:'신고된 글',message:post.body,confirmLabel:'글 숨기기',danger:true});if(v)body={action:'post.moderate',id:post.id,hidden:true};}else toast('피드 글 목록에서 해당 식별자를 확인해주세요.',true);
 }else if(action==='topup.approve'&&row.coin){
  values=await openModal({title:'코인 입금 확인',message:`${row.coinAmount} ${row.coin.symbol} · ${row.coin.network}\n주소 ${row.coin.address}\n거래 ${row.txHash}\n승인하면 ${memberMoney(row.amount)}을 잔액에 반영합니다.`,fields:[{name:'receivedAmount',label:'실제로 확인한 입금 수량',value:''},{name:'confirmations',label:'실제로 확인된 횟수',type:'number',value:''},{name:'receiptVerified',label:'주소·네트워크·거래 해시 확인',type:'select',value:'false',options:[{value:'false',label:'확인 전'},{value:'true',label:'실제 입금 확인 완료'}]}],confirmLabel:'충전 승인'});
  if(values)body={action:'topup.decide',id:row.id,approve:true,receivedAmount:values.receivedAmount,confirmations:Number(values.confirmations),receiptVerified:values.receiptVerified==='true'};
 }else if(action==='report.resolve'||action==='report.reopen'){
  values=await openModal({title:b.textContent,fields:[{name:'resolution',label:'처리 메모',type:'textarea',value:row.resolution||''}],confirmLabel:'저장'});if(values)body={...values,action,id:row.id};
 }else if(action==='topup.reopen'){
  values=await openModal({title:'입금 요청 재검토',message:'기존 거래 해시와 입금 정보를 유지하고 확인 대기로 되돌립니다.',confirmLabel:'재검토'});if(values)body={action,id:row.id};
 }else{
  const label=action==='topup.approve'?`실제 입금 ${memberMoney(row.amount)}을 확인했습니까? 승인하면 해당 회원의 잔액에 반영됩니다.`:action==='order.refund'?`${memberMoney(row.amount)}을 회원 잔액으로 환불합니다. 외부 계좌 환불은 수행하지 않습니다.`:'선택한 항목을 변경합니다.';
  values=await openModal({title:b.textContent,message:label,danger:['topup.reject','order.refund','profile.block'].includes(action),fields:['topup.reject','order.refund'].includes(action)?[{name:'reason',label:'사유',type:'textarea'}]:[],confirmLabel:b.textContent});
  if(values)body={action:action.startsWith('topup.')?'topup.decide':action,id:row.id,approve:action==='topup.approve',reason:values.reason||'',hidden:!row.hidden,blocked:!row.blocked};
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
  memberFilter=content.querySelector('#member-filter').value;memberSort=content.querySelector('#member-sort').value;memberOffset=0;memberSelected.clear();renderMember().catch(e=>toast(e.message,true));
 }
});
content.addEventListener('submit',event=>{
 if(event.target.id!=='member-search-form')return;event.preventDefault();memberQuery=content.querySelector('#member-search').value.trim();memberOffset=0;memberSelected.clear();renderMember().catch(e=>toast(e.message,true));
});
