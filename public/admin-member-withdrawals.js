'use strict';
async function processMemberWithdrawal(action,row){
 const latest=await api('/api/member?'+new URLSearchParams({view:'withdrawals',id:row.id}));row=latest.items?.[0];
 if(!row||row.status!=='PENDING'){toast('이미 처리되었거나 찾을 수 없는 신청입니다.',true);await renderMember();return;}
 const approve=action==='withdraw.approve';
 const values=await openModal({title:approve?'실제 송금 완료 확인':'출금 신청 반려',
  message:`${row.memberName} (${row.memberHandle})\n${memberMoney(row.amount)}\n${row.bank} · ${row.account} · ${row.holder}\n\n`+(approve?'이 화면에서는 은행 송금이 실행되지 않습니다. 계좌로 실제 송금을 마친 뒤에만 완료 처리해 주세요.':'신청 금액을 회원의 사용 가능 잔액으로 돌려줍니다.'),
  fields:approve?[{name:'payoutReference',label:'완료된 송금의 거래번호 / 확인 메모',value:''}]:[{name:'reason',label:'반려 사유',type:'textarea',value:''}],
  confirmLabel:approve?'송금 완료 기록':'반려 및 잔액 복원',danger:!approve});
 if(!values)return;
 await api('/api/member/action',{method:'POST',body:approve?{action,id:row.id,payoutReference:values.payoutReference,paidConfirmed:true}:{action,id:row.id,reason:values.reason}});
 toast(approve?'송금 완료로 기록했습니다.':'반려하고 잔액을 복원했습니다.');await renderMember();
}
