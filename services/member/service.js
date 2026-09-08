'use strict';
const state=require('../../core/state'),s=require('./store'),commerce=require('./commerce'),social=require('./social');
const {SendLine}=require('../../core/utils');
const protocol=require('./protocol');

const messages={...require('./messages'),INPUT_INVALID:'입력 내용을 확인해주세요.',AMOUNT_INVALID:'금액을 확인해주세요.',ACCOUNT_REQUIRED:'회원 정보를 확인할 수 없습니다.',ACCOUNT_BLOCKED:'이용이 제한된 계정입니다. 고객센터에 문의해주세요.',MEMBER_AUTH_REQUIRED:'기기 승인과 생체인증을 먼저 완료해주세요.',SERVICE_DISABLED:'서비스가 종료되었습니다.',STORAGE_SAVE_FAILED:'저장하지 못했습니다. 같은 요청으로 다시 시도해주세요.',PRODUCT_NOT_FOUND:'게임을 찾을 수 없습니다.',PRODUCT_UNAVAILABLE:'공개된 게임 안내를 찾을 수 없습니다.',PRICE_CHANGED:'상품 가격이 변경되었습니다. 다시 확인해주세요.',SOLD_OUT:'품절된 상품입니다.',INSUFFICIENT_BALANCE:'잔액이 부족합니다. 고객센터로 문의해주세요.',BALANCE_INVALID:'잔액 한도를 확인해주세요.',TOPUP_UNAVAILABLE:'충전 방식은 준비 중입니다.',ORDER_NOT_FOUND:'구매 내역을 찾을 수 없습니다.',ORDER_REFUNDED:'환불된 구매 내역입니다.',PASS_EXPIRED:'이용권 기간이 만료되었습니다.',ACTIVATED_REFUND_REVIEW:'이미 사용한 이용권은 개별 환불 검토가 필요합니다.',AVATAR_INVALID:'프로필 사진을 작은 PNG 이미지로 다시 선택해주세요.',POST_NOT_FOUND:'삭제되었거나 숨겨진 글입니다.',NOT_OWNER:'본인이 작성한 내용만 변경할 수 있습니다.',PLEASE_WAIT:'잠시 후 다시 작성해주세요.',REQUEST_REUSED:'요청 번호가 중복되었습니다. 다시 시도해주세요.',REQUEST_ID_INVALID:'요청 정보를 확인해주세요.',UNKNOWN_ACTION:'지원하지 않는 작업입니다.'};
function Allowed(c){return !!c&&state.serviceEnabled&&require('../haCoordinator').CanAcceptTraffic()&&require('../clientPermissions').Ready(c)&&require('../clientInstallation').Ready(c)&&c.licenseAuthorized===true&&c.biometricVerified===true&&require('../deviceAuth').Verified('CLIENT',c.clientId);}
function Execute(c,requestId,action,body={}){
 if(!Allowed(c))s.Fail(state.serviceEnabled?'MEMBER_AUTH_REQUIRED':'SERVICE_DISABLED');
 const p=s.Account(c);if(p.blocked)s.Fail('ACCOUNT_BLOCKED');
 if(action.startsWith('topup.')||action.startsWith('coin.'))s.Fail('TOPUP_UNAVAILABLE');
 if(action==='purchase')s.Fail('SHOP_RETIRED');
 const read={charge:()=>require('./charges').Read(p),product:()=>commerce.Product(body),article:()=>social.Article(p,body),home:()=>({profile:s.PublicProfile(p,true),news:social.News(p,body),settings:{}}),news:()=>social.News(p,body),catalog:()=>commerce.Catalog(body),me:()=>commerce.Mine(p,body),feed:()=>social.Feed(p,body),thread:()=>social.Thread(p,body)};
 if(read[action])return read[action]();
 const mutations={
  'profile.save':()=>social.SaveProfile(p,body),
  'charge.new':()=>{require('./charges').Issue(p,false);return require('./charges').Read(p);},'order.activate':()=>commerce.Activate(p,c,body),
  'post.edit':()=>social.EditPost(p,body),'post.create':()=>social.Post(p,body),'post.delete':()=>social.Remove(p,body,'posts'),
  'comment.create':()=>social.Comment(p,body),'comment.delete':()=>social.Remove(p,body,'comments'),
  react:()=>social.React(p,body),report:()=>social.Report(p,body)
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
  if(action.includes('.')||['react','report'].includes(action))NotifyChanged();
 }catch(e){const reason=e.memberError?e.message:'INPUT_INVALID';Reply(c,id,action,{ok:false,reason,message:messages[reason]||'요청을 처리하지 못했습니다.'});}
 return true;
}
function AdminRead(body={}){return require('./admin').Read(body);}
function NotifyChanged(){
 for(const c of state.clients.values())if(Allowed(c)){
  const revision=String(s.DB().revision),mac=protocol.Sign(c,'HUB_EVENT',[revision]);
  if(mac)SendLine(c.socket,'HUB_EVENT|'+revision+'|'+mac);
 }
}
function AdminWrite(action,body,actor){const result=require('./admin').Write(action,body,actor);if(action!=='charge.scan')NotifyChanged();return result;}
module.exports={Execute,Handle,AdminRead,AdminWrite,Allowed,messages};
