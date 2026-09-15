'use strict';
let memberShopRules=null;
const memberShopNames={NICKNAME_TICKET:'닉네임 변경권',NICKNAME_COLOR:'닉네임 색상',TITLE_COLOR:'칭호 색상 세트',TITLE_NAME:'칭호 이름 변경권'};
const memberShopDescriptions={NICKNAME_TICKET:'닉네임 변경 대기 없이 1회 변경',NICKNAME_COLOR:'선택한 닉네임 색상 1회 적용',TITLE_COLOR:'보유 칭호의 글자·아이콘 색상 함께 1회 적용',TITLE_NAME:'모든 기본 칭호 보유 시 구매 가능 · 칭호 이름 1회 변경'};
function memberPageButtons(result){return result.total>30?`<div class="member-pagination">${memberOffset?memberButton('prev','','이전'):''}<span>${Math.floor(memberOffset/30)+1}페이지</span>${result.nextOffset!==null?memberButton('next','','다음'):''}</div>`:'';}
function memberConversionPanel(result){
 const rows=result.items||[];
 return `<section class="member-panel"><form id="member-search-form" class="member-filter"><input id="member-search" type="search" placeholder="회원 이름·@아이디·교환 번호 검색" value="${esc(memberQuery)}" aria-label="포인트 교환 검색"><button type="submit">검색</button><select id="member-filter" aria-label="교환 상태">${[['','모든 상태'],['COMPLETED','교환 완료'],['REVERSED','회수 완료']].map(([value,label])=>`<option value="${value}" ${memberFilter===value?'selected':''}>${label}</option>`).join('')}</select>${memberButton('reset','','초기화')}</form><div class="member-toolbar"><h3>포인트 교환 · 회수</h3><span>총 ${Number(result.total||0).toLocaleString('ko-KR')}건</span></div><p class="small-note">회수하면 교환으로 지급된 충전 잔액을 되돌리고 사용한 포인트를 회원에게 복원합니다. 회수할 잔액이 부족하면 처리되지 않습니다.</p>${rows.length?`<div class="table-wrap"><table><thead><tr><th>회원</th><th>교환</th><th>상태 · 처리 시각</th><th>작업</th></tr></thead><tbody>${rows.map(x=>`<tr><td><strong>${esc(x.member?.nickname||x.memberNickname||x.nickname||x.memberHandle||'회원')}</strong><div class="small-note">@${esc(String(x.memberHandle||'').replace(/^@/,''))}</div></td><td>${Math.abs(Number(x.sourceAmount??x.pointAmount??0)).toLocaleString('ko-KR')} P → ${memberMoney(x.cashAmount??x.targetAmount)}<div class="small-note">${esc(x.id)}</div></td><td><span class="member-badge">${x.status==='REVERSED'?'회수 완료':'교환 완료'}</span><div class="small-note">${esc(fmtTime(x.reversedAt||x.at))}</div>${x.reason?`<div class="small-note">${esc(x.reason)}</div>`:''}</td><td>${x.status==='REVERSED'?`<span class="small-note">${esc(x.reversedBy||'처리 완료')}</span>`:memberButton('points.reverse',x.id,'회수하기',true)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="member-empty">아직 교환 내역이 없습니다.</p>'}${memberPageButtons(result)}</section>`;
}
function memberShopPanel(result){
 memberShopRules=result.rules;const rules=result.rules,purchases=result.purchases||{items:[],total:0,nextOffset:null};
 return `<section class="member-panel"><div class="member-toolbar"><h3>회원 상점</h3>${memberButton('shop.edit','','판매 설정')}</div><div class="member-metrics">${Object.entries(memberShopNames).map(([id,name])=>{const item=rules.items[id]||{};return `<article><span>${name}</span><strong>${item.enabled?Number(item.price||0).toLocaleString('ko-KR')+' P':'판매 중지'}</strong><span>${memberShopDescriptions[id]}</span></article>`;}).join('')}</div></section><section class="member-panel"><h3>상점 구매 내역</h3>${purchases.items.length?`<div class="table-wrap"><table><thead><tr><th>회원</th><th>상품</th><th>금액</th><th>구매 시각</th></tr></thead><tbody>${purchases.items.map(x=>`<tr><td>${esc(x.member?.nickname||x.memberNickname||x.nickname||'회원')}<div class="small-note">@${esc(String(x.memberHandle||'').replace(/^@/,''))}</div></td><td>${esc(memberShopNames[x.itemId]||x.title||'상점 상품')}</td><td>${Number(x.price??x.amount??0).toLocaleString('ko-KR')} P</td><td>${esc(fmtTime(x.at))}</td></tr>`).join('')}</tbody></table></div>`:'<p class="member-empty">아직 구매 내역이 없습니다.</p>'}${memberPageButtons(purchases)}</section>`;
}
async function editMemberShop(){
 const rules=memberShopRules;if(!rules)return;
 const fields=Object.entries(memberShopNames).flatMap(([id,name])=>[{type:'section',label:name},{name:id+'_enabled',label:'판매 상태',type:'select',value:String(!!rules.items[id]?.enabled),options:[{value:'false',label:'판매 중지'},{value:'true',label:'판매 중'}]},{name:id+'_price',label:'가격 (포인트 · P)',type:'number',value:rules.items[id]?.price||0}]);
 const values=await openModal({title:'회원 상점 판매 설정',fields,confirmLabel:'저장'});if(!values)return;
 const items={};for(const id of Object.keys(memberShopNames))items[id]={enabled:values[id+'_enabled']==='true',price:Number(values[id+'_price'])};
 await api('/api/member/action',{method:'POST',body:{action:'shop.save',revision:rules.revision,items}});toast('상점 설정을 저장했습니다.');await renderMember();
}
async function reverseMemberPoints(row){
 if(!row.id||row.status==='REVERSED')return;
 const values=await openModal({title:'포인트 교환을 회수할까요?',message:`충전 잔액 ${memberMoney(row.cashAmount??row.targetAmount)}을 회수하고 ${Math.abs(Number(row.sourceAmount??row.pointAmount??0)).toLocaleString('ko-KR')} P를 복원합니다.`,fields:[{name:'reason',label:'회수 사유',type:'textarea'}],confirmLabel:'회수하기',danger:true});
 if(!values)return;
 if(!String(values.reason||'').trim()){toast('회수 사유를 입력해주세요.',true);return;}
 await api('/api/member/action',{method:'POST',body:{action:'points.reverse',id:row.id,reason:values.reason.trim()}});toast('교환을 회수하고 포인트를 복원했습니다.');await renderMember();
}
function memberDecorationFacts(p){
 const rows=[];
 if(p.titleBadge)rows.push(['착용한 배지',p.titleBadge.name||p.titleBadge.title||p.titleBadge.label||p.titleBadge.id]);
 if(p.nicknameColor)rows.push(['닉네임 색상',p.nicknameColor]);
 if(p.inventory){rows.push(['닉네임 변경권',String(p.inventory.nicknameTickets??p.inventory.NICKNAME_TICKET??0)+'개']);rows.push(['닉네임 색상 변경권',String(p.inventory.nicknameColors??p.inventory.NICKNAME_COLOR??0)+'개']);rows.push(['칭호 색상 세트',String(p.inventory.titleColors||0)+'개']);rows.push(['칭호 이름 변경권',String(p.inventory.titleNames||0)+'개']);}
 return rows.length?`<section class="member-panel"><h3>회원 꾸미기</h3>${memberFacts(rows)}</section>`:'';
}
