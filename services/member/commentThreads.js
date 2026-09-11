 'use strict';
const s=require('./store');
function Visible(row,p){return !!row&&!row.deleted&&!row.hidden&&!require('./socialActions').Blocked(p.id,row.accountId)&&!s.ProfileById(row.accountId)?.blocked;}
function ParentIndex(postId){
 // New records store the direct target. Old records only stored a root and an
 // account: recover the nearest preceding comment in that conversation once.
 const rows=Object.values(s.DB().comments).filter(x=>x.postId===postId).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
 const parents=new Map(),last=new Map();
 for(const row of rows){
  const root=row.parentId||row.id;
  parents.set(row.id,row.replyToId||(row.parentId?(last.get(root+':'+row.replyTo)||row.parentId):''));
  last.set(root+':'+row.accountId,row.id);
 }
 return parents;
}
function Parent(row,parents){return row.replyToId||(row.parentId?(parents||ParentIndex(row.postId)).get(row.id)||row.parentId:'');}
function Counts(postId,p){
 const counts=new Map();counts.parents=ParentIndex(postId);
 for(const row of Object.values(s.DB().comments)){if(row.postId!==postId||!Visible(row,p))continue;const parent=Parent(row,counts.parents);if(parent)counts.set(parent,(counts.get(parent)||0)+1);}
 return counts;
}
function Delta(row,p){const counts=Counts(row.postId,p),id=Parent(row,counts.parents),parent=s.DB().comments[id];return Visible(parent,p)?[{id,postId:row.postId,replies:counts.get(id)||0}]:[];}
module.exports={Visible,Parent,Counts,Delta};
