'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{performance}=require('node:perf_hooks');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix59-read-projections-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const s=require('../services/member/store'),commerce=require('../services/member/commerce'),social=require('../services/member/social'),follows=require('../services/member/follows');
const realNow=Date.now,now=1790000000000;Date.now=()=>now;
// Frozen FIX58 projection order. The reference and FIX59 implementation use
// exactly the same store, clock, helpers and fixtures; no second database or
// cache affects either measurement. Timing is diagnostic, never a flaky gate.
function previousCatalog(body={},viewer){
 const rows=Object.values(s.DB().products).filter(p=>p.published&&!p.deleted&&(!body.category||p.accessType===body.category)).sort((a,b)=>a.sort-b.sort||b.updatedAt-a.updatedAt);
 return s.Page(rows.map(p=>{const item={...commerce.PublicGame(p),unread:!!viewer&&(viewer.readProducts?.[p.id]||0)<(p.revision||1)};if(body.summary===true)item.description=String(p.description||'').replace(/\s+/g,' ').trim().slice(0,140);return item;}),body);
}
function previousNews(p,body={}){
 const category=x=>x==='UPDATE'?'NOTICE':x;
 const rows=Object.values(s.DB().news).filter(x=>!x.deleted&&x.published&&(!x.publishAt||x.publishAt<=Date.now())&&(!x.audience||x.audience===p.id)&&(!body.category||category(x.category)===body.category)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.at-a.at);
 return s.Page(rows.map(x=>({...social.PublicNews(x,!!body.summary),views:s.ViewCount('news',x.id),unread:(p.readNews?.[x.id]||((p.readNewsAt||0)>=x.at?(x.revision||1):0))<(x.revision||1)})),body);
}
function previousCounts(id){const rows=Object.values(s.DB().follows).filter(x=>!s.ProfileById(x.follower)?.blocked&&!s.ProfileById(x.following)?.blocked);return {followers:rows.filter(x=>x.following===id).length,following:rows.filter(x=>x.follower===id).length};}
function calls(method,run){const original=s[method];let count=0;s[method]=(...args)=>{count++;return original(...args);};try{run();return count;}finally{s[method]=original;}}
function timing(fn){for(let i=0;i<3;i++)fn();const times=[];for(let i=0;i<9;i++){const start=performance.now();fn();times.push(performance.now()-start);}return times.sort((a,b)=>a-b)[4];}
try{
 const db=s.DB(),viewer={id:'USR-PERF-0',subject:'PERF-0',nickname:'조회 회원',balance:0,readNews:{},readProducts:{}};
 for(let i=0;i<2000;i++){const p={id:'USR-PERF-'+i,subject:'PERF-'+i,nickname:'회원 '+i,balance:0,blocked:i>0&&i%17===0};db.profiles[p.subject]=p;}
 db.profiles[viewer.subject]=viewer;
 for(let i=0;i<6000;i++){
  const id='PRODUCT-'+i;db.products[id]={id,title:'게임 '+i,description:'  요약 설명\n'.repeat(100),genre:'레이싱',accessType:'TYPE'+(1+i%3),plans:[{days:1,price:100},{days:7,price:700}],published:i%13!==0,deleted:i%31===0,sort:i%7,revision:1+i%3,updatedAt:now-i,internalSecret:'PRODUCT-SECRET'};db.viewCounters['product:'+id]={count:i};
  if(i%5===0)viewer.readProducts[id]=3;
  const newsId='NEWS-'+i;db.news[newsId]={id:newsId,title:'소식 '+i,body:'공지 상세 본문 '.repeat(150),category:['NOTICE','UPDATE','ALERT','EVENT'][i%4],published:i%13!==0,deleted:i%31===0,pinned:i%23===0,at:now-i,revision:1+i%3,publishAt:i%11===0?now+1000:0,audience:i%19===0?'USR-PERF-1':i%5===0?viewer.id:'',privateInternal:'NEWS-SECRET'};db.viewCounters['news:'+newsId]={count:i};
  if(i%5===0)viewer.readNews[newsId]=3;
 }
 for(let i=0;i<24000;i++){const follower='USR-PERF-'+(1+i%1999),following='USR-PERF-'+(1+(i*31)%1999);db.follows['EDGE-'+i]={follower,following,at:now-i};}
 for(let i=1;i<20;i++){db.follows['VIEWER-IN-'+i]={follower:'USR-PERF-'+i,following:viewer.id,at:now};db.follows['VIEWER-OUT-'+i]={follower:viewer.id,following:'USR-PERF-'+i,at:now};}
 db.follows['MISSING-PROFILE']={follower:viewer.id,following:'USR-LEGACY-MISSING',at:now};db.revision++;
 const before=JSON.stringify(db);
 const pages=[{}, {limit:1}, {offset:12,limit:12}, {offset:25,limit:5,summary:true}, {offset:-2,limit:0}, {offset:5.5,limit:3.5}, {offset:999999,limit:50}, {category:'TYPE2',summary:true}, {category:'NOTICE',summary:true}, {category:'ALERT'}, {category:'MISSING'}];
 for(const body of pages){assert.deepEqual(commerce.Catalog(body,viewer),previousCatalog(body,viewer));assert.deepEqual(commerce.Catalog(body),previousCatalog(body));assert.deepEqual(social.News(viewer,body),previousNews(viewer,body));}
 for(const id of [viewer.id,'USR-PERF-17','USR-PERF-521','USR-LEGACY-MISSING'])assert.deepEqual(follows.Counts(id),previousCounts(id));
 assert.equal(JSON.stringify(db),before,'pagination and relationship projections never mark reads, mutate source rows or save');
 for(const item of commerce.Catalog({summary:true},viewer).items){assert.equal(item.internalSecret,undefined);assert.ok(item.description.length<=140);}
 for(const item of social.News(viewer,{summary:true}).items){assert.equal(item.body,undefined);assert.equal(item.privateInternal,undefined);assert.ok(!item.audience||item.audience===viewer.id);}
 const body={offset:12,limit:12,summary:true};
 const metrics=[
  {name:'Catalog',old:()=>previousCatalog(body,viewer),next:()=>commerce.Catalog(body,viewer),method:'ViewCount'},
  {name:'News',old:()=>previousNews(viewer,body),next:()=>social.News(viewer,body),method:'ViewCount'},
  {name:'Followers',old:()=>previousCounts(viewer.id),next:()=>follows.Counts(viewer.id),method:'ProfileById'}
 ];
 for(const metric of metrics){
  const previousCalls=calls(metric.method,metric.old),nextCalls=calls(metric.method,metric.next);
  assert.ok(nextCalls<previousCalls/20,metric.name+' avoids unrelated projection work');
  if(metric.method==='ViewCount')assert.equal(nextCalls,12,'only the returned page needs view-count projection');
  const oldMs=timing(metric.old),newMs=timing(metric.next);console.log('FIX59 '+metric.name+': helper calls '+previousCalls+' -> '+nextCalls+'; median '+oldMs.toFixed(3)+' ms -> '+newMs.toFixed(3)+' ms on identical fixtures');
 }
 console.log('FIX59 READ PROJECTIONS PASS: identical visible output, unread flags, categories, summary/full forms, pagination bounds, legacy missing profiles, read purity and bounded page/relationship work.');
}finally{Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true});}
