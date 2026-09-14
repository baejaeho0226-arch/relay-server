'use strict';
const s=require('./store');
const LIMIT=20;
// Only named screens are retained. IDs, queries and other members' pages never
// enter service history, and labels always come from this server-owned map.
const SERVICES=Object.freeze({
 news:['소식','News','news'],catalog:['게임','Games','shop'],feed:['피드','Feed','feed'],
 events:['이벤트','Events','gift'],casino:['모아 카지노','Moa Casino','casino'],original:['모아 Original','Moa Original','casino'],
 baccarat:['바카라','Baccarat','casino'],roulette:['룰렛','Roulette','casino'],slots:['슬롯','Slots','casino'],blackjack:['블랙잭','Blackjack','casino'],
 crash:['CRASH','CRASH','casino'],dice:['DICE','DICE','casino'],mines:['MINES','MINES','casino'],plinko:['PLINKO','PLINKO','casino'],
 limbo:['LIMBO','LIMBO','casino'],hilo:['HILO','HILO','casino'],tower:['TOWER','TOWER','casino'],
 shop:['상점','Shop','store'],me:['마이페이지','My Page','user'],all:['전체 메뉴','All menus','grid'],
 orders:['이용권 내역','Pass history','ticket'],payments:['결제 내역','Payment history','receipt'],myfeed:['내 게시물','My posts','grid'],
 charge:['개인 지갑','Wallet','wallet'],bookmarks:['저장한 내용','Saved','bookmark'],blocks:['차단한 회원','Blocked members','block'],
 support:['고객센터','Support','help'],settings:['설정','Settings','settings'],appearance:['화면 설정','Appearance','settings'],
 'settings.notifications':['알림 설정','Notification settings','settings'],'settings.profile':['프로필 게시글','Profile posts','settings'],
 'settings.language':['언어 설정','Language','settings'],'settings.currency':['잔액 표시 통화','Display currency','settings'],
 'settings.features':['앱 기능','App features','settings'],'settings.home':['홈 기능','Home features','settings'],
 'settings.news':['소식 기능','News features','news'],'settings.games':['게임 기능','Game features','shop'],
 'settings.feed':['피드 기능','Feed features','feed'],notifications:['알림','Notifications','news'],
 'settings.account':['계정 설정','Account','user'],about:['앱 정보','About','help'],policies:['약관 및 정책','Terms and policies','help'],
 points:['포인트','Points','gift'],attendance:['출석 체크','Attendance','calendar'],wheel:['돌림판','Wheel','gift'],
 popular:['인기 피드 Top 10','Popular feed Top 10','heart'],activity:['실시간 게임 구매','Live game purchases','receipt'],
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
  recentProducts:Entries(p,'products').map(row=>{const product=ValidProduct(row.id);return {...row,title:product.title,genre:product.genre||product.details?.genre||'게임'};}),
  recentServices:Entries(p,'services').map(row=>{const [title,titleEn,icon]=SERVICES[row.route];return {...row,title,titleEn,icon};})
 };
}
function Remember(p,key,id){
 const rows=Entries(p,key),field=key==='products'?'id':'route';
 // A repeated read/open of the same newest entry is a true no-op: it cannot
 // farm timestamps, revisions or persistence writes during refresh/polling.
 if(rows[0]?.[field]===id)return false;
 s.Atomic(()=>{p.recentHistory={products:Entries(p,'products'),services:Entries(p,'services'),[key]:[{[field]:id,at:Date.now()},...rows.filter(row=>row[field]!==id)].slice(0,LIMIT)};});
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
module.exports={LIMIT,SERVICES,Read,Record,RecordProduct};
