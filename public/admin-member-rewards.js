'use strict';
let memberRewardRules=null;
function memberRewardsPanel(result){
 memberRewardRules=result.rules;const r=result.rules,total=r.prizes.reduce((n,p)=>n+p.weight,0);
 const points=n=>Number(n||0).toLocaleString('ko-KR')+' P',exchange=r.pointExchange||{enabled:false,cashUnit:0,pointUnit:0};
 const kinds={ATTENDANCE:'출석 보상',ROULETTE:'룰렛 보상',POINT_RECHARGE:'포인트 충전',POINT_EXCHANGE:'포인트 교환'};
 return `<section class="member-panel"><div class="member-toolbar"><h3>출석 · 룰렛 이벤트</h3>${memberButton('rewards.edit','','보상 기준 수정')}</div><div class="member-metrics"><article><span>연속 출석 보상</span><strong>${r.attendanceDays}일 · ${points(r.attendancePoints)}</strong></article><article><span>룰렛 참여권</span><strong>충전 ${memberMoney(r.chargeUnit)}당 1회</strong></article><article><span>룰렛 운영</span><strong>${r.enabled?'진행 중':'일시 중지'}</strong></article></div><div class="member-metrics"><article><span>포인트 충전 · 교환</span><strong>${exchange.enabled?memberMoney(exchange.cashUnit)+' ↔ '+points(exchange.pointUnit):'준비 중'}</strong></article></div><p class="small-note">충전 승인이 완료되면 참여 횟수가 지급됩니다. 기준 금액 미만의 충전은 다음 충전과 합산됩니다. 포인트는 현금 잔액과 별도로 기록됩니다. 충전·교환은 지정한 단위로 양방향 처리하며 추가 룰렛 횟수는 지급하지 않습니다.</p><div class="member-metrics">${r.prizes.map((p,i)=>`<article><span>${i+1}번 칸 · ${(p.weight/total*100).toFixed(1)}%</span><strong>${points(p.points)}</strong></article>`).join('')}</div></section><section class="member-panel"><h3>포인트 내역</h3>${result.items?.length?`<div class="table-wrap"><table><thead><tr><th>회원</th><th>구분</th><th>포인트</th><th>처리 후</th><th>시각</th></tr></thead><tbody>${result.items.map(x=>`<tr><td>${esc(x.member.nickname)}<div class="small-note">@${esc(x.member.handle)}</div></td><td>${kinds[x.kind]||'포인트 기록'}</td><td>${x.amount>0?'+':''}${points(x.amount)}</td><td>${points(x.balance)}</td><td>${esc(fmtTime(x.at))}</td></tr>`).join('')}</tbody></table></div>`:'<p class="member-empty">아직 포인트 내역이 없습니다.</p>'}${result.total>30?`<div class="member-pagination">${memberOffset?memberButton('prev','','이전'):''}<span>${Math.floor(memberOffset/30)+1}페이지</span>${result.nextOffset!==null?memberButton('next','','다음'):''}</div>`:''}</section>`;
}
async function editMemberRewards(){
 const r=memberRewardRules;if(!r)return;const exchange=r.pointExchange||{enabled:false,cashUnit:0,pointUnit:0};
 const fields=[{name:'enabled',label:'룰렛 운영',type:'select',value:String(r.enabled),options:[{value:'true',label:'진행 중'},{value:'false',label:'일시 중지'}]},
  {name:'attendanceDays',label:'연속 출석 목표 (1~31일)',type:'number',value:r.attendanceDays},
  {name:'attendancePoints',label:'출석 보상 포인트',type:'number',value:r.attendancePoints},
  {name:'chargeUnit',label:'참여 1회당 승인 충전 금액 (원)',type:'number',value:r.chargeUnit},
  {type:'section',label:'포인트 충전 · 교환 (현금 잔액 ↔ 포인트)'},
  {name:'pointExchangeEnabled',label:'포인트 충전 · 교환 운영',type:'select',value:String(exchange.enabled),options:[{value:'false',label:'준비 중'},{value:'true',label:'이용 가능'}]},
  {name:'cashUnit',label:'교환 단위 · 충전 잔액 (원)',type:'number',value:exchange.cashUnit},
  {name:'pointUnit',label:'교환 단위 · 포인트 (P)',type:'number',value:exchange.pointUnit},
  ...r.prizes.flatMap((p,i)=>[{type:'section',label:`룰렛 ${i+1}번 칸`},{name:'points'+i,label:'지급 포인트',type:'number',value:p.points},{name:'weight'+i,label:'당첨 비중',type:'number',value:p.weight}])];
 const values=await openModal({title:'이벤트 보상 기준',fields,confirmLabel:'저장'});if(!values)return;
 const prizes=r.prizes.map((_,i)=>({points:Number(values['points'+i]),weight:Number(values['weight'+i])}));
 await api('/api/member/action',{method:'POST',body:{action:'rewards.save',revision:r.revision,enabled:values.enabled==='true',attendanceDays:Number(values.attendanceDays),attendancePoints:Number(values.attendancePoints),chargeUnit:Number(values.chargeUnit),prizes,pointExchange:{enabled:values.pointExchangeEnabled==='true',cashUnit:Number(values.cashUnit),pointUnit:Number(values.pointUnit)}}});
 toast('보상 기준을 저장했습니다.');await renderMember();
}
