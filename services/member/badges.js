'use strict';
const s=require('./store');
// A completed mission is a durable fact, not a projection of today's post or
// follower count. Each title grants its published point reward exactly once.
const catalog=[
 {id:'POSTS_1',title:'첫 이야기',description:'첫 공개 게시글을 작성했어요.',metric:'posts',target:1},
 {id:'POSTS_10',title:'이야기꾼',description:'공개 게시글을 누적 10개 작성했어요.',metric:'posts',target:10},
 {id:'POSTS_50',title:'인기 작가',description:'공개 게시글을 누적 50개 작성했어요.',metric:'posts',target:50},
 {id:'COMMENTS_1',title:'대화의 시작',description:'첫 댓글을 남겼어요.',metric:'comments',target:1},
 {id:'COMMENTS_10',title:'다정한 한마디',description:'댓글을 누적 10개 남겼어요.',metric:'comments',target:10},
 {id:'COMMENTS_50',title:'대화의 동행',description:'댓글을 누적 50개 남겼어요.',metric:'comments',target:50},
 {id:'REPLY_1',title:'이어지는 대화',description:'댓글에 첫 답글을 남겼어요.',metric:'replies',target:1},
 {id:'LIKES_1',title:'첫 공감',description:'게시글이나 댓글에 좋아요를 눌렀어요.',metric:'likes',target:1},
 {id:'LIKES_10',title:'공감 나누기',description:'서로 다른 게시글·댓글 10개에 좋아요를 눌렀어요.',metric:'likes',target:10},
 {id:'LIKED_1',title:'마음을 전한 이야기',description:'다른 회원에게 첫 좋아요를 받았어요.',metric:'likesReceived',target:1},
 {id:'FOLLOWING_1',title:'관심의 시작',description:'다른 회원을 처음 팔로우했어요.',metric:'following',target:1},
 {id:'FOLLOWING_10',title:'넓어지는 관심',description:'서로 다른 회원 10명을 팔로우했어요.',metric:'following',target:10},
 {id:'FOLLOWERS_1',title:'첫 이웃',description:'첫 팔로워가 생겼어요.',metric:'followers',target:1},
 {id:'FOLLOWERS_100',title:'함께하는 백 명',description:'팔로워 100명을 달성했어요.',metric:'followers',target:100},
 {id:'FOLLOWERS_500',title:'팔로우 부자',description:'팔로워 500명을 달성했어요.',metric:'followers',target:500},
 {id:'PROFILE_VISIT_1',title:'반가운 방문',description:'다른 회원의 프로필을 처음 열어봤어요.',metric:'profileVisits',target:1},
 {id:'PROFILE_VISIT_10',title:'우리 동네 탐방',description:'서로 다른 회원 10명의 프로필을 열어봤어요.',metric:'profileVisits',target:10},
 {id:'PROFILE_EDIT_1',title:'나를 소개해요',description:'내 프로필 정보를 처음 변경했어요.',metric:'profileEdits',target:1},
 {id:'AVATAR_1',title:'나만의 얼굴',description:'프로필 사진을 등록했어요.',metric:'avatar',target:1},
 {id:'BIO_1',title:'짧은 자기소개',description:'프로필에 자기소개를 남겼어요.',metric:'bio',target:1},
 {id:'PHOTO_POST_1',title:'사진 한 장',description:'사진을 담은 게시글을 작성했어요.',metric:'photoPosts',target:1},
 {id:'GIF_POST_1',title:'움직이는 이야기',description:'GIF를 담은 게시글을 작성했어요.',metric:'gifPosts',target:1},
 {id:'POLL_CREATE_1',title:'여러분의 생각은',description:'투표가 있는 게시글을 작성했어요.',metric:'pollsCreated',target:1},
 {id:'POLL_VOTE_1',title:'소중한 한 표',description:'첫 투표에 참여했어요.',metric:'pollVotes',target:1},
 {id:'POLL_VOTE_10',title:'생각을 나누는 사람',description:'서로 다른 투표 10개에 참여했어요.',metric:'pollVotes',target:10},
 {id:'REPOST_1',title:'다시 나누는 이야기',description:'게시글을 처음 리포스트했어요.',metric:'reposts',target:1},
 {id:'BOOKMARK_1',title:'다시 보고 싶은 글',description:'게시글이나 댓글을 처음 저장했어요.',metric:'bookmarks',target:1},
 {id:'BOOKMARK_10',title:'나만의 모음집',description:'서로 다른 게시글·댓글 10개를 저장했어요.',metric:'bookmarks',target:10},
 {id:'NEWS_READ_1',title:'새소식 확인',description:'소식 상세 내용을 처음 열어봤어요.',metric:'newsRead',target:1},
 {id:'NEWS_READ_10',title:'소식 길잡이',description:'서로 다른 소식 10개를 읽었어요.',metric:'newsRead',target:10},
 {id:'GAME_READ_1',title:'어떤 게임일까',description:'게임 상세 안내를 처음 열어봤어요.',metric:'gamesRead',target:1},
 {id:'POST_READ_10',title:'이야기 산책',description:'다른 회원의 서로 다른 게시글 10개를 열어봤어요.',metric:'postsRead',target:10},
 {id:'ATTENDANCE_1',title:'오늘의 발자국',description:'첫 출석 체크를 완료했어요.',metric:'attendance',target:1},
 {id:'ATTENDANCE_7',title:'꾸준한 발걸음',description:'누적 출석 7일을 달성했어요.',metric:'attendance',target:7},
 {id:'ATTENDANCE_30',title:'매일의 동행',description:'누적 출석 30일을 달성했어요.',metric:'attendance',target:30},
 {id:'ATTENDANCE_100',title:'백 번의 안부',description:'누적 출석 100일을 달성했어요.',metric:'attendance',target:100},
 {id:'ATTENDANCE_STREAK_7',title:'일주일의 약속',description:'7일 연속 출석했어요.',metric:'attendanceStreak',target:7},
 {id:'WHEEL_1',title:'행운의 첫 회전',description:'이벤트 돌림판을 처음 이용했어요.',metric:'wheel',target:1},
 {id:'WHEEL_10',title:'돌아가는 행운',description:'이벤트 돌림판을 누적 10회 이용했어요.',metric:'wheel',target:10},
 {id:'BACCARAT_1',title:'바카라 첫 테이블',description:'바카라 한 판을 끝까지 이용했어요.',metric:'baccarat',target:1},
 {id:'ROULETTE_1',title:'룰렛 첫 회전',description:'룰렛 한 판을 끝까지 이용했어요.',metric:'roulette',target:1},
 {id:'SLOTS_1',title:'슬롯 첫 스핀',description:'슬롯 한 판을 끝까지 이용했어요.',metric:'slots',target:1},
 {id:'CRASH_1',title:'크래시 첫 비행',description:'크래시 한 판을 끝까지 이용했어요.',metric:'crash',target:1},
 {id:'DICE_1',title:'다이스 첫 굴림',description:'다이스 한 판을 끝까지 이용했어요.',metric:'dice',target:1},
 {id:'MINES_1',title:'마인즈 첫 탐험',description:'마인즈 한 판을 끝까지 이용했어요.',metric:'mines',target:1},
 {id:'PLINKO_1',title:'플링코 첫 낙하',description:'플링코 한 판을 끝까지 이용했어요.',metric:'plinko',target:1},
 {id:'LIMBO_1',title:'림보 첫 도전',description:'림보 한 판을 끝까지 이용했어요.',metric:'limbo',target:1},
 {id:'HILO_1',title:'하이로 첫 선택',description:'하이로 한 판을 끝까지 이용했어요.',metric:'hilo',target:1},
 {id:'TOWER_1',title:'타워 첫 등반',description:'타워 한 판을 끝까지 이용했어요.',metric:'tower',target:1},
 {id:'BLACKJACK_1',title:'블랙잭 첫 핸드',description:'블랙잭 한 판을 끝까지 이용했어요.',metric:'blackjack',target:1},
 {id:'CASINO_10',title:'테이블 탐방',description:'카지노 게임을 누적 10판 완료했어요.',metric:'casinoPlays',target:10},
 {id:'CASINO_100',title:'백 번의 플레이',description:'카지노 게임을 누적 100판 완료했어요.',metric:'casinoPlays',target:100},
 {id:'GAME_PURCHASE_1',title:'첫 게임 이용권',description:'충전 잔액으로 게임 이용권을 처음 구매했어요.',metric:'purchases',target:1},
 {id:'GAME_PURCHASE_10',title:'계속되는 즐거움',description:'게임 이용권 구매를 누적 10회 완료했어요.',metric:'purchases',target:10},
 {id:'GAME_START_1',title:'이용 시작',description:'구매한 게임 이용권을 처음 사용했어요.',metric:'gameStarts',target:1},
 {id:'QR_CHARGE_1',title:'지갑의 첫 충전',description:'QR 충전 승인이 완료됐어요.',metric:'charges',target:1},
 {id:'POINT_EXCHANGE_1',title:'포인트의 새 쓰임',description:'포인트를 충전 잔액으로 처음 교환했어요.',metric:'exchanges',target:1},
 {id:'SHOP_PURCHASE_1',title:'나만의 꾸미기',description:'포인트 상점에서 첫 상품을 구매했어요.',metric:'shopPurchases',target:1},
 {id:'NICKNAME_COLOR_1',title:'나만의 색깔',description:'닉네임 색상을 처음 적용했어요.',metric:'nicknameColor',target:1},
 // Badge text never reveals report reasons, reporter identities, or a moderation verdict.
 {id:'REPORT_1',title:'의견 전달',description:'운영팀에 게시글·댓글 관련 의견을 전달했어요.',metric:'reports',target:1},
 {id:'REPORT_RECEIVED_1',title:'피드백 도착',description:'내 게시글·댓글에 관한 의견이 접수됐어요. 위반 확정을 뜻하지 않아요.',metric:'reportsReceived',target:1}
].map(row=>({...row,rewardPoints:row.target>=500?500:row.target>=30?300:row.target>1?100:50}));
const REWARD_KIND='BADGE_REWARD',POINT_CAP=100000000;
const VERSION=1,MAX=Object.fromEntries(catalog.map(row=>[row.metric,Math.max(...catalog.filter(x=>x.metric===row.metric).map(x=>x.target))]));
const GAMES=['BACCARAT','ROULETTE','SLOTS','CRASH','DICE','MINES','PLINKO','LIMBO','HILO','TOWER','BLACKJACK'];
const LEGACY_SELECTED=new Set(['FOLLOWERS_500','POSTS_10','POSTS_50','ATTENDANCE_7','ATTENDANCE_30']);
const NumberOf=value=>Number.isSafeInteger(value)&&value>0?value:0;
const Record=p=>p.badgeProgress&&p.badgeProgress.version===VERSION?p.badgeProgress:null;
function Observe(p,metric,value){
 const data=Record(p),maximum=MAX[metric];if(!data||!maximum)return;
 data.counts[metric]=Math.max(NumberOf(data.counts[metric]),Math.min(maximum,NumberOf(value)));
}
function Unique(p,metric,id){
 const data=Record(p),maximum=MAX[metric];if(!data||!maximum||!id||NumberOf(data.counts[metric])>=maximum)return;
 const seen=data.seen[metric]||(data.seen[metric]={}),key='id:'+String(id);
 if(Object.hasOwn(seen,key))return;
 seen[key]=true;Observe(p,metric,NumberOf(data.counts[metric])+1);
 // Memory and persistence are bounded by the highest published milestone.
 if(data.counts[metric]>=maximum)delete data.seen[metric];
}
function Award(p,legacy=false){
 const data=Record(p);if(!data)return;
 for(const row of catalog){
  if(!data.awards[row.id]&&NumberOf(data.counts[row.metric])>=row.target)
   data.awards[row.id]={at:Date.now(),...(legacy?{legacy:true}:{})};
  const award=data.awards[row.id];if(!award)continue;
  // Freeze the amount on first capture, including already-earned FIX52 titles.
  // Keep the progress version and original completion time during this upgrade.
  if(!NumberOf(award.rewardPoints))award.rewardPoints=row.rewardPoints;
  if(award.rewardPaid!==true)award.rewardPaid=false;
 }
}
function RewardLedger(p,id){return s.DB().pointLedger[p.id+':'+REWARD_KIND+':'+id];}
function CanPay(p,award){
 const points=p.points||0;
 return Number.isSafeInteger(points)&&points>=0&&Number.isSafeInteger(points+award.rewardPoints)&&points+award.rewardPoints<=POINT_CAP;
}
function HasPayableReward(p,data){
 return catalog.some(row=>{const award=data?.awards[row.id];return award&&!award.rewardPaid&&(RewardLedger(p,row.id)||CanPay(p,award));});
}
// Call only inside the caller's Atomic transaction. The durable award and its
// account + kind + badge ledger key jointly prevent read/replay/upgrade credits.
function PayRewards(p){
 const data=Record(p);if(!data)return;
 for(const row of catalog){
  const award=data.awards[row.id];if(!award||award.rewardPaid)continue;
  let ledger=RewardLedger(p,row.id);
  // A full wallet must not cancel the activity that earned this title. Leave the
  // entire reward pending; a later action or badge read retries after spending.
  if(!ledger){if(!CanPay(p,award))continue;ledger=require('./rewards').Credit(p,award.rewardPoints,REWARD_KIND,row.id);}
  award.rewardPaid=true;award.rewardLedgerId=ledger.id;award.rewardPaidAt=ledger.at;
 }
}
function PostEvidence(p,row){
 if(!row||row.accountId!==p.id||row.hidden||row.deleted&&!row.deletedByMember)return;
 Unique(p,'posts',row.id);if(row.image)Unique(p,'photoPosts',row.id);if(row.gifId)Unique(p,'gifPosts',row.id);
 if(row.poll)Unique(p,'pollsCreated',row.id);if(row.quotePostId)Unique(p,'reposts',row.id);
}
function CommentEvidence(p,row){
 if(!row||row.accountId!==p.id||row.hidden||row.deleted&&!row.deletedByMember)return;
 Unique(p,'comments',row.id);if(row.parentId)Unique(p,'replies',row.id);
}
function ReportOwner(row){
 if(row.targetAccountId)return s.ProfileById(row.targetAccountId);
 return s.ProfileById((row.kind==='comment'?s.DB().comments[row.commentId||row.targetId]:s.DB().posts[row.targetId||row.postId])?.accountId);
}
function Derived(p){
 Observe(p,'attendance',p.attendance?.count);Observe(p,'attendanceStreak',p.attendance?.streak);
 let played=0;for(const game of GAMES){const n=NumberOf(p.arcade?.[game]?.played)+NumberOf(p.casino?.[game]?.played);Observe(p,game.toLowerCase(),n);played+=Math.min(MAX.casinoPlays,n);}
 Observe(p,'casinoPlays',played);if(p.avatar)Observe(p,'avatar',1);if(p.bio)Observe(p,'bio',1);
 if(p.nicknameColor)Observe(p,'nicknameColor',1);
}
function Seed(p){
 const db=s.DB();p.badgeProgress={version:VERSION,counts:{},seen:{},awards:{},migratedAt:Date.now()};
 for(const row of Object.values(db.posts))PostEvidence(p,row);
 for(const row of Object.values(db.comments))CommentEvidence(p,row);
 for(const row of Object.values(db.follows))if(row.follower===p.id)Unique(p,'following',row.following);
 Observe(p,'followers',require('./follows').Counts(p.id).followers);
 for(const row of Object.values(db.reactions))if(row.value===1){
  if(row.accountId===p.id)Unique(p,'likes','post:'+row.postId);
  if(row.accountId!==p.id&&db.posts[row.postId]?.accountId===p.id)Observe(p,'likesReceived',1);
 }
 for(const row of Object.values(db.commentReactions)){
  if(row.accountId===p.id)Unique(p,'likes','comment:'+row.commentId);
  if(row.accountId!==p.id&&db.comments[row.commentId]?.accountId===p.id)Observe(p,'likesReceived',1);
 }
 for(const row of Object.values(db.bookmarks))if(row.accountId===p.id)Unique(p,'bookmarks',row.kind+':'+row.targetId);
 for(const row of Object.values(db.pollVotes))if(row.accountId===p.id)Unique(p,'pollVotes',row.postId);
 for(const row of Object.values(db.reposts))if(row.accountId===p.id)Unique(p,'reposts',row.postId);
 for(const row of Object.values(db.eventSpins))if(row.accountId===p.id)Unique(p,'wheel',row.id);
 for(const row of Object.values(db.ledger))if(row.accountId===p.id){
  if(row.kind==='PURCHASE'&&row.amount<0)Unique(p,'purchases',row.id);
  if(row.kind==='QR_TOPUP'&&row.amount>0&&db.chargeRequests[row.reference]?.status==='APPROVED')Observe(p,'charges',1);
  if(row.kind==='POINT_EXCHANGE'&&row.amount>0&&Object.values(db.pointLedger).some(x=>x.accountId===p.id&&x.kind==='POINT_EXCHANGE'&&x.reference===row.reference&&x.amount<0))Observe(p,'exchanges',1);
 }
 for(const row of Object.values(db.orders))if(row.accountId===p.id&&row.activatedAt)Observe(p,'gameStarts',1);
 for(const row of Object.values(db.shopPurchases))if(row.accountId===p.id)Unique(p,'shopPurchases',row.id);
 for(const row of Object.values(db.reports)){
  if(row.accountId===p.id)Unique(p,'reports',row.id);
  if(row.accountId!==p.id&&ReportOwner(row)?.id===p.id)Unique(p,'reportsReceived',row.id);
 }
 for(const id of Object.keys(p.readNews||{}))Unique(p,'newsRead',id);
 for(const id of Object.keys(p.readProducts||{}))Unique(p,'gamesRead',id);
 // Existing detail-view receipts are trustworthy even if a post was later removed.
 for(const hit of Object.keys(db.viewHits))if(hit.startsWith(p.id+':post:')){
  const id=hit.slice((p.id+':post:').length);if(db.posts[id]&&db.posts[id].accountId!==p.id)Unique(p,'postsRead',id);
 }
 if(p.nicknameChangedAt||p.handleChangedAt||p.avatarRevision>0||p.bio||p.pronouns||(p.gender&&p.gender!=='UNDISCLOSED'))Observe(p,'profileEdits',1);
 // FIX51 could retain a valid server-selected title after its live counter
 // declined. Its original owner-only selection is historical completion proof.
 if(LEGACY_SELECTED.has(p.titleBadgeId)){const selected=catalog.find(row=>row.id===p.titleBadgeId);Observe(p,selected.metric,selected.target);}
 Derived(p);Award(p,true);
}
// Call only inside an existing transaction. This function never writes a second
// transaction and never calls PublicProfile, so public projections cannot recurse.
function Capture(p){if(!p)return;if(!Record(p))Seed(p);Derived(p);Award(p);}
// Background game completion uses the same transaction for its award and credit.
function Settle(p){Capture(p);PayRewards(p);}
function ProfileFingerprint(p){return JSON.stringify([p.nickname,p.bio,p.pronouns,p.gender,p.handle,p.avatar]);}
function Before(p,action,body={}){
 const profiles=new Map([[p.id,p]]),db=s.DB();let other;
 if(action==='follow.set'||action==='block.set')other=s.Resolve(body.handle||body.id);
 else if(action==='react')other=s.ProfileById(db.posts[body.postId]?.accountId);
 else if(action==='comment.react')other=s.ProfileById(db.comments[body.id]?.accountId);
 else if(action==='report'){const row=body.kind==='comment'?db.comments[body.id||body.postId]:db.posts[body.id||body.postId];other=s.ProfileById(row?.accountId);}
 if(other)profiles.set(other.id,other);
 for(const target of profiles.values()){
  Capture(target);
  if(action==='follow.set'||action==='block.set'){Observe(target,'followers',require('./follows').Counts(target.id).followers);Award(target);}
 }
 return {ids:[...profiles.keys()],profile:ProfileFingerprint(p)};
}
function After(p,action,body={},result={},before={}){
 Capture(p);const db=s.DB();
 if(action==='post.create'||action==='post.edit')PostEvidence(p,db.posts[result.post?.id]);
 else if(action==='comment.create')CommentEvidence(p,db.comments[result.comment?.id]);
 else if(action==='react'&&Number(body.value)===1){
  const row=db.reactions[p.id+':'+body.postId];if(row?.accountId===p.id&&row.value===1){Unique(p,'likes','post:'+row.postId);const author=s.ProfileById(db.posts[row.postId]?.accountId);if(author&&author.id!==p.id){Capture(author);Observe(author,'likesReceived',1);Award(author);}}
 }else if(action==='comment.react'&&body.value===1){
  const row=db.commentReactions[p.id+':'+body.id];if(row?.accountId===p.id){Unique(p,'likes','comment:'+row.commentId);const author=s.ProfileById(db.comments[row.commentId]?.accountId);if(author&&author.id!==p.id){Capture(author);Observe(author,'likesReceived',1);Award(author);}}
 }else if(action==='follow.set'&&body.following===true){const row=db.follows[p.id+':'+result.id];if(row?.follower===p.id)Unique(p,'following',row.following);}
 else if(action==='bookmark.set'&&body.saved===true){const row=db.bookmarks[p.id+':'+body.kind+':'+body.id];if(row?.accountId===p.id)Unique(p,'bookmarks',row.kind+':'+row.targetId);}
 else if(action==='poll.vote'){const row=db.pollVotes[p.id+':'+body.postId];if(row?.accountId===p.id)Unique(p,'pollVotes',row.postId);}
 else if(action==='repost.set'){for(const row of Object.values(db.reposts))if(row.accountId===p.id)Unique(p,'reposts',row.postId);}
 else if(action==='profile.save'&&before.profile!==ProfileFingerprint(p))Observe(p,'profileEdits',1);
 else if(action==='event.spin'){const row=db.eventSpins[result.spin?.id];if(row?.accountId===p.id)Unique(p,'wheel',row.id);}
 else if(action==='purchase'){for(const row of Object.values(db.ledger))if(row.accountId===p.id&&row.kind==='PURCHASE'&&row.amount<0)Unique(p,'purchases',row.id);}
 else if(action==='order.activate'){const row=db.orders[result.order?.id];if(row?.accountId===p.id&&row.activatedAt)Observe(p,'gameStarts',1);}
 else if(action==='points.exchange'){const row=db.pointConversions[result.conversion?.id];if(row?.accountId===p.id&&row.status==='COMPLETED')Unique(p,'exchanges',row.id);}
 else if(action==='shop.purchase'){const row=db.shopPurchases[result.purchase?.id];if(row?.accountId===p.id)Unique(p,'shopPurchases',row.id);}
 else if(action==='report'){
  const kind=body.kind==='comment'?'comment':'post',row=db.reports[p.id+':'+kind+':'+(body.id||body.postId)];
  if(row?.accountId===p.id){Unique(p,'reports',row.id);const target=ReportOwner(row);if(target&&target.id!==p.id){row.targetAccountId=target.id;Capture(target);Unique(target,'reportsReceived',row.id);Award(target);}}
 }
 for(const id of before.ids||[]){const target=s.ProfileById(id);if(!target)continue;Capture(target);if(action==='follow.set'||action==='block.set'){Observe(target,'followers',require('./follows').Counts(id).followers);Award(target);}}
 Award(p);
 for(const id of new Set([p.id,...(before.ids||[])])){const target=s.ProfileById(id);if(target)PayRewards(target);}
}
function Persist(p,apply){
 // Prepare badge state off to the side, then commit it and any payment together.
 // Failed reads or disk writes cannot leave awards or points outside rollback.
 const draft={...p,badgeProgress:p.badgeProgress?structuredClone(p.badgeProgress):undefined};
 Capture(draft);if(apply)apply(draft);Award(draft);
 if(JSON.stringify(p.badgeProgress)===JSON.stringify(draft.badgeProgress)&&!HasPayableReward(p,draft.badgeProgress))return;
 s.Atomic(()=>{p.badgeProgress=draft.badgeProgress;PayRewards(p);});
}
function AfterRead(p,action,body={},data={}){
 if(body.countView!==true||!['member','article','product','thread'].includes(action))return;
 let metric,id;
 if(action==='member'&&data.profile?.id&&data.profile.id!==p.id){metric='profileVisits';id=data.profile.id;}
 else if(action==='article'&&data.article?.id){metric='newsRead';id=data.article.id;}
 else if(action==='product'&&data.product?.id){metric='gamesRead';id=data.product.id;}
 else if(action==='thread'&&data.post?.id&&data.post.own===false){metric='postsRead';id=data.post.id;}
 if(metric)Persist(p,draft=>Unique(draft,metric,id));
}
function ChargeApproved(p,row){
 // Inside charges.Approve's Atomic, after both the receipt and approval exist.
 const payment=s.DB().ledger[row?.paymentId];
 if(!row||row.accountId!==p.id||row.status!=='APPROVED'||row.mode!=='WALLET'||!payment||payment.accountId!==p.id||payment.kind!=='QR_TOPUP'||payment.reference!==row.id||payment.amount!==row.amount||payment.amount<=0)return;
 Capture(p);Unique(p,'charges',row.id);Award(p);PayRewards(p);
}
function Public(p,known={}){
 if(!p.titleBadgeId)return null;const row=catalog.find(x=>x.id===p.titleBadgeId);if(!row||row.private)return null;
 const data=Record(p),earned=!!data?.awards[row.id];
 // A legacy selected badge remains visible until its next transactional capture.
 // Never scan tables, mutate state, or expose unearned progress in a projection.
 const legacy=!data&&NumberOf(known[row.metric]??(row.metric==='attendance'?p.attendance?.count:0))>=row.target;
 return earned||legacy?{id:row.id,title:row.title}:null;
}
function Inventory(viewer,target){
 const own=target.id===viewer.id,data=Record(target),selected=Public(target)?.id||'';
 let items=catalog.map(row=>{const award=data.awards[row.id];return {id:row.id,title:row.title,description:row.description,target:row.target,progress:NumberOf(data.counts[row.metric]),rewardPoints:award?.rewardPoints||row.rewardPoints,earned:!!award,selected:selected===row.id,selectable:!row.private,private:!!row.private,...(award?{earnedAt:award.at,legacy:!!award.legacy,...(own?{rewardPaid:!!award.rewardPaid,rewardStatus:award.rewardPaid?'PAID':'PENDING'}:{})}:{})};});
 if(!own)items=items.filter(row=>row.earned&&!row.private).map(({progress,private:privateRecord,...row})=>row);
 return {items,selected,own,readOnly:!own,profileId:target.id,profile:s.PublicProfile(target,own)};
}
function Read(viewer,body={}){
 const target=body.profileId?require('./profiles').Target(viewer,{id:body.profileId}):viewer;
 if(!target)s.Fail('MEMBER_NOT_FOUND');Persist(target);return Inventory(viewer,target);
}
function Select(p,body){
 if(body.profileId&&body.profileId!==p.id)s.Fail('NOT_OWNER');
 if(typeof body.id!=='string')s.Fail('INPUT_INVALID');Capture(p);
 if(body.id){const row=catalog.find(x=>x.id===body.id);if(!row||row.private||!Record(p).awards[row.id])s.Fail('BADGE_UNAVAILABLE');}
 if(p.titleBadgeId!==body.id){p.titleBadgeId=body.id;p.profileRevision=Math.max(p.profileRevision||0,p.avatarRevision||0)+1;}
 PayRewards(p);return {...Inventory(p,p),publicProfile:s.PublicProfile(p)};
}
module.exports={Public,Read,Select,Before,After,AfterRead,Capture,Settle,ChargeApproved};
