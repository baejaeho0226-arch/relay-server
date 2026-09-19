'use strict';
const state=require('../../core/state'),s=require('./store'),commerce=require('./commerce'),social=require('./social');
const {SendLine}=require('../../core/utils');
const protocol=require('./protocol'),badges=require('./badges');

const messages={DM_NOT_FOUND:'대화를 찾을 수 없습니다.',DM_UNAVAILABLE:'대화할 수 없는 회원입니다.',DM_SELF:'본인과는 대화할 수 없습니다.',DM_DELETED:'삭제된 대화입니다. 회원 프로필에서 새 대화를 시작해주세요.',DM_TEXT_INVALID:'메시지를 1~2,000자로 입력해주세요.',DM_DELETE_CONFIRM:'양쪽 대화를 삭제할지 확인해주세요.',DM_FULL:'새 대화를 시작해주세요.',EVENT_SESSION_NOT_FOUND:'진행 중인 이벤트를 찾을 수 없습니다.',EVENT_SESSION_EXPIRED:'이벤트가 만료됐어요. 다시 시작해주세요.',EVENT_TRACE_INVALID:'플레이 기록을 확인할 수 없습니다.',EVENT_TOO_FAST:'플레이 기록을 확인 중입니다. 잠시 후 다시 시도해주세요.',WITHDRAW_DETAILS_INVALID:'계좌 정보를 확인해주세요.',WITHDRAW_PENDING:'처리 중인 출금 신청이 있어요.',WITHDRAW_BALANCE_REQUIRED:'출금 가능한 잔액이 부족합니다.',WITHDRAW_NOT_FOUND:'출금 신청을 찾을 수 없습니다.',WITHDRAW_PAYMENT_CONFIRM:'실제 송금 완료 여부를 확인해주세요.',WITHDRAW_PROCESSED:'이미 처리된 출금 신청입니다.',TITLE_COLOR_INVALID:'칭호 글자색과 아이콘색을 확인해주세요.',TITLE_NAME_INVALID:'칭호 이름을 1~20자로 입력해주세요.',ALL_TITLES_REQUIRED:'모든 칭호를 먼저 획득해주세요.',TITLE_COLOR_TICKET_REQUIRED:'칭호 색상 이용권이 필요합니다.',TITLE_NAME_TICKET_REQUIRED:'칭호 이름 변경권이 필요합니다.',CASINO_ACTIVE:'진행 중인 라운드를 먼저 마쳐주세요.',CASINO_ROUND_NOT_FOUND:'진행 중인 게임을 다시 확인해주세요.',CASINO_TILE_OPENED:'이미 확인한 칸입니다.',CASINO_CASHOUT_REQUIRED:'게임을 한 번 진행한 뒤 정산해주세요.',SHOP_UNAVAILABLE:'상점 상품을 준비 중입니다.',INVENTORY_LIMIT:'보유 가능한 수량을 확인해주세요.',COLOR_TICKET_REQUIRED:'닉네임 색상 이용권이 필요합니다.',NICKNAME_COLOR_INVALID:'올바른 색상을 선택해주세요.',BADGE_UNAVAILABLE:'아직 획득하지 않은 배지입니다.',POINT_CONVERSION_NOT_FOUND:'교환 내역을 찾을 수 없습니다.',POINT_CONVERSION_INVALID:'교환 내역과 거래 기록을 확인해주세요.',POINT_RECOVERY_BALANCE:'사용 가능한 충전 잔액이 부족해 교환을 회수할 수 없습니다.',ARCADE_RULES_CHANGED:'게임 정보를 다시 확인해주세요.',ARCADE_BALANCE_LIMIT:'잔액 한도로 인해 칩 금액을 줄여주세요.',ARCADE_BALANCE_REQUIRED:'충전 잔액이 부족합니다.',ARCADE_WAIT:'잠시 후 다시 시작해주세요.',EVENT_CLOSED:'지금은 이벤트를 준비 중입니다.',EVENT_NO_TURNS:'충전 후 지급되는 참여 횟수를 확인해주세요.',EVENT_ALREADY_PLAYED:'오늘은 이미 참여했어요. 내일 다시 도전해주세요.',POINT_BALANCE_INVALID:'포인트 잔액을 확인해주세요.',POLL_TEXT_LONG:'선택지를 조금 더 짧게 입력해주세요.',POLL_ALREADY_VOTED:'이미 참여한 투표는 다시 선택하거나 변경할 수 없습니다.',REPOST_COMPOSE_REQUIRED:'피드 작성에서 원글과 함께 이야기를 남겨주세요.',COMMENT_NOT_FOUND:'삭제되었거나 볼 수 없는 댓글입니다.',POLL_INVALID:'투표 질문과 선택지 2~4개를 입력해주세요.',POLL_LOCKED:'참여자가 있는 투표는 선택지를 변경할 수 없습니다.',GIF_INVALID:'2MB 이하, 가로·세로 1024 이하의 GIF를 선택해주세요. 최대 180프레임까지 지원합니다.',ADMIN_ONLY:'관리자 전용 정보입니다.',MEMBER_DEVICE_SELECT:'연결된 기기를 선택해주세요.',HANDLE_INVALID:'아이디는 영문 소문자·숫자·밑줄·점으로 3~24자 입력해주세요.',HANDLE_TAKEN:'이미 사용 중인 아이디입니다.',HANDLE_LOCKED:'아이디는 최초 한 번만 변경할 수 있습니다.',NICKNAME_COOLDOWN:'닉네임은 마지막 변경일로부터 30일 후 바꿀 수 있습니다.',CONTENT_IMAGE_INVALID:'사진 형식이나 크기를 확인해주세요. 다른 사진을 선택해주세요.',CONTENT_URL_INVALID:'채널 주소는 올바른 http 또는 https 주소로 입력해주세요.',...require('./messages'),INPUT_INVALID:'입력 내용을 확인해주세요.',AMOUNT_INVALID:'금액을 확인해주세요.',ACCOUNT_REQUIRED:'회원 정보를 확인할 수 없습니다.',MEMBER_NOT_FOUND:'회원을 찾을 수 없습니다.',ACCOUNT_BLOCKED:'이용이 제한된 계정입니다. 고객센터에 문의해주세요.',MEMBER_AUTH_REQUIRED:'기기 승인과 생체인증을 먼저 완료해주세요.',SERVICE_DISABLED:'서비스가 종료되었습니다.',STORAGE_SAVE_FAILED:'저장하지 못했습니다. 같은 요청으로 다시 시도해주세요.',PRODUCT_NOT_FOUND:'게임을 찾을 수 없습니다.',PRODUCT_UNAVAILABLE:'공개된 게임을 찾을 수 없습니다.',PRICE_CHANGED:'가격 또는 게임 정보가 변경되었습니다. 다시 확인해주세요.',SOLD_OUT:'품절된 상품입니다.',INSUFFICIENT_BALANCE:'잔액이 부족합니다. QR 충전 후 다시 구매해주세요.',BALANCE_INVALID:'잔액 한도를 확인해주세요.',TOPUP_UNAVAILABLE:'충전 방식은 준비 중입니다.',ORDER_NOT_FOUND:'구매 내역을 찾을 수 없습니다.',ORDER_REFUNDED:'환불된 구매 내역입니다.',PASS_EXPIRED:'이용권 기간이 만료되었습니다.',ACTIVATED_REFUND_REVIEW:'이미 사용한 이용권은 개별 환불 검토가 필요합니다.',AVATAR_INVALID:'프로필 사진을 다시 선택해주세요.',POST_NOT_FOUND:'삭제되었거나 숨겨진 글입니다.',NOT_OWNER:'본인이 작성한 내용만 변경할 수 있습니다.',PLEASE_WAIT:'잠시 후 다시 작성해주세요.',REQUEST_REUSED:'요청 번호가 중복되었습니다. 다시 시도해주세요.',REQUEST_ID_INVALID:'요청 정보를 확인해주세요.',UNKNOWN_ACTION:'지원하지 않는 작업입니다.'};
function BaseAllowed(c){return !!c&&state.serviceEnabled&&require('../haCoordinator').CanAcceptTraffic()&&require('../clientPermissions').Ready(c)&&require('../clientInstallation').Ready(c)&&c.licenseAuthorized===true&&require('../deviceAuth').Verified('CLIENT',c.clientId);}
function Allowed(c){if(!BaseAllowed(c)){require('./testAccess').Revoke(c);return false;}return c.biometricVerified===true||require('./testAccess').Valid(c);}
function CurrentWallet(p,data,body={},includeWallet=false){
 // Copy only response projections. Receipts (reward, spin, eventGame, conversion, order and
 // game result) stay immutable, including when an old operation is replayed.
 const result={...data},rewards=require('./rewards'),own=data.profile?.id===p.id&&Object.hasOwn(data.profile,'balance');
 // An old profile-save receipt must retain its name, avatar and revision. Only
 // the explicit private wallet fields are live projections on that receipt.
 if(own)result.profile={...data.profile,balance:p.balance,points:p.points||0,eventSpins:p.eventSpins||0};
 // A newly earned social title needs only the small authenticated wallet delta,
 // never the profile photo, preferences or other unrelated private fields.
 if(data.ownProfile?.id===p.id){delete result.ownProfile;includeWallet=true;}
 if(data.wallet){result.wallet={...data.wallet,points:p.points||0};if(Object.hasOwn(data.wallet,'spins'))result.wallet.spins=p.eventSpins||0;if(Object.hasOwn(data.wallet,'balance'))result.wallet.balance=p.balance;}
 if(data.wallet?.accountId===p.id||includeWallet&&!own&&!data.wallet)result.wallet=require('./arcade').Wallet(p);
 if(Object.hasOwn(data,'activeGame')||Object.hasOwn(data,'activeGames')){result.activeGame=commerce.ActiveGame(p);result.activeGames=commerce.ActiveGames(p);}
 if(data.attendance)result.attendance={...data.attendance,points:p.points||0};
 if(data.eventGames){result.eventGames=require('./eventGames').Read(p);if(data.rules)result.rules=rewards.Rules();}
 if(data.wallet&&data.attendance&&data.history){result.history=rewards.History(p,body);result.attendance=rewards.Attendance(p);}
 return result;
}
function Execute(c,requestId,action,body={}){
 if(action==='test.enter'){
  const access=require('./testAccess');
  if(!BaseAllowed(c)||!access.Enabled()){access.Revoke(c);s.Fail(state.serviceEnabled?'MEMBER_AUTH_REQUIRED':'SERVICE_DISABLED');}
  if(Object.keys(body).some(k=>!['_wire','_delta'].includes(k)))s.Fail('INPUT_INVALID');
  const p=s.Account(c);if(p.blocked){access.Revoke(c);s.Fail('ACCOUNT_BLOCKED');}
  if(!access.Grant(c,p.id))s.Fail('MEMBER_AUTH_REQUIRED');
  return {testAccess:true,challengeId:c.deviceAuthChallengeId,memberProtocol:35};
 }
 if(!Allowed(c))s.Fail(state.serviceEnabled?'MEMBER_AUTH_REQUIRED':'SERVICE_DISABLED');
 const p=s.Account(c);if(p.blocked){require('./testAccess').Revoke(c);s.Fail('ACCOUNT_BLOCKED');}
 if(action==='records')s.Fail('ADMIN_ONLY');
 if(action.startsWith('topup.')||action.startsWith('coin.'))s.Fail('TOPUP_UNAVAILABLE');
 if(action==='history.record')return require('./history').Record(p,body);
 if(action==='currency.list')return require('./currency').List(body);
 if(action==='currency.quote')return require('./currency').Quote(body);
 if(action==='dm')return require('./direct-messages').List(p,body);
 if(action==='dmthread')return require('./direct-messages').Thread(p,body);
 const read={withdraw:()=>require('./withdrawals').Read(p,body),topgames:()=>require('./topGames').Read(p,body),notifications:()=>require('./notifications').Read(p,body),history:()=>require('./history').Read(p),casino:()=>require('./casino').Read(p,body),shop:()=>require('./customization').Read(p),badges:()=>require('./badges').Read(p,body),arcade:()=>require('./arcade').Read(p,body),popular:()=>social.Popular(p,body),rewards:()=>require('./rewards').Read(p,body),activity:()=>require('./activity').Purchases(p,body),mycomments:()=>require('./activity').Comments(p,body),policies:()=>require('./documents').Read(body),preferences:()=>({preferences:require('./preferences').Read(p),profile:s.PublicProfile(p,true)}),live:()=>require('./live').Read(p,body),gif:()=>{const post=require('./socialActions').Post(p,body.id);return {photo:{id:post.id,gif:require('./gifMedia').Public(post,true)}};},photo:()=>{const post=require('./socialActions').Post(p,body.id);return {photo:{id:post.id,image:post.image||''}};},gifs:()=>require('./gifs').List(),bookmarks:()=>require('./socialActions').Bookmarks(p,body),blocks:()=>require('./socialActions').Blocks(p,body),member:()=>require('./profiles').Read(p,body),follows:()=>require('./follows').List(p,body),charge:()=>require('./charges').Read(p),product:()=>commerce.Product(body,p),article:()=>social.Article(p,body),menu:()=>require('./menu').Read(p),news:()=>social.News(p,body),catalog:()=>({...commerce.Catalog(body,p),profile:s.PublicProfile(p,true)}),me:()=>commerce.Mine(p,body),feed:()=>social.Feed(p,body),thread:()=>social.Thread(p,body)};
 if(read[action]){
  // Validate visibility (and explicit detail opens) before accepting a cached revision.
  const beforePoints=p.points||0;let data=read[action]();badges.AfterRead(p,action,body,data);data=CurrentWallet(p,data,body,(p.points||0)!==beforePoints);
  if(action==='live')return {...data,memberProtocol:35};
  if(!body._ifNoneMatch&&['feed','popular','thread','bookmarks'].includes(action)&&body._since===s.DB().revision)return {unchanged:true,revision:s.DB().revision,memberProtocol:35};
  return require('./readResponse').Pack(data,s.PublicProfile(p),s.DB().revision,body);
 }
 const mutations={
  'casino.play':()=>require('./casino').Play(p,body),
  'casino.start':()=>require('./casino').Start(p,body),
  'casino.action':()=>require('./casino').Action(p,body),
  'notifications.clear':()=>require('./notifications').Clear(p,body),
  'withdraw.request':()=>require('./withdrawals').Request(p,body),
  'title.color':()=>require('./customization').ApplyTitleColor(p,body),
  'title.name':()=>require('./customization').ApplyTitleName(p,body),
  'shop.purchase':()=>require('./customization').Purchase(p,body),
  'nickname.color':()=>require('./customization').ApplyColor(p,body),
  'badge.select':()=>require('./badges').Select(p,body),
  'arcade.play':()=>require('./arcade').Play(p,body),
  'points.exchange':()=>require('./points').Exchange(p,body),
  'attendance.check':()=>require('./rewards').Check(p),
  'event.spin':()=>require('./rewards').Spin(p,body),
  'event.start':()=>require('./eventGames').Start(p,body),
  'event.finish':()=>require('./eventGames').Finish(p,body),
  'dm.open':()=>require('./direct-messages').Open(p,body),
  'dm.send':()=>require('./direct-messages').Send(p,body),
  'dm.read':()=>require('./direct-messages').Read(p,body),
  'dm.delete':()=>require('./direct-messages').Delete(p,body),
  'block.set':()=>require('./socialActions').Block(p,body),
  'bookmark.set':()=>require('./socialActions').Bookmark(p,body),
  'repost.set':()=>require('./socialActions').Repost(p,body),
  'poll.vote':()=>require('./socialActions').Vote(p,body),
  'comment.react':()=>require('./socialActions').CommentReact(p,body),
  'comment.edit':()=>require('./socialActions').CommentEdit(p,body),
  purchase:()=>commerce.Purchase(p,body),
  'follow.set':()=>require('./follows').Set(p,body),
  'profile.save':()=>social.SaveProfile(p,body),'preferences.save':()=>require('./preferences').Save(p,body),
  'charge.new':()=>{require('./charges').Issue(p,false);return require('./charges').Read(p);},'order.activate':()=>commerce.Activate(p,c,body),
  'post.edit':()=>social.EditPost(p,body),'post.create':()=>social.Post(p,body),'post.delete':()=>social.Remove(p,body,'posts'),
  'comment.create':()=>social.Comment(p,body),'comment.delete':()=>social.Remove(p,body,'comments'),
  react:()=>social.React(p,body),report:()=>social.Report(p,body)
 };
 if(!mutations[action])s.Fail('UNKNOWN_ACTION');
 if(action.startsWith('dm.')){const receipt=s.Operation(p,requestId,action,body,mutations[action]);return require('./direct-messages').Project(s.ProfileById(p.id),action,receipt);}
 const result=s.Operation(p,requestId,action,body,()=>{const beforePoints=p.points||0,context=badges.Before(p,action,body);const result=mutations[action]();badges.After(p,action,body,result,context);if(['shop.purchase','nickname.color','title.color','title.name'].includes(action))Object.assign(result,require('./customization').Read(p,false));return CurrentWallet(p,body._delta?require('./wire').Compact(result,action):result,body,(p.points||0)!==beforePoints);},action==='order.activate'?['licenses','licenseRevision']:[]);
 // Replayed settlement keeps its original immutable result, but wallet and
 // statistics reflect current committed state (also after an app restart).
 if(action==='withdraw.request'){const current=s.ProfileById(p.id),row=s.DB().withdrawRequests[result.request?.id];return {...require('./withdrawals').Read(current,body),request:row?.accountId===p.id?require('./withdrawals').Public(row):result.request};}
 if(action==='notifications.clear')return {...require('./notifications').Read(s.ProfileById(p.id),body),cleared:true};
 if(action.startsWith('casino.'))return {...require('./casino').Read(s.ProfileById(p.id),{game:body.game}),result:result.result};
 if(action==='arcade.play')return {...require('./arcade').Read(s.ProfileById(p.id),{game:body.game}),result:result.result};
 return CurrentWallet(s.ProfileById(p.id),result,body);
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
  const beforeRevision=s.DB().revision;const data=Execute(c,id,action,body);Reply(c,id,action,{ok:true,data},body._wire==='zlib');
  if(action==='order.activate')commerce.AfterActivation(c);
  if(s.DB().revision!==beforeRevision&&!['test.enter','history.record'].includes(action))NotifyChanged(c);
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
function AdminWrite(action,body,actor){const result=require('./admin').Write(action,body,actor);if(action==='profile.block'&&result.blocked)require('./testAccess').RevokeMember(result.id);if(action!=='charge.scan')NotifyChanged();return result;}
module.exports={Execute,Handle,AdminRead,AdminWrite,Allowed,messages};
