'use strict';
const state=require('../../core/state'),s=require('./store'),commerce=require('./commerce'),social=require('./social');
const {SendLine}=require('../../core/utils');
const protocol=require('./protocol');
const messages={INPUT_INVALID:'입력 내용을 확인해주세요.',AMOUNT_INVALID:'금액을 확인해주세요.',ACCOUNT_REQUIRED:'회원 정보를 확인할 수 없습니다.',ACCOUNT_BLOCKED:'이용이 제한된 계정입니다. 고객센터에 문의해주세요.',MEMBER_AUTH_REQUIRED:'기기 승인과 생체인증을 먼저 완료해주세요.',SERVICE_DISABLED:'서비스가 종료되었습니다.',STORAGE_SAVE_FAILED:'저장하지 못했습니다. 같은 요청으로 다시 시도해주세요.',PRODUCT_NOT_FOUND:'상품을 찾을 수 없습니다.',PRODUCT_UNAVAILABLE:'판매 중인 상품이 아닙니다.',PRICE_CHANGED:'상품 가격이 변경되었습니다. 다시 확인해주세요.',SOLD_OUT:'품절된 상품입니다.',INSUFFICIENT_BALANCE:'잔액이 부족합니다. 먼저 충전해주세요.',BALANCE_INVALID:'잔액 한도를 확인해주세요.',TOPUP_UNAVAILABLE:'현재 충전 신청을 받고 있지 않습니다.',TOPUP_PENDING_LIMIT:'진행 중인 충전 요청을 먼저 확인해주세요.',TOPUP_ALREADY_PROCESSED:'이미 처리된 충전 요청입니다.',TOPUP_NOT_FOUND:'충전 요청을 찾을 수 없습니다.',ORDER_NOT_FOUND:'구매 내역을 찾을 수 없습니다.',ORDER_REFUNDED:'환불된 구매 내역입니다.',PASS_EXPIRED:'이용권 기간이 만료되었습니다.',ACTIVATED_REFUND_REVIEW:'이미 사용한 이용권은 개별 환불 검토가 필요합니다.',AVATAR_INVALID:'프로필 사진을 작은 PNG 이미지로 다시 선택해주세요.',POST_NOT_FOUND:'삭제되었거나 숨겨진 글입니다.',NOT_OWNER:'본인이 작성한 내용만 삭제할 수 있습니다.',PLEASE_WAIT:'잠시 후 다시 작성해주세요.',REQUEST_REUSED:'요청 번호가 중복되었습니다. 다시 시도해주세요.',REQUEST_ID_INVALID:'요청 정보를 확인해주세요.',UNKNOWN_ACTION:'지원하지 않는 작업입니다.'};
function Allowed(c){return !!c&&state.serviceEnabled&&require('../haCoordinator').CanAcceptTraffic()&&require('../clientPermissions').Ready(c)&&require('../clientInstallation').Ready(c)&&c.licenseAuthorized===true&&c.biometricVerified===true&&require('../deviceAuth').Verified('CLIENT',c.clientId);}
function Execute(c,requestId,action,body={}){
 if(!Allowed(c))s.Fail(state.serviceEnabled?'MEMBER_AUTH_REQUIRED':'SERVICE_DISABLED');
 const p=s.Account(c);if(p.blocked)s.Fail('ACCOUNT_BLOCKED');
 const read={home:()=>({profile:s.PublicProfile(p,true),news:social.News(p,body),settings:s.DB().settings}),news:()=>social.News(p,body),catalog:()=>commerce.Catalog(body),me:()=>commerce.Mine(p,body),feed:()=>social.Feed(p,body),thread:()=>social.Thread(p,body)};
 if(read[action])return read[action]();
 const mutations={
  'profile.save':()=>social.SaveProfile(p,body),'topup.create':()=>commerce.RequestTopup(p,body),'topup.cancel':()=>commerce.CancelTopup(p,body),
  purchase:()=>commerce.Purchase(p,body),'order.activate':()=>commerce.Activate(p,c,body),
  'post.create':()=>social.Post(p,body),'post.delete':()=>social.Remove(p,body,'posts'),
  'comment.create':()=>social.Comment(p,body),'comment.delete':()=>social.Remove(p,body,'comments'),
  react:()=>social.React(p,body),report:()=>social.Report(p,body),'news.read':()=>{p.readNewsAt=Date.now();return {read:true};}
 };
 if(!mutations[action])s.Fail('UNKNOWN_ACTION');
 return s.Operation(p,requestId,action,body,mutations[action],action==='order.activate'?['licenses','licenseRevision']:[]);
}
function Reply(c,id,action,data){
 let encoded=Buffer.from(JSON.stringify(data),'utf8').toString('base64');
 if(encoded.length>900000)encoded=Buffer.from(JSON.stringify({ok:false,reason:'RESPONSE_LIMIT',message:'조회 범위를 줄여주세요.'})).toString('base64');
 const size=12000,total=Math.ceil(encoded.length/size);
 for(let index=0;index<total;index++){
  const fields=[id,action,index,total,encoded.slice(index*size,(index+1)*size)],mac=protocol.Sign(c,'HUB_RESPONSE',fields);
  if(!mac)return;
  SendLine(c.socket,'HUB_CHUNK|'+fields.join('|')+'|'+mac);
 }
}
function Handle(c,line){
 if(!line.startsWith('HUB|'))return false;
 const parts=line.split('|'),id=parts[1]||'',action=parts[2]||'';
 if(parts.length!==5||!/^[A-Za-z0-9_-]{8,80}$/.test(id)||!/^[a-z.]{2,32}$/.test(action)||parts[3].length>40000||!/^[A-Za-z0-9+/]*={0,2}$/.test(parts[3]))return true;
 // Bind every request to this verified device and connection challenge. Old
 // sessions, altered payloads and unsigned requests never reach the wallet.
 if(!protocol.Verify(c,[id,action,parts[3]],parts[4]))return true;
 try{
  const body=JSON.parse(Buffer.from(parts[3],'base64').toString('utf8'));if(!body||Array.isArray(body)||typeof body!=='object')s.Fail('INPUT_INVALID');
  const now=Date.now();if(!c.hubRate||now-c.hubRate.at>10000)c.hubRate={at:now,count:0};if(++c.hubRate.count>45)s.Fail('PLEASE_WAIT');
  const data=Execute(c,id,action,body);Reply(c,id,action,{ok:true,data});
  if(action==='order.activate')commerce.AfterActivation(c);
 }catch(e){const reason=e.memberError?e.message:'INPUT_INVALID';Reply(c,id,action,{ok:false,reason,message:messages[reason]||'요청을 처리하지 못했습니다.'});}
 return true;
}
function AdminRead(body={}){
 const db=s.DB(),view=body.view||'overview';
 const rows={products:()=>Object.values(db.products),news:()=>Object.values(db.news),orders:()=>Object.values(db.orders).map(commerce.PublicOrder),topups:()=>Object.values(db.topups),ledger:()=>Object.values(db.ledger),profiles:()=>Object.values(db.profiles).map(p=>({...s.PublicProfile(p,true),blocked:p.blocked})),posts:()=>Object.values(db.posts).map(post=>({...post,author:social.Author(post.accountId)})),comments:()=>Object.values(db.comments).map(c=>({...c,author:social.Author(c.accountId)})),reports:()=>Object.values(db.reports)};
 if(rows[view])return {...s.Page(rows[view]().filter(x=>!body.id||x.id===body.id).sort((a,b)=>(b.at||b.createdAt||b.updatedAt)-(a.at||a.createdAt||a.updatedAt)),body,50),settings:db.settings};
 return {settings:db.settings,products:Object.values(db.products).length,members:Object.values(db.profiles).length,pendingTopups:Object.values(db.topups).filter(x=>x.status==='PENDING').length,orders:Object.values(db.orders).length,openReports:Object.values(db.reports).filter(x=>x.status==='OPEN').length};
}
function AdminWrite(action,body,actor){
 if(action==='product.save')return commerce.SaveProduct(body);
 if(action==='news.save')return social.SaveNews(body);
 if(action==='topup.decide')return commerce.DecideTopup(body,actor);
 if(action==='order.refund')return commerce.Refund(body,actor);
 return s.Atomic(()=>{
  const db=s.DB();
  if(action==='settings.save'){db.settings={topupEnabled:body.topupEnabled===true,topupInstructions:s.Text(body.topupInstructions,1000,true)};return db.settings;}
  if(action==='profile.block'){const p=s.ProfileById(body.id);if(!p)s.Fail('ACCOUNT_REQUIRED');p.blocked=body.blocked===true;return {id:p.id,blocked:p.blocked};}
  if(action==='post.moderate'||action==='comment.moderate'){const row=db[action.startsWith('post.')?'posts':'comments'][body.id];if(!row)s.Fail('POST_NOT_FOUND');row.hidden=body.hidden===true;row.moderatedBy=actor;return {id:row.id,hidden:row.hidden};}
  if(action==='report.resolve'){const row=Object.values(db.reports).find(x=>x.id===body.id);if(!row)s.Fail('POST_NOT_FOUND');row.status='RESOLVED';row.resolvedBy=actor;return row;}
  s.Fail('UNKNOWN_ACTION');
 });
}
module.exports={Execute,Handle,AdminRead,AdminWrite,Allowed,messages};
