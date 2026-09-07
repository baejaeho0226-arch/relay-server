'use strict';
let memberView='overview',memberOffset=0,memberRows=new Map(),memberRenderSerial=0;
let memberQuery='',memberFilter='',memberSort='recent',memberSelected=new Set();
const memberTabs={overview:'운영 요약',coins:'코인·입금 주소',products:'상품',news:'소식',topups:'충전 요청',orders:'구매 내역',ledger:'결제 원장',profiles:'회원',posts:'피드 글',comments:'댓글',reports:'신고',analytics:'조회 통계'};
const memberStatus={PAID:'구매 완료',ACTIVE:'사용 중',REFUNDED:'환불 완료',PENDING:'확인 대기',APPROVED:'충전 완료',REJECTED:'반려',CANCELED:'취소',TOPUP:'충전',PURCHASE:'구매',REFUND:'환불',OPEN:'접수',RESOLVED:'처리 완료',UPDATE:'업데이트',NOTICE:'공지',EVENT:'이벤트',ALERT:'알림'};
const memberScreenNames={news:'소식',article:'소식 상세',catalog:'쇼핑',checkout:'상품 상세',me:'마이페이지',orders:'구매 내역',payments:'결제 내역',topups:'충전 내역',topup:'코인 선택',deposit:'입금 안내',profile:'프로필 편집',feed:'피드',comments:'댓글',compose:'글 작성',report:'신고',menu:'메뉴',about:'앱 정보',support:'고객센터'};
function memberMoney(n){return Number(n||0).toLocaleString('ko-KR')+'원';}
function memberButton(action,id,label,danger=false){return `<button type="button" data-member-action="${action}" data-id="${esc(id||'')}" class="${danger?'danger':''}">${label}</button>`;}
function memberState(row,view){if(view==='analytics')return '집계';if(view==='ledger')return '기록';if(view==='profiles')return row.blocked?'이용 제한':'정상';return row.deleted?'삭제 보관':row.hidden?'숨김':row.status?memberStatus[row.status]||row.status:row.published===false?'비공개':row.enabled===false?'중지':'공개';}
function memberRow(row,view){
    let title=row.title||row.nickname||row.id,detail='',actions='';
    if(view==='coins'){title=`${row.symbol} · ${row.name}`;detail=`${row.network}\n주소 ${row.address}\n메모 ${row.memo||'없음'}\n1 ${row.symbol} = ${row.krwPerCoin}원 · 확인 ${row.confirmations}회`;actions=memberButton('coin.edit',row.id,'수정')+memberButton('copy',row.id,'주소 복사');}
    if(view==='products'){detail=`${accessTypeName(row.accessType)} · ${row.days}일 · ${memberMoney(row.price)} · 재고 ${row.stock===-1?'무제한':row.stock}\n${row.description}`;actions=memberButton('product.edit',row.id,'수정');}
    if(view==='news'){detail=`${memberStatus[row.category]}${row.pinned?' · 상단 고정':''}\n${row.body}`;actions=memberButton('news.edit',row.id,'수정');}
    if(view==='topups'){
        const c=row.coin;detail=`회원 ${row.accountId}\n${memberMoney(row.amount)}${c?` · ${row.coinAmount} ${c.symbol} · ${c.network}\n수신 ${c.address}\n거래 ${row.txHash}`:` · ${row.depositor||'기존 입금 요청'}`}\n${row.note||''}${row.reason?'\n처리 사유 '+row.reason:''}`;
        if(row.status==='PENDING')actions=memberButton('topup.approve',row.id,'입금 확인·승인')+memberButton('topup.reject',row.id,'반려',true);
        if(['REJECTED','CANCELED'].includes(row.status))actions=memberButton('topup.reopen',row.id,'재검토');
    }
    if(view==='orders'){detail=`${row.accountId}\n${memberMoney(row.amount)} · ${row.activatedAt?'사용 시작 '+fmtTime(row.activatedAt):'미사용'}`;if(!row.activatedAt&&row.status==='PAID')actions=memberButton('order.refund',row.id,'잔액 환불',true);}
    if(view==='ledger')detail=`${row.accountId} · ${memberStatus[row.kind]}\n${memberMoney(row.amount)} · 잔액 ${memberMoney(row.balance)}\n${row.reference}`;
    if(view==='profiles'){detail=`${row.id}\n잔액 ${memberMoney(row.balance)} · ${row.blocked?'이용 제한':'정상'}\n${row.bio}`;actions=memberButton('profile.edit',row.id,'프로필 수정')+memberButton('profile.block',row.id,row.blocked?'제한 해제':'이용 제한',!row.blocked);}
    if(view==='posts'||view==='comments'){title=row.author?.nickname||row.accountId;detail=row.body||'작성자가 삭제한 내용입니다.';if(!row.deleted)actions=memberButton(view==='posts'?'post.edit':'comment.edit',row.id,'수정')+memberButton('content.'+(row.hidden?'show':'hide'),row.id,row.hidden?'다시 공개':'숨기기');}
    if(view==='reports'){detail=`${row.accountId} · 글 ${row.postId}\n${row.reason}\n${row.resolution||''}`;actions=memberButton('report.post',row.id,'신고 글 보기')+memberButton(row.status==='OPEN'?'report.resolve':'report.reopen',row.id,row.status==='OPEN'?'처리 완료':'다시 열기');}
    if(view==='analytics'){title=memberScreenNames[row.id]||row.title||row.id;detail={screen:'화면',product:'상품',news:'소식',post:'피드',comment:'댓글',profile:'프로필'}[row.kind]||row.kind;}
    const editable=['coins','products','news','posts','comments'].includes(view);
    if(editable){if(row.deleted){if(!row.deletedByMember&&(!['posts','comments'].includes(view)||row.body))actions+=memberButton('content.restore',row.id,'복원');}else actions+=memberButton('content.delete',row.id,'삭제',true);}
    if(['products','news'].includes(view)&&!row.deleted)actions+=memberButton('content.'+(row.published?'unpublish':'publish'),row.id,row.published?'비공개':'공개');
    return `<tr><td>${editable?`<input type="checkbox" class="member-check" aria-label="${esc(title)} 선택" data-id="${esc(row.id)}" ${memberSelected.has(row.id)?'checked':''}>`:''}</td><td><strong>${esc(title)}</strong><div class="small-note">${esc(fmtTime(row.updatedAt||row.at||row.createdAt))}</div><span class="member-badge">${esc(memberState(row,view))}</span></td><td class="member-detail">${esc(detail)}</td><td class="member-views">${row.views!==undefined||row.count!==undefined?Number(row.views??row.count).toLocaleString('ko-KR'):'—'}</td><td><div class="actions">${actions}</div></td></tr>`;
}
async function renderMember(){
    if(currentView!=='member')return;
    const serial=++memberRenderSerial,view=memberView,offset=memberOffset;
    const query=new URLSearchParams({view,offset:String(offset),limit:'30',q:memberQuery,status:memberFilter,sort:memberSort});
    const result=await api('/api/member?'+query);
    if(serial!==memberRenderSerial||currentView!=='member'||view!==memberView||offset!==memberOffset)return;
    memberRows=new Map((result.items||[]).map(x=>[x.id,x]));
    memberSelected=new Set([...memberSelected].filter(id=>memberRows.has(id)));
    let html=`<div class="member-shell"><div class="member-heading"><div><span class="member-kicker">앱 콘텐츠 운영</span><h2>${memberTabs[view]}</h2></div>${memberButton('refresh','','새로고침')}</div><nav class="member-tabs" aria-label="앱 콘텐츠 운영 메뉴">${Object.entries(memberTabs).map(([id,label])=>`<button data-member-view="${id}" class="${id===view?'primary':''}">${label}</button>`).join('')}</nav>`;
    if(view==='overview'){
        const stats=[['총 화면 조회',result.pageViews],['회원',result.members],['공개 입금 수단',result.coins],['충전 확인 대기',result.pendingTopups],['판매 상품',result.products],['미처리 신고',result.openReports]];
        html+=`<div class="member-metrics">${stats.map(([label,value])=>`<article><span>${label}</span><strong>${Number(value||0).toLocaleString('ko-KR')}</strong></article>`).join('')}</div><div class="member-columns"><section class="section-card"><h3>충전 안내</h3><p>${esc(result.settings.topupInstructions)}</p><p>접수 ${result.settings.topupEnabled?'사용 중':'중지'} · 확인 대기 ${memberMoney(result.pendingAmount)}</p><p>누적 충전 ${memberMoney(result.totalTopup)} · 순 판매 ${memberMoney(result.netSales)}</p>${memberButton('settings','','충전 설정')}</section><section class="section-card"><h3>많이 본 콘텐츠</h3>${result.topContent.map(x=>`<p><strong>${Number(x.count).toLocaleString('ko-KR')}</strong> · ${esc(x.title||x.id)}</p>`).join('')||'<p>아직 조회 기록이 없습니다.</p>'}<p class="small-note">회원별 하루 1회 집계합니다. 피드·댓글은 목록 노출을 포함합니다.</p></section></div>`;
    }else{
        html+=`<form id="member-search-form" class="member-filter"><input id="member-search" type="search" placeholder="내용·회원·주소·거래 해시 검색" value="${esc(memberQuery)}" aria-label="콘텐츠 검색"><button type="submit">검색</button><select id="member-filter" aria-label="상태 필터">${[['','모든 상태'],['active','공개'],['draft','비공개'],['deleted','삭제 보관'],['hidden','숨김'],['PENDING','확인 대기'],['APPROVED','충전 완료'],['REJECTED','반려'],['CANCELED','취소'],['OPEN','신고 접수'],['RESOLVED','신고 처리'],['PAID','미사용 구매'],['ACTIVE','사용 중'],['REFUNDED','환불']].map(([value,label])=>`<option value="${value}" ${memberFilter===value?'selected':''}>${label}</option>`).join('')}</select><select id="member-sort" aria-label="정렬"><option value="recent" ${memberSort==='recent'?'selected':''}>최신순</option><option value="views" ${memberSort==='views'?'selected':''}>조회순</option></select>${memberButton('reset','','초기화')}</form>`;
        let add='';if(view==='products')add=memberButton('product.new','','상품 등록');if(view==='news')add=memberButton('news.new','','소식 작성');if(view==='coins')add=memberButton('coin.new','','코인·주소 추가');
        html+=`<div class="toolbar">${add}<span>전체 ${result.total||0}개</span>`;
        if(['coins','products','news','posts','comments'].includes(view))html+=`<span id="member-selected-count">선택 ${memberSelected.size}개</span>${memberButton('bulk.delete','','선택 삭제',true)}${memberButton('bulk.restore','','선택 복원')}`;
        html+=`</div><div class="section-card"><div class="table-wrap"><table><thead><tr><th><input id="member-check-all" type="checkbox" aria-label="현재 페이지 전체 선택"></th><th>항목</th><th>내용</th><th>조회</th><th>작업</th></tr></thead><tbody>${(result.items||[]).map(row=>memberRow(row,view)).join('')||'<tr><td colspan="5" class="empty">조건에 맞는 항목이 없습니다.</td></tr>'}</tbody></table></div><div class="toolbar">${offset?memberButton('prev','','이전'):''}<span>${result.total?offset+1:0}–${Math.min(offset+30,result.total||0)}</span>${result.nextOffset!==null?memberButton('next','','다음'):''}</div></div>`;
    }
    content.innerHTML=html+'</div>';content.dataset.topupEnabled=String(result.settings?.topupEnabled||false);content.dataset.topupInstructions=result.settings?.topupInstructions||'';
    updateMemberSelection();
}
