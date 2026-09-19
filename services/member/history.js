'use strict';
const s=require('./store');
const LIMIT=20;
// Only named screens are retained. IDs, queries and other members' pages never
// enter service history, and labels always come from this server-owned map.
const SERVICES=Object.freeze({
 news:['소식','News','news'],catalog:['게임','Games','shop'],feed:['피드','Feed','feed'],
 'event.dino':['공룡 게임','Dino Run','event.dino'],'event.flappy':['플래피 버드','Flappy Bird','event.flappy'],
 'event.whack':['두더지 게임','Whack-a-mole','event.whack'],'event.dodge':['똥피하기','Dodge','event.dodge'],'event.rhythm':['리듬 게임','Rhythm','event.rhythm'],
 events:['이벤트','Events','gift'],playground:['모아의 놀이터','Moa Playground','casino'],casino:['모아의 놀이터','Moa Playground','casino'],original:['모아의 놀이터','Moa Playground','casino'],
 baccarat:['바카라','Baccarat','casino'],roulette:['룰렛','Roulette','casino'],slots:['슬롯','Slots','casino'],blackjack:['블랙잭','Blackjack','casino'],
 crash:['크래시','Crash','casino'],dice:['다이스','Dice','casino'],mines:['마인즈','Mines','casino'],plinko:['플링코','Plinko','casino'],
 limbo:['림보','Limbo','casino'],hilo:['힐로','HiLo','casino'],tower:['타워','Tower','casino'],
 shop:['상점','Shop','store'],me:['마이페이지','My Page','user'],all:['전체 메뉴','All menus','grid'],
 orders:['이용권 내역','Pass history','ticket'],payments:['결제 내역','Payment history','receipt'],myfeed:['내 게시물','My posts','grid'],
 charge:['개인 지갑','Wallet','wallet'],bookmarks:['저장한 내용','Saved','bookmark'],blocks:['차단한 회원','Blocked members','block'],
 support:['고객센터','Support','help'],settings:['설정','Settings','settings'],appearance:['화면 설정','Appearance','settings'],
 'settings.notifications':['알림 설정','Notification settings','settings'],'settings.profile':['프로필 게시글','Profile posts','settings'],
 'settings.language':['언어 설정','Language','settings'],'settings.currency':['잔액 표시 통화','Display currency','settings'],
 'settings.feed':['피드 기본 정렬','Feed default sort','settings'],notifications:['알림','Notifications','news'],
 'settings.account':['계정 설정','Account','user'],about:['앱 정보','About','help'],policies:['약관 및 정책','Terms and policies','help'],
 points:['포인트','Points','gift'],attendance:['출석 체크','Attendance','calendar'],wheel:['돌림판','Wheel','gift'],
 popular:['인기 피드 Top 10','Popular feed Top 10','heart'],activity:['실시간 게임 구매','Live game purchases','receipt'],
 'top.games':['자주 많이 산 게임','Most purchased games','shop'],withdraw:['출금','Withdraw','wallet'],'title.color':['칭호 색상','Title colors','badge'],'title.name':['칭호 이름 변경','Rename title','edit'],
 badges:['배지','Badges','badge'],'nickname.color':['닉네임 색상','Nickname color','user']
});
function Rows(p,key){const rows=p.recentHistory?.[key];return Array.isArray(rows)?rows:[];}
function ValidProduct(id){const row=typeof id==='string'&&s.DB().products[id];return row&&row.published&&!row.deleted?row:null;}
function Entries(p,key){
 const seen=new Set(),rows=[];
 for(const row of Rows(p,key)){
  if(!row||typeof row!=='object'||!Number.isSafeInteger(row.at)||row.at<0)continue;
  const id=key==='products'?row.id:row.route;
  if(seen.has(id)||(key==='products'?!ValidProduct(id):!Object.hasOwn(SERVICES,id)))continue;
  seen.add(id);rows.push(key==='products'?{id,at:row.at}:{route:id,at:row.at});if(rows.length===LIMIT)break;
 }
 return rows;
}
function Read(p){
 return {
  recentProducts:Entries(p,'products').map(row=>{const product=ValidProduct(row.id);return {...row,title:product.title,imageCover:require('./media').GameCover(product),genre:product.genre||product.details?.genre||'게임'};}),
  recentServices:Entries(p,'services').map(row=>{const [title,titleEn,icon]=SERVICES[row.route];return {...row,title,titleEn,icon};})
 };
}
function NeedsPrune(p,products,services){
 if(!p.recentHistory)return false;
 return JSON.stringify(Rows(p,'products'))!==JSON.stringify(products)||JSON.stringify(Rows(p,'services'))!==JSON.stringify(services);
}
// Startup migration calls this after installing the imported member store.
// Ordinary history reads remain pure and never create a save per refresh.
function PruneStored(p){
 const products=Entries(p,'products'),services=Entries(p,'services');
 if(!NeedsPrune(p,products,services))return false;
 p.recentHistory={products,services};return true;
}
function Remember(p,key,id){
 const products=Entries(p,'products'),services=Entries(p,'services');
 const rows=key==='products'?products:services,field=key==='products'?'id':'route';
 // A repeated read/open of the same newest entry is a true no-op: it cannot
 // farm timestamps, revisions or persistence writes during refresh/polling.
 if(rows[0]?.[field]===id){
  if(NeedsPrune(p,products,services))s.Atomic(()=>{p.recentHistory={products,services};});
  return false;
 }
 s.Atomic(()=>{p.recentHistory={products,services,[key]:[{[field]:id,at:Date.now()},...rows.filter(row=>row[field]!==id)].slice(0,LIMIT)};});
 return true;
}
function Record(p,body={}){
 if(Object.keys(body).some(key=>!['route','_wire','_delta'].includes(key)))s.Fail('INPUT_INVALID');
 if(typeof body.route!=='string'||!Object.hasOwn(SERVICES,body.route))s.Fail('INPUT_INVALID');
 return {recorded:Remember(p,'services',body.route)};
}
function RecordProduct(p,body){
 // This path is reached only after commerce validates an authenticated detail
 // response. Catalog previews, purchases and automatic refreshes do not count.
 if(body.countView!==true||!ValidProduct(body.id))return false;
 return Remember(p,'products',body.id);
}
module.exports={LIMIT,SERVICES,Read,Record,RecordProduct,PruneStored};
