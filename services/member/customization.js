'use strict';
// Cosmetic entitlements belong to the authenticated member, never a supplied ID.
const s=require('./store');
const items={
 NICKNAME_TICKET:{title:'닉네임 변경권',description:'30일 변경 대기 중인 닉네임을 한 번 변경할 수 있어요.',inventory:'nicknameTickets'},
 NICKNAME_COLOR:{title:'닉네임 색상',description:'원하는 닉네임 색상을 한 번 적용할 수 있어요.',inventory:'nicknameColors'}
};
const defaults={revision:1,items:{NICKNAME_TICKET:{enabled:false,price:0},NICKNAME_COLOR:{enabled:false,price:0}}};
function Rules(){return structuredClone(s.DB().settings.memberShop||defaults);}
function Inventory(p){return {nicknameTickets:p.inventory?.nicknameTickets||0,nicknameColors:p.inventory?.nicknameColors||0};}
function Read(p){const rules=Rules();return {currency:'POINTS',rules:{revision:rules.revision},items:Object.entries(items).map(([id,item])=>({id,title:item.title,description:item.description,currency:'POINTS',...rules.items[id]})),inventory:Inventory(p),profile:s.PublicProfile(p,true)};}
function SaveRules(body,actor){
 const old=Rules();if(body.revision!==old.revision)s.Fail('CONTENT_CHANGED');
 if(!body.items||typeof body.items!=='object'||Array.isArray(body.items))s.Fail('INPUT_INVALID');
 const next={};for(const id of Object.keys(items)){
  const row=body.items[id];if(!row||typeof row.enabled!=='boolean')s.Fail('INPUT_INVALID');
  next[id]={enabled:row.enabled,price:s.Money(row.price,row.enabled?1:0,100000000)};
 }
 return s.Atomic(()=>{s.DB().settings.memberShop={revision:old.revision+1,items:next,updatedAt:Date.now(),updatedBy:actor};return Rules();});
}
function Purchase(p,body){
 const rules=Rules();if(body.revision!==rules.revision)s.Fail('CONTENT_CHANGED');
 const item=items[body.itemId],offer=rules.items[body.itemId];if(!item||!offer?.enabled)s.Fail('SHOP_UNAVAILABLE');
 const inventory=Inventory(p);if(inventory[item.inventory]>=10000)s.Fail('INVENTORY_LIMIT');
 if((p.points||0)<offer.price)s.Fail('INSUFFICIENT_POINTS');
 const id=s.Id('SHOP'),payment=require('./rewards').Credit(p,-offer.price,'SHOP_PURCHASE',id);
 inventory[item.inventory]++;p.inventory=inventory;p.profileRevision=Math.max(p.profileRevision||0,p.avatarRevision||0)+1;
 const purchase={id,accountId:p.id,itemId:body.itemId,title:item.title,currency:'POINTS',price:offer.price,pointId:payment.id,at:payment.at};s.DB().shopPurchases[id]=purchase;
 return {...Read(p),purchase};
}
function Consume(p,key,kind,reference){
 const inventory=Inventory(p);if(inventory[key]<1)s.Fail(key==='nicknameTickets'?'NICKNAME_COOLDOWN':'COLOR_TICKET_REQUIRED');
 inventory[key]--;p.inventory=inventory;
 const id=s.Id('COS');s.DB().cosmeticUses[id]={id,accountId:p.id,kind,reference,at:Date.now()};
}
function ApplyColor(p,body){
 if(typeof body.color!=='string'||!/^#[0-9a-f]{6}$/i.test(body.color))s.Fail('NICKNAME_COLOR_INVALID');
 const color=body.color.toUpperCase();
 if(color!==(p.nicknameColor||'').toUpperCase()){
  Consume(p,'nicknameColors','NICKNAME_COLOR',color);p.nicknameColor=color;
  p.profileRevision=Math.max(p.profileRevision||0,p.avatarRevision||0)+1;
 }
 return {...Read(p),publicProfile:s.PublicProfile(p)};
}
function Admin(body={}){
 const rows=Object.values(s.DB().shopPurchases).reverse().sort((a,b)=>b.at-a.at).map(row=>{const member=s.ProfileById(row.accountId);return {...row,memberHandle:member?'@'+s.Handle(member):'',member:member?s.PublicProfile(member):null};});
 return {rules:Rules(),purchases:s.Page(rows,body,30)};
}
module.exports={Rules,Inventory,Read,SaveRules,Purchase,Consume,ApplyColor,Admin};
