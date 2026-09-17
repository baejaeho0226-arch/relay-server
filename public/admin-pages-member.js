'use strict';
let memberLookupHandle='',memberLookupSection='',memberLookupOffset=0,memberLookupFingerprint='';
let memberView='overview',memberOffset=0,memberRows=new Map(),memberRenderSerial=0;
let memberQuery='',memberFilter='',memberSort='recent',memberSelected=new Set();
let memberPointerDown=false,memberPointerUntil=0,memberInteractionUntil=0,memberLastRefresh=0,memberFingerprint='';
const memberTabs={overview:'운영 요약',rewards:'이벤트·포인트',pointConversions:'포인트 교환·회수',withdrawals:'출금 신청',shop:'회원 상점',news:'소식',products:'게임',profiles:'회원',posts:'피드 글',comments:'댓글',reports:'신고',orders:'이용권 내역',ledger:'결제 원장',policies:'약관·개인정보'};
const memberStatus={PAID:'이용 대기',ACTIVE:'사용 중',REFUNDED:'환불 완료',QR_CHARGE:'이전 이용권 등록',QR_TOPUP:'잔액 충전',POINT_RECHARGE:'포인트 충전',POINT_EXCHANGE:'포인트 교환',POINT_EXCHANGE_REVERSE:'포인트 교환 회수',SHOP_PURCHASE:'상점 구매',WITHDRAW_RESERVE:'출금 신청',WITHDRAW_RELEASE:'출금 반려 · 잔액 복원',ARCADE_BET:'가상머니 베팅',ARCADE_PAYOUT:'가상머니 정산',PENDING:'확인 대기',APPROVED:'충전 완료',REJECTED:'반려',EXPIRED:'기간 만료',TOPUP:'이전 잔액 반영',PURCHASE:'구매',REFUND:'환불',OPEN:'접수',RESOLVED:'처리 완료',NOTICE:'공지',EVENT:'이벤트',ALERT:'알림'};
const memberEditable=view=>['products','news','posts','comments'].includes(view);
function memberMoney(n){return Number(n||0).toLocaleString('ko-KR')+'원';}
function memberButton(action,id,label,danger=false){return `<button type="button" data-member-action="${action}" data-id="${esc(id||'')}" class="${danger?'danger':''}">${label}</button>`;}
function memberState(row,view){if(view==='withdrawals')return {PENDING:'처리 대기',PAID:'입금 완료',REJECTED:'반려'}[row.status]||row.status;if(view==='ledger')return '기록';if(view==='profiles')return row.blocked?'이용 제한':'정상';return row.deleted?'삭제 보관':row.hidden?'숨김':row.status?memberStatus[row.status]||row.status:row.published===false?'비공개':'공개';}
function memberFilters(view){
 if(['products','news'].includes(view))return [['active','공개'],['draft','비공개'],['deleted','삭제 보관']];
 if(['posts','comments'].includes(view))return [['active','공개'],['hidden','숨김'],['deleted','삭제 보관']];
 if(view==='reports')return [['OPEN','접수'],['RESOLVED','처리 완료']];
 if(view==='withdrawals')return [['PENDING','처리 대기'],['PAID','입금 완료'],['REJECTED','반려']];
 if(view==='orders')return [['PAID','미사용'],['ACTIVE','사용 중'],['REFUNDED','환불 완료']];
 return [];
}
function memberDescription(text){
 if(!text)return '';
 return `<div class="member-preview">${esc(text)}</div>${text.length>100?`<details class="member-body"><summary>내용 더 보기</summary><p>${esc(text)}</p></details>`:''}`;
}
function memberRow(row,view){
 let title=row.title||row.nickname||row.id,meta='',body='',actions='';
 if(view==='products'){meta=accessTypeName(row.accessType)+' · '+(row.plans||[]).map(x=>x.days+'일 '+(x.available?memberMoney(x.price):'판매 준비 중')).join(' / ');body=row.description;actions=memberButton('product.edit',row.id,'수정');}
 if(view==='news'){meta=row.pinned?'상단 고정':'';body=row.body;actions=memberButton('news.edit',row.id,'수정');}
 if(view==='orders'){meta=`${row.memberHandle||row.accountId} · ${row.days}일 · ${memberMoney(row.amount)}`;body=row.activatedAt?'사용 시작 '+fmtTime(row.activatedAt):'미사용';if(!row.activatedAt&&row.status==='PAID'&&row.source!=='QR_CHARGE')actions=memberButton('order.refund',row.id,'잔액 환불',true);}
 if(view==='withdrawals'){title=(row.memberName||'회원')+' · '+(row.memberHandle||'');meta=memberMoney(row.amount)+' · '+row.bank+' · '+row.accountMasked;body='예금주: '+row.holder+(row.reason?'\n반려 사유: '+row.reason:'')+(row.processedAt?'\n처리: '+fmtTime(row.processedAt):'');if(row.status==='PENDING')actions=memberButton('withdraw.approve',row.id,'송금 완료 기록')+memberButton('withdraw.reject',row.id,'반려',true);}
 if(view==='ledger'){title=memberStatus[row.kind]||'거래';meta=`${row.memberHandle||row.accountId} · ${memberMoney(row.amount)} · ${row.kind==='QR_CHARGE'?'이용권 등록':'잔액 '+memberMoney(row.balance)}`;body=row.reference;}
 if(view==='profiles'){title='@'+row.handle+' · '+row.nickname;meta=`잔액 ${memberMoney(row.balance)}`;body=row.bio;actions=memberButton('profile.lookup',row.id,'통합 조회')+memberButton('profile.edit',row.id,'프로필 수정')+memberButton('profile.block',row.id,row.blocked?'제한 해제':'이용 제한',!row.blocked);}
 if(view==='posts'||view==='comments'){title=(row.memberHandle?row.memberHandle+' · ':'')+(row.author?.nickname||row.accountId);body=row.body||'작성자가 삭제한 내용입니다.';if(!row.deleted)actions=memberButton(view==='posts'?'post.edit':'comment.edit',row.id,'수정')+memberButton('content.'+(row.hidden?'show':'hide'),row.id,row.hidden?'공개':'숨기기');}
 if(view==='reports'){meta=`${row.memberHandle||row.accountId}`;body=row.reason+(row.resolution?'\n처리 메모: '+row.resolution:'');actions=memberButton('report.post',row.id,'신고 글')+memberButton(row.status==='OPEN'?'report.resolve':'report.reopen',row.id,row.status==='OPEN'?'처리 완료':'다시 열기');}
 if(memberEditable(view)){
  if(row.deleted){if(!row.deletedByMember&&(!['posts','comments'].includes(view)||(row.body||row.imageThumb)))actions+=memberButton('content.restore',row.id,'복원');}
  else actions+=memberButton('content.delete',row.id,'삭제',true);
 }
 if(['products','news'].includes(view)&&!row.deleted)actions+=memberButton('content.'+(row.published?'unpublish':'publish'),row.id,row.published?'비공개':'공개');
 const category=view==='news'?memberNewsCategory(row.category):view==='products'?(row.genre||row.details?.genre||'기타'):'';
 return `<tr ${category?`class="member-category-row"`:''}>${memberEditable(view)?`<td><input type="checkbox" class="member-check" aria-label="${esc(title)} 선택" data-id="${esc(row.id)}" ${memberSelected.has(row.id)?'checked':''}></td>`:''}<td class="member-item">${!['news','products'].includes(view)&&row.imageThumb?`<img class="member-content-thumb" src="${esc(row.imageThumb)}" alt="등록 사진">`:""}${view==='products'?`<div class="member-game-card">${row.imageCover?`<img class="member-game-photo" src="${esc(row.imageCover)}" alt="${esc(title)} 사진" loading="lazy" decoding="async">`:'<div class="member-game-photo member-game-placeholder">사진 준비 중</div>'}<div class="member-game-copy"><strong>${esc(title)}</strong><span class="member-game-genre">${esc(category)}</span></div></div>`:`${category?`<span class="member-category-label">${memberCategoryIcon(category,view)}${esc(memberStatus[category]||category)}</span>`:''}<strong>${esc(title)}</strong>`}<div class="small-note">${esc(fmtTime(row.updatedAt||row.at||row.createdAt))}</div><span class="member-badge">${esc(memberState(row,view))}</span></td><td class="member-detail">${meta?`<div class="member-meta">${esc(meta)}</div>`:''}${memberDescription(body)}${view==='posts'&&row.quote?memberQuotePreview(row.quote):''}</td>${view==='posts'?`<td class="member-views">${Number(row.views||0).toLocaleString('ko-KR')}</td>`:''}<td><div class="actions">${actions||'—'}</div></td></tr>`;
}
function memberCanAutoRefresh(){
 const search=content.querySelector('#member-search');
 if(search&&search.value.trim()!==memberQuery)return false;
 return isMemberPage()&&!document.hidden&&!(memberPointerDown&&Date.now()<memberPointerUntil)&&Date.now()>=memberInteractionUntil&&memberSelected.size===0&&
  !content.querySelector('details[open]')&&!document.querySelector('#modal:not(.hidden)')&&
  !(content.contains(document.activeElement)&&document.activeElement.matches('input,textarea,select'));
}
async function renderMember(automatic=false){
 if(!isMemberPage()||(automatic&&!memberCanAutoRefresh()))return;
 if(memberView==='profiles'&&memberLookupHandle)return renderMemberLookup(automatic);
 const serial=++memberRenderSerial,view=memberView,offset=memberOffset;
 const query=new URLSearchParams({view,offset:String(offset),limit:'30',q:memberQuery,status:memberFilter,sort:memberSort});
 const result=await api('/api/member?'+query);
 if(serial!==memberRenderSerial||!isMemberPage()||view!==memberView||offset!==memberOffset||(automatic&&!memberCanAutoRefresh()))return;
 memberLastRefresh=Date.now();const fingerprint=query.toString()+JSON.stringify(result);
 if(automatic&&fingerprint===memberFingerprint)return;memberFingerprint=fingerprint;
 if(result.total>0&&offset>=result.total){memberOffset=Math.floor((result.total-1)/30)*30;return renderMember(automatic);}
 const scroll=automatic?captureScrollState(currentView):null;
 memberRows=new Map((result.items||[]).map(x=>[x.id,x]));memberSelected=new Set([...memberSelected].filter(id=>memberRows.has(id)));
 let html='<div class="member-shell">';
 if(view==='pointConversions'){html+=memberConversionPanel(result);
 }else if(view==='shop'){html+=memberShopPanel(result);
 }else if(view==='rewards'){html+=memberRewardsPanel(result);
 }else if(view==='policies'){
  html+='<section class="member-panel"><h3>앱 약관과 개인정보 처리방침</h3><p class="small-note">게시한 문서는 모아플레이 설정에 표시됩니다. 실제 운영 내용을 작성해 주세요.</p>'+(result.items||[]).map(x=>`<article class="member-policy"><h4>${esc(x.title)}</h4><span class="member-badge">${x.published?'게시 중':'미게시'}</span><p class="small-note">${x.updatedAt?esc(fmtTime(x.updatedAt)):'등록된 문서 없음'}</p>${memberButton('policy.edit',x.kind,'문서 수정')}</article>`).join('')+'</section>';
 }else if(view==='overview'){
  const stats=[['회원',result.members],['등록 게임',result.products],['이용권',result.orders],['피드 조회수',result.postViews],['미처리 신고',result.openReports]];
  html+=`<div class="member-metrics">${stats.map(([label,value])=>`<article><span>${label}</span><strong>${Number(value||0).toLocaleString('ko-KR')}</strong></article>`).join('')}</div><section class="member-panel"><h3>많이 본 피드</h3><div class="member-popular">${result.topContent.map(x=>`<div><span>${esc(x.title||x.id)}</span><strong>${Number(x.count).toLocaleString('ko-KR')}</strong></div>`).join('')||'<p class="member-empty">아직 조회 기록이 없습니다.</p>'}</div></section>`;
 }else{
  const filters=memberFilters(view);
   html+=`<section class="member-panel"><form id="member-search-form" class="member-filter"><input id="member-search" type="search" placeholder="이름·내용·@아이디 검색" value="${esc(memberQuery)}" aria-label="콘텐츠 검색"><button type="submit">검색</button>${filters.length?`<select id="member-filter" aria-label="상태 필터">${[['','모든 상태'],...filters].map(([value,label])=>`<option value="${value}" ${memberFilter===value?'selected':''}>${label}</option>`).join('')}</select>`:''}${view==='posts'?`<select id="member-sort" aria-label="정렬"><option value="recent" ${memberSort==='recent'?'selected':''}>최신순</option><option value="views" ${memberSort==='views'?'selected':''}>조회순</option></select>`:''}${memberButton('reset','','초기화')}</form>`;
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
content.addEventListener('pointerdown',()=>{if(isMemberPage()){memberPointerDown=true;memberPointerUntil=Date.now()+2000;}});
for(const name of ['pointerup','pointercancel'])document.addEventListener(name,()=>{memberPointerDown=false;memberInteractionUntil=Date.now()+500;});
window.addEventListener('blur',()=>{memberPointerDown=false;});
content.addEventListener('scroll',()=>{memberInteractionUntil=Date.now()+700;},true);
setInterval(()=>{if(memberCanAutoRefresh()&&Date.now()-memberLastRefresh>=12000)renderMember(true).catch(()=>{});},1000);


function memberNewsCategory(value){return value==='UPDATE'?'NOTICE':value;}
function memberCategoryIcon(value,view){
 const news={NOTICE:'<path d="M3 10v4h4l9 4V6l-9 4H3Zm4 4 2 6h3l-2-5M20 9v6"/>',ALERT:'<path d="M5 17h14l-2-3v-4a5 5 0 0 0-10 0v4l-2 3Zm5 3h4M12 3v2"/>',EVENT:'<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-11 5h6m-3-3v6"/>'};
 const games={RPG:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-3 9 2 2 4-5"/>','레이싱':'<path d="m5 10 2-5h10l2 5M4 10h16v8H4v-8Zm2 8v3m12-3v3M7 13h2m6 0h2"/>','액션':'<path d="m14 3-2 7h7L9 21l2-8H5L14 3Z"/>','리듬':'<path d="M10 17V5l10-2v12M10 8l10-2"/><circle cx="7" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>','캐주얼':'<circle cx="12" cy="12" r="9"/><path d="M8 9h.01M16 9h.01M8 14c2 4 6 4 8 0"/>','스포츠':'<circle cx="12" cy="12" r="9"/><path d="m12 7 5 4-2 6H9l-2-6 5-4ZM12 3v4m9 3-4 1m.5 8-2.5-2m-8.5 2L9 17M3 10l4 1"/>','전략':'<path d="M5 21h14l-2-5H7l-2 5Zm3-5V8h8v8M6 3v5h12V3M12 3v5"/>','시뮬레이션':'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9"/>','어드벤처':'<circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5 5-3Z"/>','퍼즐':'<path d="M4 4h6a3 3 0 1 1 6 0h4v6a3 3 0 1 0 0 6v4h-6a3 3 0 1 0-6 0H4V4Z"/>','슈팅':'<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>'};
 const fallback='<path d="M8 7h8c3 0 5 8 4 11-1 2-4-2-5-3H9c-1 1-4 5-5 3-1-3 1-11 4-11Z"/><path d="M7 10v4m-2-2h4m7-1h.01m2 2h.01"/>';
 return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${view==='news'?(news[memberNewsCategory(value)]||news.NOTICE):(Object.hasOwn(games,value)?games[value]:fallback)}</svg>`;
}
const memberRecordNames={orders:'이용권 내역',payments:'결제 내역',charges:'QR 충전',posts:'게시물',comments:'댓글',reports:'신고',followers:'팔로워',following:'팔로잉',devices:'등록 기기',qr:'출입증 QR',support:'상담 기록'};
const memberInfoStatus={AVAILABLE:'수집 완료',UNAVAILABLE:'확인할 수 없음',NOT_AVAILABLE:'확인할 수 없음',PERMISSION_DENIED:'권한 없음',UNSUPPORTED:'지원하지 않음',UNKNOWN:'미확인',VERIFIED:'인증 완료',ENROLLING:'등록 중',CHALLENGE:'인증 대기',FAILED:'인증 실패',SUPERSEDED:'다른 요청으로 변경',CLOSED:'종료',DELETED:'삭제 보관',NONE:'미등록',VALID:'유효',ACTIVE:'유효',PENDING:'확인 대기',APPROVED:'승인 완료',REJECTED:'반려',EXPIRED:'만료',SUSPENDED:'정지'};
function memberFacts(rows){return '<dl class="member-facts">'+rows.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value===undefined||value===null||value===''?'등록된 정보 없음':(memberInfoStatus[String(value)]||String(value)))}</dd></div>`).join('')+'</dl>';}
async function renderMemberLookup(automatic=false){
 if(memberView!=='profiles'||!memberLookupHandle)return;
 const handle=memberLookupHandle,section=memberLookupSection,offset=memberLookupOffset,serial=++memberRenderSerial;
 const result=await api('/api/member?'+new URLSearchParams({view:'lookup',handle,section,offset:String(offset),limit:'30'}));
 if(serial!==memberRenderSerial||memberView!=='profiles'||handle!==memberLookupHandle||section!==memberLookupSection||offset!==memberLookupOffset||(automatic&&!memberCanAutoRefresh()))return;
 const fingerprint=JSON.stringify([handle,section,offset,result]);memberLastRefresh=Date.now();if(automatic&&memberLookupFingerprint===fingerprint)return;memberLookupFingerprint=fingerprint;
 const position=automatic?captureScrollState(currentView):null;memberRows=new Map([[result.profile.id,result.profile],...(result.items||[]).map(row=>[row.id,row])]);
 const p=result.profile;let html='<div class="member-shell member-dossier">'+memberButton('lookup.back','','회원 목록')+`<section class="member-panel"><div class="member-dossier-heading">${p.avatar?`<img src="${esc(p.avatar)}" alt="프로필 사진">`:''}<div><h2>@${esc(p.handle)}</h2><p>${esc(p.nickname)}</p></div><strong>${memberMoney(p.balance)}</strong></div>`;
 html+='<div class="actions">'+memberButton('profile.edit',p.id,'프로필 수정')+memberButton('lookup.qr','','QR 인증 · 충전 관리')+'</div>';
 html+='<div class="member-lookup-tabs">'+memberButton('lookup.section','','등록 정보')+Object.entries(memberRecordNames).map(([key,label])=>memberButton('lookup.section',key,label+(result.counts?.[key]!==undefined?' '+result.counts[key]:''))).join('')+'</div></section>';
 if(section){
  html+=`<section class="member-panel"><h3>${esc(memberRecordNames[section])} · ${result.total}개</h3>`;
  for(const row of result.items||[]){
   if(section==='devices'){html+=memberDeviceCard(row);continue;}
   if(section==='qr'){html+=memberQrRecord(row);continue;}
   html+='<article class="member-record">'+(row.imageThumb?`<img class="member-record-photo" src="${esc(row.imageThumb)}" alt="게시물 사진">`:'')+memberRecordFacts(row);
   if(section==='support')html+=memberButton('lookup.support',row.id,'상담 기록 / 답변');
   else if(['orders','payments','posts','comments','reports','followers','following'].includes(section))html+=memberButton('lookup.manage',section+'|'+row.id,'상세 / 관리');
   else if(section==='charges')html+=memberButton('lookup.qr','','QR 인증 · 충전 관리');
   html+='</article>';
  }
  if(!result.items?.length)html+='<p class="member-empty">아직 기록이 없습니다.</p>';
  html+='<div class="member-pagination">'+(offset?memberButton('lookup.prev','','이전'):'')+(result.nextOffset!==null?memberButton('lookup.next','','다음'):'')+'</div></section>';
 }else{
  html+=`<section class="member-panel"><h3>회원 정보</h3>${memberFacts([['가입',fmtTime(p.createdAt)],['소개',p.bio],['아이디 변경',p.handleEditable?'최초 1회 변경 가능':'변경 완료'],['닉네임 변경',p.nicknameChangeAt>Date.now()?fmtTime(p.nicknameChangeAt)+'부터 가능':'변경 가능'],['이용 상태',p.blocked?'이용 제한':'정상']])}</section>`;
  html+=memberDecorationFacts(p);
  for(const d of result.devices)html+=memberDeviceCard(d);
  html+='<section class="member-panel"><h3>출입증 QR 인증</h3>'+((result.qr||[]).map(memberQrRecord).join('')||'<p class="member-empty">등록된 인증 요청이 없습니다.</p>')+'</section>';
  html+='<section class="member-panel"><h3>고객센터</h3>'+((result.support||[]).map(t=>'<article class="member-record">'+memberFacts([['상담',t.id],['상태',t.status==='CLOSED'?'종료':t.status==='DELETED'?'삭제':'진행 중'],['대화',t.messages+'개'],['최근 변경',fmtTime(t.updatedAt)]])+`${memberButton('lookup.support',t.id,'상담 기록')}</article>`).join('')||'<p class="member-empty">상담 내역이 없습니다.</p>')+'</section>';
 }
 content.innerHTML=html+'</div>';content.querySelectorAll('[data-member-action="lookup.section"]').forEach(b=>{b.classList.toggle('primary',b.dataset.id===section);b.setAttribute('aria-pressed',String(b.dataset.id===section));});if(position)restoreScrollState(position);
}

function memberRecordFacts(row){
 const rows=[['이름',row.title||row.nickname||row.id]];
 const text={handle:'아이디',body:'내용',reason:'사유',memo:'메모',resolution:'처리 내용',reference:'연결된 거래',paymentId:'결제',productId:'게임',postId:'게시물',refundedBy:'환불 처리자',approvedBy:'승인자',rejectedBy:'반려 처리자',refundReason:'환불 사유'};
 for(const [key,label]of Object.entries(text))if(row[key])rows.push([label,key==='handle'?'@'+row[key]:row[key]]);
 if(row.status)rows.push(['상태',memberStatus[row.status]||row.status]);if(row.kind)rows.push(['거래 구분',memberStatus[row.kind]||row.kind]);
 for(const [key,label]of [['amount','금액'],['balance','거래 후 잔액']])if(row[key]!==undefined)rows.push([label,memberMoney(row[key])]);
 if(row.days)rows.push(['기간',row.days+'일']);if(row.messages!==undefined)rows.push(['대화',row.messages+'개']);
 for(const [key,label]of [['at','등록'],['updatedAt','최근 변경'],['activatedAt','사용 시작'],['expiresAt','확인 / 이용 기한'],['approvedAt','승인'],['rejectedAt','반려'],['refundedAt','환불']])if(row[key])rows.push([label,fmtTime(row[key])]);
 return memberFacts(rows);
}
function memberQrRecord(q){return '<article class="member-record">'+memberFacts([['코드',q.requestId],['기기',q.clientId],['상태',memberStatus[q.status]||q.status],['발급',fmtTime(q.issuedAt)],['승인',fmtTime(q.approvedAt)],['사유',q.reason]])+memberButton('lookup.qr','','QR 인증 · 충전 관리')+'</article>';}
function memberDeviceCard(d){
 const fields={name:'기기 이름',manufacturer:'제조사',product:'제품',model:'모델',os:'운영체제',architecture:'아키텍처',appVersion:'앱 버전',protocolVersion:'통신 버전',phone:'전화번호',phoneStatus:'전화번호 수집 상태',serial:'일련번호',serialStatus:'일련번호 수집 상태',imei:'IMEI',imeiStatus:'IMEI 수집 상태'};
 const permissions=d.permissions?.reapprovalRequired?'권한 재승인 필요':!d.online?'접속 후 확인':d.permissions?.granted?'필수 권한 허용':'확인 필요';
 const rows=[['기기 식별자',d.id],['별칭',d.alias],['서버',d.serverId],['최근 접속',fmtTime(d.lastSeenAt)],['출입증',d.entryPass?d.entryPass.status:'미등록'],['앱 권한',permissions],['생체인증',d.biometric.enrolled?'등록됨':'미등록'],['생체인증 등록',fmtTime(d.biometric.enrolledAt)],['최근 생체인증',fmtTime(d.biometric.verifiedAt)],['인증 횟수',d.biometric.verificationCount],['생체인증 초기화',fmtTime(d.biometric.resetAt)],['기기 인증',d.authentication.verified?'확인 완료':memberInfoStatus[d.authentication.status]||d.authentication.status],['기기 인증 등록',fmtTime(d.authentication.enrolledAt)],['최근 기기 인증',fmtTime(d.authentication.verifiedAt)],...Object.entries(fields).map(([key,label])=>[label,d.device[key]])];
 if(d.note)rows.push(['관리자 메모',d.note]);if(d.uiState)rows.push(['화면 상태',uiText(d.uiState.status)],['화면 상태 확인',fmtTime(d.uiState.updatedAt)]);for(const [key,enabled]of Object.entries(d.flags||{}))rows.push([memberCapabilityName(key),enabled?'사용':'사용 안 함']);rows.push(['등록된 지원 기능',(d.capabilities||[]).map(memberCapabilityName).join(', ')||'미등록']);
 return `<section class="member-panel"><h3>${esc(d.device.model||d.device.name||'등록 기기')} · ${d.online?'온라인':'오프라인'}</h3>${memberFacts(rows)}<div class="actions">${d.registered?`<button data-client-action="detail" data-id="${esc(d.id)}">기기 상세 / 관리</button><button data-client-action="biometric" data-id="${esc(d.id)}">생체인증 관리</button>`:''}</div></section>`;
}
function memberCapabilityName(key){return {DEVICE_HMAC:'기기 서명 인증',QR_DEVICE_APPROVAL:'QR 출입증 인증',STRONG_BIOMETRIC:'생체인증',MEMBER_HUB:'회원 서비스',SUPPORT_CENTER:'고객센터',REMOTE_COMMANDS:'원격 명령',REMOTE_DIAGNOSTICS:'진단 수집',UI_STATE:'화면 상태',CONFIG_UPDATE:'설정 동기화',AUTO_UPDATE:'자동 업데이트',DEVICE_HMAC_ENFORCE:'기기 서명 필수',ADVANCED_NOTICE:'확장 알림',PROCESS_RESULT:'처리 결과',PROTOCOL_V3_PREVIEW:'차세대 통신 시험',EVENT_SEQUENCE:'이벤트 순서 확인'}[key]||key;}

function memberQuotePreview(quote){return `<aside class="member-quote-preview"><span class="small-note">리포스트 원글 · ${esc(quote.id)}</span>${quote.deleted?'<p>삭제된 원글입니다.</p>':`${quote.hidden?'<p class="small-note">숨김 처리된 원글</p>':''}<strong>${esc(quote.author?.nickname||'회원')}</strong>${quote.image?`<img class="member-content-thumb" src="${esc(quote.image)}" alt="원글 사진">`:''}${quote.title?`<b>${esc(quote.title)}</b>`:''}<div>${esc(quote.body||'')}</div>`}</aside>`;}
