'use strict';
const s=require('./store'),social=require('./socialActions'),preferences=require('./preferences');
// This is a private, read-only projection of committed activity. The admin
// notification center contains device/security information and is never used.
function Rows(p){
 const db=s.DB(),prefs=preferences.Read(p),english=prefs.language==='en',now=Date.now(),items=[];
 const title=(ko,en)=>english?en:ko;
 const short=value=>String(value||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,140);
 const member=id=>{const x=s.ProfileById(id);return x&&!x.blocked&&!social.Blocked(p.id,id)?x:null;};
 const visiblePost=post=>{const author=post&&member(post.accountId);return author&&social.Visible(post,p)&&preferences.CanReadPosts(p,author);};
 const add=(id,at,heading,detail,icon,target)=>{
  if(!Number.isSafeInteger(at)||at<=0||at>now)return;
  items.push({id,at,title:short(heading),body:short(detail),icon,target});
 };
 if(prefs.notifyApproval)for(const row of Object.values(db.ledger)){
  if(row.accountId!==p.id||!['QR_TOPUP','PURCHASE','REFUND'].includes(row.kind))continue;
  const order=db.orders[row.reference];
  const headings={QR_TOPUP:title('충전이 완료되었어요','Wallet top-up approved'),PURCHASE:title('게임 구매가 완료되었어요','Game purchase completed'),REFUND:title('환불이 완료되었어요','Refund completed')};
  const detail=row.kind==='QR_TOPUP'?title('개인 지갑에서 충전 내역을 확인하세요.','Check the top-up in your wallet.'):order?.accountId===p.id?order.title||title('게임 이용권','Game pass'):title('결제 내역을 확인하세요.','Check your payment history.');
  add('payment:'+row.id,row.at,headings[row.kind],detail,'receipt',row.kind==='QR_TOPUP'?'charge':'payments');
 }
 for(const row of Object.values(db.pointLedger)){
  if(row.accountId!==p.id||row.amount<=0||!['BADGE_REWARD','ATTENDANCE','ROULETTE','EVENT_CARD','EVENT_CHEST','EVENT_RPS','EVENT_DINO','EVENT_FLAPPY','EVENT_WHACK','EVENT_DODGE','EVENT_RHYTHM'].includes(row.kind))continue;
  const eventTitles={EVENT_DINO:title('공룡 게임 포인트가 지급되었어요','Dino game points received'),EVENT_FLAPPY:title('플래피 버드 포인트가 지급되었어요','Flappy game points received'),EVENT_WHACK:title('두더지 게임 포인트가 지급되었어요','Whack-a-mole points received'),EVENT_DODGE:title('똥피하기 포인트가 지급되었어요','Dodge game points received'),EVENT_RHYTHM:title('리듬 게임 포인트가 지급되었어요','Rhythm game points received'),EVENT_CARD:title('행운 카드 보상 포인트가 지급되었어요','Lucky cards reward received'),EVENT_CHEST:title('보물상자 보상 포인트가 지급되었어요','Treasure chest reward received'),EVENT_RPS:title('가위바위보 보상 포인트가 지급되었어요','Rock paper scissors reward received')};
  const badge=row.kind==='BADGE_REWARD',heading=eventTitles[row.kind]||(badge?title('칭호 보상 포인트가 지급되었어요','Title reward points received'):row.kind==='ATTENDANCE'?title('출석 보상 포인트가 지급되었어요','Attendance reward received'):title('돌림판 보상 포인트가 지급되었어요','Wheel reward received'));
  add('points:'+row.id,row.at,heading,'+'+row.amount.toLocaleString(english?'en-US':'ko-KR')+'P',badge?'badge':'gift',badge?'badges':'points');
 }
 if(prefs.notifyFollowers)for(const row of Object.values(db.follows)){
  if(row.following!==p.id||row.follower===p.id)continue;
  const actor=member(row.follower);if(!actor)continue;
  add('follow:'+actor.id,row.at,title('새 팔로워가 있어요','You have a new follower'),title(actor.nickname+'님이 나를 팔로우했어요.',actor.nickname+' followed you.'),'user','member|'+actor.id);
 }
 if(prefs.notifyComments)for(const row of Object.values(db.comments)){
  if(row.accountId===p.id||!require('./commentThreads').Visible(row,p))continue;
  const post=db.posts[row.postId],actor=member(row.accountId);if(!actor||!visiblePost(post))continue;
  const parent=db.comments[row.replyToId||row.parentId];
  const reply=!!parent&&parent.postId===post.id&&parent.accountId===p.id&&require('./commentThreads').Visible(parent,p);
  if(post.accountId!==p.id&&!reply)continue;
  add('comment:'+row.id,row.at,reply?title('내 댓글에 답글이 달렸어요','New reply to your comment'):title('내 게시글에 댓글이 달렸어요','New comment on your post'),actor.nickname+': '+short(row.body),'bubble','comments|'+post.id);
 }
 if(prefs.notifyFollowing||prefs.notifyPosts)for(const post of Object.values(db.posts)){
  if(post.accountId===p.id||!visiblePost(post))continue;
  const followed=!!db.follows[p.id+':'+post.accountId];
  // A general post subscription includes visible public posts; following-only
  // subscriptions are restricted to people the viewer currently follows.
  if(!prefs.notifyPosts&&!(prefs.notifyFollowing&&followed))continue;
  const actor=member(post.accountId);
  add('post:'+post.id,post.at,title(actor.nickname+'님의 새 게시글',actor.nickname+' shared a post'),post.title||post.body||title('사진 · 투표 게시글','Photo or poll post'),'feed','comments|'+post.id);
 }
 if(prefs.notifyRelease)for(const row of Object.values(db.news)){
  if(row.deleted||!row.published||(row.publishAt&&row.publishAt>now)||(row.audience&&row.audience!==p.id))continue;
  add('news:'+row.id,row.publishAt||row.at,row.title,row.category==='EVENT'?title('새 이벤트 소식을 확인하세요.','See the latest event.'):title('새 소식을 확인하세요.','Read the latest news.'),row.category==='EVENT'?'gift':'news','article|'+row.id);
 }
 items.sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
 return items;
}
function Read(p,body={}){
 const dismissed=p.notificationDismissed||{},same=new Set(Array.isArray(dismissed.ids)?dismissed.ids:[]);
 return s.Page(Rows(p).filter(row=>row.at>(dismissed.at||0)||(row.at===(dismissed.at||0)&&!same.has(row.id))),body,20);
}
function Clear(p,body={}){
 if(body.confirmed!==true)s.Fail('INPUT_INVALID');
 const at=Date.now(),rows=Rows(p);
 // A same-millisecond new event remains visible unless it was actually in this
 // clear snapshot. Wallet/point/social source records are never deleted.
 p.notificationDismissed={at,ids:rows.filter(row=>row.at===at).map(row=>row.id)};
 return {cleared:true,clearedAt:at};
}
module.exports={Read,Clear};
