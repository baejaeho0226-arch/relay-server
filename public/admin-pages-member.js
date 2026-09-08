'use strict';
let memberView='overview',memberOffset=0,memberRows=new Map(),memberRenderSerial=0;
let memberQuery='',memberFilter='',memberSort='recent',memberSelected=new Set();
let memberPointerDown=false,memberPointerUntil=0,memberInteractionUntil=0,memberLastRefresh=0,memberFingerprint='';
const memberTabs={overview:'운영 요약',news:'소식',products:'게임',profiles:'회원',posts:'피드 글',comments:'댓글',reports:'신고',charges:'QR 충전',orders:'이용권 내역',ledger:'결제 원장'};
const memberStatus={PAID:'이용 대기',ACTIVE:'사용 중',REFUNDED:'환불 완료',QR_CHARGE:'QR 충전',PENDING:'확인 대기',APPROVED:'충전 등록',REJECTED:'반려',EXPIRED:'기간 만료',TOPUP:'이전 잔액 반영',PURCHASE:'구매',REFUND:'환불',OPEN:'접수',RESOLVED:'처리 완료',UPDATE:'업데이트',NOTICE:'공지',EVENT:'이벤트',ALERT:'알림'};
const memberEditable=view=>['products','news','posts','comments'].includes(view);
function memberMoney(n){return Number(n||0).toLocaleString('ko-KR')+'원';}
function memberButton(action,id,label,danger=false){return `<button type="button" data-member-action="${action}" data-id="${esc(id||'')}" class="${danger?'danger':''}">${label}</button>`;}
function memberState(row,view){if(view==='ledger')return '기록';if(view==='profiles')return row.blocked?'이용 제한':'정상';return row.deleted?'삭제 보관':row.hidden?'숨김':row.status?memberStatus[row.status]||row.status:row.published===false?'비공개':'공개';}
function memberFilters(view){
 if(['products','news'].includes(view))return [['active','공개'],['draft','비공개'],['deleted','삭제 보관']];
 if(['posts','comments'].includes(view))return [['active','공개'],['hidden','숨김'],['deleted','삭제 보관']];
 if(view==='reports')return [['OPEN','접수'],['RESOLVED','처리 완료']];
 if(view==='charges')return [['PENDING','확인 대기'],['APPROVED','충전 등록'],['REJECTED','반려'],['EXPIRED','기한 만료']];
 if(view==='orders')return [['PAID','미사용'],['ACTIVE','사용 중'],['REFUNDED','환불 완료']];
 return [];
}
function memberDescription(text){
 if(!text)return '';
 return `<div class="member-preview">${esc(text)}</div>${text.length>100?`<details class="member-body"><summary>내용 더 보기</summary><p>${esc(text)}</p></details>`:''}`;
}
function memberRow(row,view){
 let title=row.title||row.nickname||row.id,meta='',body='',actions='';
 if(view==='products'){meta=accessTypeName(row.accessType);body=row.description;actions=memberButton('product.edit',row.id,'수정');}
 if(view==='charges'){title=row.title||'충전 요청';meta=`${row.accountId}${row.amount?' · '+memberMoney(row.amount)+' · '+row.days+'일':''}`;body=row.memo||row.reason||'전달받은 QR 사진을 스캔해 금액과 게임 이용 기간을 등록하세요.';if(row.status==='PENDING')actions=memberButton('charge.reject',row.id,'반려');}
 if(view==='news'){meta=`${memberStatus[row.category]}${row.pinned?' · 상단 고정':''}`;body=row.body;actions=memberButton('news.edit',row.id,'수정');}
 if(view==='orders'){meta=`${row.accountId} · ${memberMoney(row.amount)}`;body=row.activatedAt?'사용 시작 '+fmtTime(row.activatedAt):'미사용';if(!row.activatedAt&&row.status==='PAID'&&row.source!=='QR_CHARGE')actions=memberButton('order.refund',row.id,'잔액 환불',true);}
 if(view==='ledger'){title=memberStatus[row.kind]||'거래';meta=`${row.accountId} · ${memberMoney(row.amount)} · ${row.kind==='QR_CHARGE'?'이용권 등록':'잔액 '+memberMoney(row.balance)}`;body=row.reference;}
 if(view==='profiles'){meta=`잔액 ${memberMoney(row.balance)}`;body=row.bio;actions=memberButton('profile.edit',row.id,'프로필 수정')+memberButton('profile.block',row.id,row.blocked?'제한 해제':'이용 제한',!row.blocked);}
 if(view==='posts'||view==='comments'){title=row.author?.nickname||row.accountId;body=row.body||'작성자가 삭제한 내용입니다.';if(!row.deleted)actions=memberButton(view==='posts'?'post.edit':'comment.edit',row.id,'수정')+memberButton('content.'+(row.hidden?'show':'hide'),row.id,row.hidden?'공개':'숨기기');}
 if(view==='reports'){meta=`${row.accountId}`;body=row.reason+(row.resolution?'\n처리 메모: '+row.resolution:'');actions=memberButton('report.post',row.id,'신고 글')+memberButton(row.status==='OPEN'?'report.resolve':'report.reopen',row.id,row.status==='OPEN'?'처리 완료':'다시 열기');}
 if(memberEditable(view)){
  if(row.deleted){if(!row.deletedByMember&&(!['posts','comments'].includes(view)||row.body))actions+=memberButton('content.restore',row.id,'복원');}
  else actions+=memberButton('content.delete',row.id,'삭제',true);
 }
 if(['products','news'].includes(view)&&!row.deleted)actions+=memberButton('content.'+(row.published?'unpublish':'publish'),row.id,row.published?'비공개':'공개');
 return `<tr>${memberEditable(view)?`<td><input type="checkbox" class="member-check" aria-label="${esc(title)} 선택" data-id="${esc(row.id)}" ${memberSelected.has(row.id)?'checked':''}></td>`:''}<td class="member-item"><strong>${esc(title)}</strong><div class="small-note">${esc(fmtTime(row.updatedAt||row.at||row.createdAt))}</div><span class="member-badge">${esc(memberState(row,view))}</span></td><td class="member-detail">${meta?`<div class="member-meta">${esc(meta)}</div>`:''}${memberDescription(body)}</td>${view==='posts'?`<td class="member-views">${Number(row.views||0).toLocaleString('ko-KR')}</td>`:''}<td><div class="actions">${actions||'—'}</div></td></tr>`;
}
function memberCanAutoRefresh(){
 const file=content.querySelector('#member-charge-file');if(file?.files?.length)return false;
 const search=content.querySelector('#member-search');
 if(search&&search.value.trim()!==memberQuery)return false;
 return currentView==='member'&&!document.hidden&&!(memberPointerDown&&Date.now()<memberPointerUntil)&&Date.now()>=memberInteractionUntil&&memberSelected.size===0&&
  !content.querySelector('details[open]')&&!document.querySelector('#modal:not(.hidden)')&&
  !(content.contains(document.activeElement)&&document.activeElement.matches('input,textarea,select'));
}
async function renderMember(automatic=false){
 if(currentView!=='member'||(automatic&&!memberCanAutoRefresh()))return;
 const serial=++memberRenderSerial,view=memberView,offset=memberOffset;
 const query=new URLSearchParams({view,offset:String(offset),limit:'30',q:memberQuery,status:memberFilter,sort:memberSort});
 const result=await api('/api/member?'+query);
 if(serial!==memberRenderSerial||currentView!=='member'||view!==memberView||offset!==memberOffset||(automatic&&!memberCanAutoRefresh()))return;
 memberLastRefresh=Date.now();const fingerprint=query.toString()+JSON.stringify(result);
 if(automatic&&fingerprint===memberFingerprint)return;memberFingerprint=fingerprint;
 if(result.total>0&&offset>=result.total){memberOffset=Math.floor((result.total-1)/30)*30;return renderMember(automatic);}
 const scroll=automatic?captureScrollState('member'):null;
 memberRows=new Map((result.items||[]).map(x=>[x.id,x]));memberSelected=new Set([...memberSelected].filter(id=>memberRows.has(id)));
 let html=`<div class="member-shell"><nav class="member-tabs" aria-label="앱 콘텐츠 운영 메뉴">${Object.entries(memberTabs).map(([id,label])=>`<button type="button" data-member-view="${id}" aria-current="${id===view?'page':'false'}" class="${id===view?'primary':''}">${label}</button>`).join('')}</nav>`;
 if(view==='overview'){
  const stats=[['회원',result.members],['등록 게임',result.products],['이용권',result.orders],['피드 조회수',result.postViews],['미처리 신고',result.openReports]];
  html+=`<div class="member-metrics">${stats.map(([label,value])=>`<article><span>${label}</span><strong>${Number(value||0).toLocaleString('ko-KR')}</strong></article>`).join('')}</div><section class="member-panel"><h3>많이 본 피드</h3><div class="member-popular">${result.topContent.map(x=>`<div><span>${esc(x.title||x.id)}</span><strong>${Number(x.count).toLocaleString('ko-KR')}</strong></div>`).join('')||'<p class="member-empty">아직 조회 기록이 없습니다.</p>'}</div></section>`;
 }else{
  const filters=memberFilters(view);
  if(view==='charges')html+='<section class="member-panel"><h3>충전 QR 확인</h3><p class="small-note">회원이 전달한 QR 사진을 확인한 뒤 충전 금액과 게임 이용 기간을 등록합니다.</p><div class="member-filter"><input id="member-charge-file" type="file" accept="image/png,image/jpeg" aria-label="충전 QR 사진"><button type="button" data-member-action="charge.scan">QR 확인 · 충전 등록</button></div></section>';
  html+=`<section class="member-panel"><form id="member-search-form" class="member-filter"><input id="member-search" type="search" placeholder="이름·내용 검색" value="${esc(memberQuery)}" aria-label="콘텐츠 검색"><button type="submit">검색</button>${filters.length?`<select id="member-filter" aria-label="상태 필터">${[['','모든 상태'],...filters].map(([value,label])=>`<option value="${value}" ${memberFilter===value?'selected':''}>${label}</option>`).join('')}</select>`:''}${view==='posts'?`<select id="member-sort" aria-label="정렬"><option value="recent" ${memberSort==='recent'?'selected':''}>최신순</option><option value="views" ${memberSort==='views'?'selected':''}>조회순</option></select>`:''}${memberButton('reset','','초기화')}</form>`;
  let add='';if(view==='products')add=memberButton('product.new','','게임 등록');if(view==='news')add=memberButton('news.new','','소식 작성');
  html+=`<div class="member-toolbar">${add}<span>총 ${result.total||0}개</span>`;
  if(memberEditable(view))html+=`<span id="member-selected-count">선택 ${memberSelected.size}개</span>${memberButton('bulk.delete','','선택 삭제',true)}${memberButton('bulk.restore','','선택 복원')}`;
  html+='</div>';
  if(!result.items?.length)html+='<div class="member-empty">표시할 항목이 없습니다.</div>';
  else{
   html+=`<div class="table-wrap"><table><thead><tr>${memberEditable(view)?'<th><input id="member-check-all" type="checkbox" aria-label="현재 페이지 전체 선택"></th>':''}<th>항목</th><th>내용</th>${view==='posts'?'<th>조회수</th>':''}<th>작업</th></tr></thead><tbody>${result.items.map(row=>memberRow(row,view)).join('')}</tbody></table></div>`;
   if(result.total>30)html+=`<div class="member-pagination">${offset?memberButton('prev','','이전'):''}<span>${Math.floor(offset/30)+1} / ${Math.ceil(result.total/30)}페이지</span>${result.nextOffset!==null?memberButton('next','','다음'):''}</div>`;
  }
  html+='</section>';
 }
 content.innerHTML=html+'</div>';updateMemberSelection();if(scroll)restoreScrollState(scroll);
}
content.addEventListener('pointerdown',()=>{if(currentView==='member'){memberPointerDown=true;memberPointerUntil=Date.now()+2000;}});
for(const name of ['pointerup','pointercancel'])document.addEventListener(name,()=>{memberPointerDown=false;memberInteractionUntil=Date.now()+500;});
window.addEventListener('blur',()=>{memberPointerDown=false;});
content.addEventListener('scroll',()=>{memberInteractionUntil=Date.now()+700;},true);
setInterval(()=>{if(memberCanAutoRefresh()&&Date.now()-memberLastRefresh>=12000)renderMember(true).catch(()=>{});},1000);
