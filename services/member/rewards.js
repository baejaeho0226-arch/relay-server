'use strict';
const crypto=require('node:crypto'),s=require('./store');
const Day=at=>new Date(at+9*3600000).toISOString().slice(0,10);
const defaults={revision:1,enabled:true,attendanceDays:7,attendancePoints:100,chargeUnit:1000,
 prizes:[{points:10,weight:40},{points:20,weight:25},{points:30,weight:18},{points:50,weight:10},{points:100,weight:6},{points:300,weight:1}]};
function Rules(){const rules=structuredClone(s.DB().settings.rewards||defaults);return {...rules,pointExchange:require('./points').Rules(rules.pointExchange)};}
function Wallet(p){return {points:p.points||0,spins:p.eventSpins||0};}
function Credit(p,amount,kind,reference){
 const key=p.id+':'+kind+':'+reference,old=s.DB().pointLedger[key];if(old)return old;
 const balance=(p.points||0)+amount;if(!Number.isSafeInteger(balance)||balance<0||balance>100000000)s.Fail('POINT_BALANCE_INVALID');
 p.points=balance;
 const row={id:s.Id('PNT'),accountId:p.id,amount,balance,kind,reference,at:Date.now()};s.DB().pointLedger[key]=row;return row;
}
function Attendance(p,now=Date.now()){
 const r=Rules(),a=p.attendance||{},day=Day(now),streak=[day,Day(now-86400000)].includes(a.day)?a.streak||0:0;
 const cycle=streak>0?((streak-1)%r.attendanceDays)+1:0;
 return {day,checked:a.day===day,count:a.count||0,streak,at:a.at||0,days:a.days||[],cycle,
  goal:r.attendanceDays,rewardPoints:r.attendancePoints,rewardEvery:r.attendanceDays,points:p.points||0};
}
function Check(p){
 const now=Date.now(),day=Day(now),old=p.attendance||{},r=Rules();let reward=null;
 if(old.day!==day){
  p.attendance={day,at:now,count:(old.count||0)+1,streak:old.day===Day(now-86400000)?(old.streak||0)+1:1,
   days:[...(old.days||[]).filter(x=>x!==day),day].slice(-90)};
  if(p.attendance.streak%r.attendanceDays===0)reward=Credit(p,r.attendancePoints,'ATTENDANCE',day);
 }
 return {...Read(p),reward};
}
function GrantCharge(p,row){
 // Called in the QR approval transaction. Partial charges carry forward;
 // reprocessing the same approval can never grant additional turns.
 if(row.rewardGranted)return;
 const rules=Rules(),total=(p.spinChargeRemainder||0)+row.amount;
 const granted=Math.floor(total/rules.chargeUnit);
 p.spinChargeRemainder=total%rules.chargeUnit;p.eventSpins=(p.eventSpins||0)+granted;
 if(!Number.isSafeInteger(p.eventSpins)||p.eventSpins>10000000)s.Fail('POINT_BALANCE_INVALID');
 row.rewardGranted=true;row.eventSpinsGranted=granted;
}
function History(p,body={}){
 return s.Page(Object.values(s.DB().pointLedger).filter(x=>x.accountId===p.id).sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id)),body,20);
}
function Read(p,body={}){return {rules:Rules(),wallet:Wallet(p),attendance:Attendance(p),history:History(p,body),events:require('./social').News(p,{category:'EVENT',summary:true,limit:12}),profile:s.PublicProfile(p,true)};}
function Spin(p,body){
 const rules=Rules();if(!rules.enabled)s.Fail('EVENT_CLOSED');if(body.revision!==rules.revision)s.Fail('CONTENT_CHANGED');
 if((p.eventSpins||0)<1)s.Fail('EVENT_NO_TURNS');
 const total=rules.prizes.reduce((sum,x)=>sum+x.weight,0);let draw=crypto.randomInt(total),index=0;
 for(;index<rules.prizes.length-1;index++){if(draw<rules.prizes[index].weight)break;draw-=rules.prizes[index].weight;}
 const id=s.Id('SPIN');p.eventSpins--;
 const reward=Credit(p,rules.prizes[index].points,'ROULETTE',id);
 const spin={id,accountId:p.id,index,points:reward.amount,at:reward.at,revision:rules.revision};s.DB().eventSpins[id]=spin;
 return {...Read(p),spin,reward};
}
function SaveRules(body,actor){
 const previous=Rules();if(body.revision!==previous.revision)s.Fail('CONTENT_CHANGED');
 if(typeof body.enabled!=='boolean')s.Fail('INPUT_INVALID');
 const attendanceDays=s.Money(body.attendanceDays,1,31),attendancePoints=s.Money(body.attendancePoints,1,100000),chargeUnit=s.Money(body.chargeUnit,1,10000000);
 if(!Array.isArray(body.prizes)||body.prizes.length!==6)s.Fail('INPUT_INVALID');
 const prizes=body.prizes.map(x=>({points:s.Money(x.points,1,100000),weight:s.Money(x.weight,1,10000)}));
 const pointExchange=require('./points').Validate(body.pointExchange,previous.pointExchange);
 return s.Atomic(()=>{s.DB().settings.rewards={enabled:body.enabled,attendanceDays,attendancePoints,chargeUnit,prizes,pointExchange,revision:previous.revision+1,updatedAt:Date.now(),updatedBy:actor};return Rules();});
}
function Admin(body={}){
 const rows=Object.values(s.DB().pointLedger).sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
 return {rules:Rules(),...s.Page(rows.map(x=>({...x,member:s.ProfileById(x.accountId)?s.PublicProfile(s.ProfileById(x.accountId)):{id:'',nickname:'탈퇴 회원'}})),body,30)};
}
module.exports={Day,Rules,Wallet,Credit,Attendance,Check,GrantCharge,History,Read,Spin,SaveRules,Admin};
