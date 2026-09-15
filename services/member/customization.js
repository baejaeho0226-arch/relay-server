'use strict';
// Cosmetic entitlements belong to the authenticated member, never a supplied ID.
const s=require('./store'),badges=require('./badges');
const items={
 NICKNAME_TICKET:{title:'닉네임 변경권',description:'30일 변경 대기 중인 닉네임을 한 번 변경할 수 있어요.',inventory:'nicknameTickets'},
 NICKNAME_COLOR:{title:'닉네임 색상',description:'원하는 닉네임 색상을 한 번 적용할 수 있어요.',inventory:'nicknameColors'},
 TITLE_COLOR:{title:'칭호 색상 세트',description:'보유한 칭호의 글자 색과 아이콘 색을 함께 한 번 변경해요.',inventory:'titleColors'},
 TITLE_NAME:{title:'칭호 이름 변경권',description:'모든 기본 칭호를 모으면 구매할 수 있어요. 보유한 칭호 이름을 한 번 변경해요.',inventory:'titleNames'}
};
// Preserve old offers and their revision during upgrade; new offers have bounded
// point prices and appear in the same administrator-controlled catalog.
const defaults={revision:1,items:{NICKNAME_TICKET:{enabled:false,price:0},NICKNAME_COLOR:{enabled:false,price:0},TITLE_COLOR:{enabled:true,price:500},TITLE_NAME:{enabled:true,price:2000}}};
function Rules(){const stored=s.DB().settings.memberShop||defaults;return {...structuredClone(stored),items:Object.fromEntries(Object.keys(items).map(id=>[id,structuredClone(stored.items?.[id]||defaults.items[id])]))};}
function Inventory(p){return Object.fromEntries(Object.values(items).map(item=>[item.inventory,p.inventory?.[item.inventory]||0]));}
function Read(p,capture=true){
 if(capture)badges.Ensure(p);
 const rules=Rules(),inventory=Inventory(p),allTitlesEarned=badges.AllTitlesEarned(p);
 return {currency:'POINTS',rules:{revision:rules.revision},items:Object.entries(items).map(([id,item])=>{const locked=id==='TITLE_NAME'&&!allTitlesEarned;return {id,title:item.title,description:item.description,currency:'POINTS',...rules.items[id],owned:inventory[item.inventory],purchasable:rules.items[id].enabled&&!locked,lockedReason:locked?'ALL_TITLES_REQUIRED':''};}),inventory,badges:badges.Cosmetics(p),allTitlesEarned,profile:s.PublicProfile(p,true)};
}
function SaveRules(body,actor){
 const old=Rules();if(body.revision!==old.revision)s.Fail('CONTENT_CHANGED');
 if(!body.items||typeof body.items!=='object'||Array.isArray(body.items))s.Fail('INPUT_INVALID');
 const next={};for(const id of Object.keys(items)){
  // Old admin clients submit only their two known products. Preserve new offers
  // rather than silently disabling them or blocking an otherwise valid update.
  const row=Object.hasOwn(body.items,id)?body.items[id]:((id==='TITLE_COLOR'||id==='TITLE_NAME')?old.items[id]:null);
  if(!row||typeof row.enabled!=='boolean')s.Fail('INPUT_INVALID');
  next[id]={enabled:row.enabled,price:s.Money(row.price,row.enabled?1:0,100000000)};
 }
 return s.Atomic(()=>{s.DB().settings.memberShop={revision:old.revision+1,items:next,updatedAt:Date.now(),updatedBy:actor};return Rules();});
}
function Purchase(p,body){
 const rules=Rules();if(body.revision!==rules.revision)s.Fail('CONTENT_CHANGED');
 const item=items[body.itemId],offer=rules.items[body.itemId];if(!item||!offer?.enabled)s.Fail('SHOP_UNAVAILABLE');
 if(body.itemId==='TITLE_NAME'&&!badges.AllTitlesEarned(p))s.Fail('ALL_TITLES_REQUIRED');
 const inventory=Inventory(p);if(inventory[item.inventory]>=10000)s.Fail('INVENTORY_LIMIT');
 if((p.points||0)<offer.price)s.Fail('INSUFFICIENT_POINTS');
 const id=s.Id('SHOP'),payment=require('./rewards').Credit(p,-offer.price,'SHOP_PURCHASE',id);
 inventory[item.inventory]++;p.inventory=inventory;p.profileRevision=Math.max(p.profileRevision||0,p.avatarRevision||0)+1;
 const purchase={id,accountId:p.id,itemId:body.itemId,title:item.title,currency:'POINTS',price:offer.price,pointId:payment.id,at:payment.at};s.DB().shopPurchases[id]=purchase;
 return {...Read(p,false),purchase};
}
function Consume(p,key,kind,reference){
 const inventory=Inventory(p),errors={nicknameTickets:'NICKNAME_COOLDOWN',nicknameColors:'COLOR_TICKET_REQUIRED',titleColors:'TITLE_COLOR_TICKET_REQUIRED',titleNames:'TITLE_NAME_TICKET_REQUIRED'};
 if(!Object.hasOwn(errors,key)||inventory[key]<1)s.Fail(errors[key]||'INPUT_INVALID');
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
 return {...Read(p,false),publicProfile:s.PublicProfile(p)};
}
function Title(p,body){
 if(body.profileId&&body.profileId!==p.id)s.Fail('NOT_OWNER');
 if(!badges.Owned(p,body.id))s.Fail('BADGE_UNAVAILABLE');
 return p.titleStyles?.[body.id]||{};
}
function WriteTitle(p,id,style){
 p.titleStyles={...(p.titleStyles||{}),[id]:style};
 p.profileRevision=Math.max(p.profileRevision||0,p.avatarRevision||0)+1;
 return {...Read(p,false),publicProfile:s.PublicProfile(p)};
}
function ApplyTitleColor(p,body){
 const previous=Title(p,body);
 if([body.color,body.iconColor].some(value=>typeof value!=='string'||!/^#[0-9a-f]{6}$/i.test(value)))s.Fail('TITLE_COLOR_INVALID');
 const color=body.color.toUpperCase(),iconColor=body.iconColor.toUpperCase();
 if(color!==previous.color||iconColor!==previous.iconColor){
  Consume(p,'titleColors','TITLE_COLOR',body.id);
  return WriteTitle(p,body.id,{...previous,color,iconColor});
 }
 return {...Read(p,false),publicProfile:s.PublicProfile(p)};
}
function ApplyTitleName(p,body){
 const previous=Title(p,body);if(!badges.AllTitlesEarned(p))s.Fail('ALL_TITLES_REQUIRED');
 // Plain single-line display text only: no controls, bidi overrides or markup.
 if(typeof body.name!=='string')s.Fail('TITLE_NAME_INVALID');
 const name=body.name.normalize('NFC').trim();
 if(!name||name.length>20||/[<>\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/u.test(name))s.Fail('TITLE_NAME_INVALID');
 const current=badges.Cosmetics(p).find(item=>item.id===body.id).title;
 if(name!==current){
  Consume(p,'titleNames','TITLE_NAME',body.id);
  return WriteTitle(p,body.id,{...previous,name});
 }
 return {...Read(p,false),publicProfile:s.PublicProfile(p)};
}
function Admin(body={}){
 const rows=Object.values(s.DB().shopPurchases).reverse().sort((a,b)=>b.at-a.at).map(row=>{const member=s.ProfileById(row.accountId);return {...row,memberHandle:member?'@'+s.Handle(member):'',member:member?s.PublicProfile(member):null};});
 return {rules:Rules(),purchases:s.Page(rows,body,30)};
}
module.exports={Rules,Inventory,Read,SaveRules,Purchase,Consume,ApplyColor,ApplyTitleColor,ApplyTitleName,Admin};
