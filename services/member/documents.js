"use strict";
const s=require('./store');
const titles={terms:'이용약관',privacy:'개인정보 처리방침'};
function Read(body={}){
 const kind=body.kind;if(!Object.hasOwn(titles,kind))s.Fail('INPUT_INVALID');
 const row=s.DB().settings?.documents?.[kind];
 return {document:row?.published?{kind,title:titles[kind],body:row.body,updatedAt:row.updatedAt,revision:row.revision}: {kind,title:titles[kind],body:'',updatedAt:0,revision:0}};
}
function AdminRead(){return {items:Object.entries(titles).map(([kind,title])=>({kind,id:kind,title,...s.DB().settings?.documents?.[kind]}))};}
function Save(body,actor){
 if(!Object.hasOwn(titles,body.kind)||typeof body.published!=='boolean')s.Fail('INPUT_INVALID');
 const text=s.Text(body.body,20000,body.published),previous=s.DB().settings?.documents?.[body.kind];
 if(body.revision!==(previous?.revision||0))s.Fail('CONTENT_CHANGED');
 return s.Atomic(()=>{
  const db=s.DB();db.settings||={};db.settings.documents||={};
  return db.settings.documents[body.kind]={body:text,published:body.published,updatedAt:Date.now(),updatedBy:actor,revision:(previous?.revision||0)+1};
 });
}
module.exports={Read,AdminRead,Save};
