'use strict';
const entry=require('./qrApproval'),charges=require('./member/charges'),store=require('./member/store');
function ChargeRecord(row){const request=charges.Public(row),p=store.ProfileById(row.accountId);return {...request,purpose:'WALLET',requestId:row.id,clientId:row.accountId,memberName:p?.nickname||'회원',issuedAt:row.at};}
function List(){return [...entry.List().map(x=>({...x,purpose:'ENTRY'})),...Object.values(store.DB().chargeRequests).map(ChargeRecord)].sort((a,b)=>b.issuedAt-a.issuedAt);}
function Summary(){const all=List();return {...entry.Summary(),pending:all.filter(x=>x.status==='PENDING').length,approved:all.filter(x=>x.status==='APPROVED').length,rejected:all.filter(x=>x.status==='REJECTED').length};}
function Scan(imageData){
 const payload=require('./qrImageDecoder').DecodeQrImage(imageData);
 if(/^(QRC1|RCH1)\./.test(payload)){
  const result=charges.Inspect(payload);return {...result,purpose:'WALLET',request:ChargeRecord(result.request)};
 }
 const result=entry.InspectPayload(payload);return {...result,purpose:'ENTRY',request:{...result.request,purpose:'ENTRY'}};
}
function Approve(body,actor){
 if(body.purpose==='WALLET'){
  if(!/^CHG-[A-F0-9]{24}$/.test(body.requestId||''))store.Fail('QR_PURPOSE_MISMATCH');
  const result=require('./member/service').AdminWrite('charge.approve',{...body,id:body.requestId},actor);
  return {ok:true,purpose:'WALLET',request:ChargeRecord(result)};
 }
 if((body.purpose&&body.purpose!=='ENTRY')||!/^QRA-[A-F0-9]{24}$/.test(body.requestId||''))store.Fail('QR_PURPOSE_MISMATCH');
 return {...entry.Approve(body.requestId,body.approvalToken,{memo:body.memo,tags:body.tags},actor),purpose:'ENTRY'};
}
function Reject(body,actor){
 if(body.purpose==='WALLET'){
  if(!/^CHG-[A-F0-9]{24}$/.test(body.requestId||''))store.Fail('QR_PURPOSE_MISMATCH');
  return {ok:true,purpose:'WALLET',request:ChargeRecord(require('./member/service').AdminWrite('charge.reject',{id:body.requestId,reason:body.reason},actor))};
 }
 if((body.purpose&&body.purpose!=='ENTRY')||!/^QRA-[A-F0-9]{24}$/.test(body.requestId||''))store.Fail('QR_PURPOSE_MISMATCH');
 return entry.Reject(body.requestId,body.reason,actor);
}
module.exports={List,Summary,Scan,Approve,Reject};
