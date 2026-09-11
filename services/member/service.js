'use strict';
const state=require('../../core/state'),s=require('./store'),commerce=require('./commerce'),social=require('./social');
const {SendLine}=require('../../core/utils');
const protocol=require('./protocol');

const messages={POLL_ALREADY_VOTED:'이미 참여한 투표는 다시 선택하거나 변경할 수 없습니다.',REPOST_COMPOSE_REQUIRED:'피드 작성에서 원글과 함께 이야기를 남겨주세요.',COMMENT_NOT_FOUND:'삭제되었거나 볼 수 없는 댓글입니다.',POLL_INVALID:'투표 질문과 선택지 2~4개를 입력해주세요.',POLL_LOCKED:'참여자가 있는 투표는 선택지를 변경할 수 없습니다.',GIF_INVALID:'2MB 이하, 가로·세로 1024 이하의 GIF를 선택해주세요. 최대 180프레임까지 지원합니다.',ADMIN_ONLY:'관리자 전용 정보입니다.',MEMBER_DEVICE_SELECT:'연결된 기기를 선택해주세요.',HANDLE_INVALID:'아이디는 영문 소문자·숫자·밑줄·점으로 3~24자 입력해주세요.',HANDLE_TAKEN:'이미 사용 중인 아이디입니다.',HANDLE_LOCKED:'아이디는 최초 한 번만 변경할 수 있습니다.',NICKNAME_COOLDOWN:'닉네임은 마지막 변경일로부터 30일 후 바꿀 수 있습니다.',CONTENT_IMAGE_INVALID:'사진 형식이나 크기를 확인해주세요. 다른 사진을 선택해주세요.',CONTENT_URL_INVALID:'채널 주소는 올바른 http 또는 https 주소로 입력해주세요.',...require('./messages'),INPUT_INVALID:'입력 내용을 확인해주세요.',AMOUNT_INVALID:'금액을 확인해주세요.',ACCOUNT_REQUIRED:'회원 정보를 확인할 수 없습니다.',MEMBER_NOT_FOUND:'회원을 찾을 수 없습니다.',ACCOUNT_BLOCKED:'이용이 제한된 계정입니다. 고객센터에 문의해주세요.',MEMBER_AUTH_REQUIRED:'기기 승인과 생체인증을 먼저 완료해주세요.',SERVICE_DISABLED:'서비스가 종료되었습니다.',STORAGE_SAVE_FAILED:'저장하지 못했습니다. 같은 요청으로 다시 시도해주세요.',PRODUCT_NOT_FOUND:'게임을 찾을 수 없습니다.',PRODUCT_UNAVAILABLE:'공개된 게임을 찾을 수 없습니다.',PRICE_CHANGED:'가격 또는 게임 정보가 변경되었습니다. 다시 확인해주세요.',SOLD_OUT:'품절된 상품입니다.',INSUFFICIENT_BALANCE:'잔액이 부족합니다. QR 충전 후 다시 구매해주세요.',BALANCE_INVALID:'잔액 한도를 확인해주세요.',TOPUP_UNAVAILABLE:'충전 방식은 준비 중입니다.',ORDER_NOT_FOUND:'구매 내역을 찾을 수 없습니다.',ORDER_REFUNDED:'환불된 구매 내역입니다.',PASS_EXPIRED:'이용권 기간이 만료되었습니다.',ACTIVATED_REFUND_REVIEW:'이미 사용한 이용권은 개별 환불 검토가 필요합니다.',AVATAR_INVALID:'프로필 사진을 다시 선택해주세요.',POST_NOT_FOUND:'삭제되었거나 숨겨진 글입니다.',NOT_OWNER:'본인이 작성한 내용만 변경할 수 있습니다.',PLEASE_WAIT:'잠시 후 다시 작성해주세요.',REQUEST_REUSED:'요청 번호가 중복되었습니다. 다시 시도해주세요.',REQUEST_ID_INVALID:'요청 정보를 확인해주세요.',UNKNOWN_ACTION:'지원하지 않는 작업입니다.'};
function BaseAllowed(c){return !!c&&state.serviceEnabled&&require('../haCoordinator').CanAcceptTraffic()&&require('../clientPermissions').Ready(c)&&require('../clientInstallation').Ready(c)&&c.licenseAuthorized===true&&require('../deviceAuth').Verified('CLIENT',c.clientId);}
function Allowed(c){if(!BaseAllowed(c)){require('./testAccess').Revoke(c);return false;}return c.biometricVerified===true||require('./testAccess').Valid(c);}
function Execute(c,requestId,action,body={}){
 if(action==='test.enter'){
  if(!BaseAllowed(c)||!require('./testAccess').Enabled())s.Fail(state.serviceEnabled?'MEMBER_AUTH_REQUIRED':'SERVICE_DISABLED');
  const p=s.Account(c);if(p.blocked)s.Fail('ACCOUNT_BLOCKED');
  if(!require('./testAccess').Grant(c))s.Fail('MEMBER_AUTH_REQUIRED');
  return {testAccess:true,memberProtocol:29};
 }
 if(!Allowed(c))s.Fail(state.serviceEnabled?'MEMBER_AUTH_REQUIRED':'SERVICE_DISABLED');
 const p=s.Account(c);if(p.blocked)s.Fail('ACCOUNT_BLOCKED');
 if(action==='records')s.Fail('ADMIN_ONLY');
 if(action.startsWith('topup.')||action.startsWith('coin.'))s.Fail('TOPUP_UNAVAILABLE');
 const read={live:()=>require('./live').Read(p,body),gif:()=>{const post=require('./socialActions').Post(p,body.id);return {photo:{id:post.id,gif:require('./gifMedia').Public(post,true)}};},photo:()=>{const post=require('./socialActions').Post(p,body.id);return {photo:{id:post.id,image:post.image||''}};},gifs:()=>require('./gifs').List(),bookmarks:()=>require('./socialActions').Bookmarks(p,body),blocks:()=>require('./socialActions').Blocks(p,body),member:()=>require('./profiles').Read(p,body),follows:()=>require('./follows').List(p,body),charge:()=>require('./charges').Read(p),product:()=>commerce.Product(body,p),article:()=>social.Article(p,body),home:()=>require('./identity').Home(p),news:()=>social.News(p,body),catalog:()=>({...commerce.Catalog(body,p),profile:s.PublicProfile(p,true)}),me:()=>commerce.Mine(p,body),feed:()=>social.Feed(p,body),thread:()=>social.Thread(p,body)};
 if(read[action]){
  // Execute visibility checks and daily impressions before accepting a cached revision.
  const data=read[action]();
  if(action==='live')return {...data,memberProtocol:29};
  if(['feed','thread','bookmarks'].includes(action)&&body._since===s.DB().revision)return {unchanged:true,revision:s.DB().revision,memberProtocol:29};
  return {...data,viewer:s.PublicProfile(p),memberProtocol:29,revision:s.DB().revision};
 }
 const mutations={
  'block.set':()=>require('./socialActions').Block(p,body),
  'bookmark.set':()=>require('./socialActions').Bookmark(p,body),
  'repost.set':()=>require('./socialActions').Repost(p,body),
  'poll.vote':()=>require('./socialActions').Vote(p,body),
  'comment.react':()=>require('./socialActions').CommentReact(p,body),
  'comment.edit':()=>require('./socialActions').CommentEdit(p,body),
  purchase:()=>commerce.Purchase(p,body),
  'follow.set':()=>require('./follows').Set(p,body),
  'profile.save':()=>social.SaveProfile(p,body),
  'charge.new':()=>{require('./charges').Issue(p,false);return require('./charges').Read(p);},'order.activate':()=>commerce.Activate(p,c,body),
  'post.edit':()=>social.EditPost(p,body),'post.create':()=>social.Post(p,body),'post.delete':()=>social.Remove(p,body,'posts'),
  'comment.create':()=>social.Comment(p,body),'comment.delete':()=>social.Remove(p,body,'comments'),
  react:()=>social.React(p,body),report:()=>social.Report(p,body)
 };
 if(!mutations[action])s.Fail('UNKNOWN_ACTION');
 return s.Operation(p,requestId,action,body,()=>{const result=mutations[action]();return body._delta?require('./wire').Compact(result,action):result;},action==='order.activate'?['licenses','licenseRevision']:[]);
}
function Reply(c,id,action,data,compressed=false){
 let wire;try{wire=require('./wire').Encode(data,compressed);}catch(_){wire=require('./wire').Encode({ok:false,reason:'RESPONSE_LIMIT',message:'조회 범위를 줄여주세요.'},false);}
 const {encoded,prefix,signature}=wire,size=12000,total=Math.ceil(encoded.length/size);
 if(total>512){Reply(c,id,action,{ok:false,reason:'RESPONSE_LIMIT',message:'조회 범위를 줄여주세요.'});return;}
 c.socket.cork?.();
 try{for(let index=0;index<total;index++){
  const fields=[id,action,index,total,encoded.slice(index*size,(index+1)*size)],mac=protocol.Sign(c,signature,fields);
  if(!mac)return;SendLine(c.socket,prefix+'|'+fields.join('|')+'|'+mac);
 }}finally{c.socket.uncork?.();}
}
function Handle(c,line){
 let id,action,encoded,compressed=false;
 if(line.startsWith('HUB_UPLOAD|')||line.startsWith('HUB_ZUPLOAD|')){
  if(!Allowed(c)){c.hubUpload=null;return true;}
  const assembled=require('./uploads').Accept(c,line.split('|'));if(!assembled)return true;
  ({id,action,encoded,compressed}=assembled);
 }else{
  if(!line.startsWith('HUB|'))return false;
  const parts=line.split('|');id=parts[1]||'';action=parts[2]||'';encoded=parts[3]||'';
  if(parts.length!==5||!/^[A-Za-z0-9_-]{8,80}$/.test(id)||!/^[a-z.]{2,32}$/.test(action)||encoded.length>40000||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))return true;
  if(!protocol.Verify(c,[id,action,encoded],parts[4]))return true;
 }
 try{
  const body=JSON.parse(require('./wire').Decode(encoded,compressed));if(!body||Array.isArray(body)||typeof body!=='object')s.Fail('INPUT_INVALID');
  const now=Date.now();if(!c.hubRate||now-c.hubRate.at>10000)c.hubRate={at:now,count:0};if(++c.hubRate.count>45)s.Fail('PLEASE_WAIT');
  const data=Execute(c,id,action,body);Reply(c,id,action,{ok:true,data},body._wire==='zlib');
  if(action==='order.activate')commerce.AfterActivation(c);
  if(action.includes('.')||['purchase','react','report'].includes(action))NotifyChanged(c);
 }catch(e){const reason=e.memberError?e.message:'INPUT_INVALID';Reply(c,id,action,{ok:false,reason,message:messages[reason]||'요청을 처리하지 못했습니다.'});}
 return true;
}
function AdminRead(body={}){return require('./admin').Read(body);}
function NotifyChanged(except=null){
 for(const c of state.clients.values())if(c!==except&&Allowed(c)){
  const revision=String(s.DB().revision),mac=protocol.Sign(c,'HUB_EVENT',[revision]);
  if(mac)SendLine(c.socket,'HUB_EVENT|'+revision+'|'+mac);
 }
}
function AdminWrite(action,body,actor){const result=require('./admin').Write(action,body,actor);if(action!=='charge.scan')NotifyChanged();return result;}
module.exports={Execute,Handle,AdminRead,AdminWrite,Allowed,messages};
