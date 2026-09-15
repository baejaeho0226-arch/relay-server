'use strict';
// Account-owned private conversations. Mutation receipts contain identifiers only:
// replaying a send after shared deletion must never disclose old message bodies.
const s=require('./store'),social=require('./socialActions');
const PAGE_SIZE=30,MAX_TEXT=2000;
function Pair(a,b){return [a,b].sort().join(':');}
function ID(value){if(typeof value!=='string'||!/^DM-[A-F0-9]{24}$/.test(value))s.Fail('DM_NOT_FOUND');return value;}
function Row(p,id){const row=s.DB().directThreads[ID(id)];if(!row||!row.members.includes(p.id))s.Fail('DM_NOT_FOUND');return row;}
function Other(row,p){return s.ProfileById(row.members.find(id=>id!==p.id));}
function Available(p,peer){return !!peer&&!peer.blocked&&!social.Blocked(p.id,peer.id);}
function Peer(p){
 let avatar=p.avatarThumb||'';
 // Legacy thumbnails are computed without writing to a public read projection.
 if(!avatar&&p.avatar)try{avatar=require('./social').AvatarThumb(p.avatar);}catch(_){}
 return {id:p.id,nickname:p.nickname,handle:s.Handle(p),avatar,avatarRevision:p.avatarRevision||0,profileRevision:p.profileRevision||p.avatarRevision||0,nicknameColor:p.nicknameColor||'',titleBadge:require('./badges').Public(p)};
}
function PublicMessage(row,p){return {id:row.id,seq:row.seq,text:row.text,at:row.at,own:row.senderId===p.id};}
function Unread(row,p){return Math.max(0,(row.received[p.id]||0)-(row.readReceived[p.id]||0));}
function Summary(row,p,peer){
 const last=row.messages.at(-1);
 return {id:row.id,peer:Peer(peer),revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,lastSeq:row.lastSeq,unreadCount:Unread(row,p),lastMessage:last?{...PublicMessage(last,p),text:last.text.slice(0,160)}:null};
}
function PageValue(value,fallback,min,max){if(value===undefined)return fallback;if(!Number.isSafeInteger(value)||value<min||value>max)s.Fail('INPUT_INVALID');return value;}
function List(p,body={}){
 const offset=PageValue(body.offset,0,0,100000),limit=PageValue(body.limit,20,1,30);
 const rows=Object.values(s.DB().directThreads).filter(row=>!row.deletedAt&&row.members.includes(p.id)&&Available(p,Other(row,p))).sort((a,b)=>b.updatedAt-a.updatedAt||b.id.localeCompare(a.id));
 return {offset,items:rows.slice(offset,offset+limit).map(row=>Summary(row,p,Other(row,p))),total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null,unreadCount:rows.reduce((sum,row)=>sum+Unread(row,p),0)};
}
function Thread(p,body={}){
 const row=Row(p,body.id),peer=Other(row,p),available=Available(p,peer),deleted=!!row.deletedAt;
 const thread={id:row.id,peer:available?Peer(peer):null,revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,lastSeq:deleted?0:row.lastSeq,readSeq:row.readSeq[p.id]||0,peerReadSeq:peer?(row.readSeq[peer.id]||0):0,unreadCount:deleted||!available?0:Unread(row,p),deleted,canSend:!deleted&&available,unavailable:!available,...(deleted?{deletedAt:row.deletedAt}:{})};
 if(deleted||!available)return {thread,messages:[],total:0,nextBeforeSeq:null,beforeSeq:body.beforeSeq||0};
 const before=PageValue(body.beforeSeq,row.lastSeq+1,1,Number.MAX_SAFE_INTEGER),limit=PageValue(body.limit,PAGE_SIZE,1,PAGE_SIZE);
 // Sequence numbers are contiguous; slicing by cursor avoids scanning the
 // conversation on every live refresh, while returning chronological messages.
 const end=Math.min(row.messages.length,before-1),start=Math.max(0,end-limit),messages=row.messages.slice(start,end);
 return {thread,messages:messages.map(message=>PublicMessage(message,p)),total:row.messages.length,nextBeforeSeq:start>0?messages[0].seq:null,beforeSeq:body.beforeSeq||0};
}
function Open(p,body={}){
 if(typeof body.memberId!=='string'||body.memberId.length>80)s.Fail('DM_UNAVAILABLE');
 const peer=s.Resolve(body.memberId);if(peer?.id===p.id)s.Fail('DM_SELF');if(!Available(p,peer))s.Fail('DM_UNAVAILABLE');
 const db=s.DB(),pair=Pair(p.id,peer.id),previous=db.directThreads[db.directPairs[pair]];
 if(previous&&!previous.deletedAt)return {id:previous.id};
 const id=s.Id('DM'),at=Date.now(),members=[p.id,peer.id].sort(),zero=()=>Object.fromEntries(members.map(member=>[member,0]));
 db.directThreads[id]={id,pair,members,revision:1,createdAt:at,updatedAt:at,lastSeq:0,readSeq:zero(),received:zero(),readReceived:zero(),messages:[],deletedAt:0};db.directPairs[pair]=id;
 return {id};
}
function Writable(p,id){const row=Row(p,id);if(row.deletedAt)s.Fail('DM_DELETED');if(!Available(p,Other(row,p)))s.Fail('DM_UNAVAILABLE');return row;}
function MarkRead(row,p,throughSeq){
 const previous=row.readSeq[p.id]||0;if(throughSeq<=previous)return false;
 // Advance only through a cursor already rendered by the client, never through
 // newly arriving messages which the current screen has not displayed yet.
 for(let index=previous;index<throughSeq;index++)if(row.messages[index].senderId!==p.id)row.readReceived[p.id]++;
 row.readSeq[p.id]=throughSeq;return true;
}
function Send(p,body={}){
 const row=Writable(p,body.id);
 if(typeof body.text!=='string'||body.text.length>MAX_TEXT)s.Fail('DM_TEXT_INVALID');
 const text=s.Text(body.text,MAX_TEXT);if(!text)s.Fail('DM_TEXT_INVALID');
 if(!Number.isSafeInteger(row.lastSeq+1))s.Fail('DM_FULL');
 const id=s.Id('MSG'),seq=++row.lastSeq,at=Date.now();row.messages.push({id,seq,senderId:p.id,text,at});
 for(const member of row.members)if(member!==p.id)row.received[member]++;
 // Sending a message is not proof that intervening messages have been rendered.
 row.updatedAt=at;row.revision++;return {id:row.id,sentMessageId:id,sentSeq:seq};
}
function Read(p,body={}){
 const row=Writable(p,body.id),throughSeq=PageValue(body.throughSeq,undefined,0,row.lastSeq);
 if(throughSeq===undefined)s.Fail('INPUT_INVALID');if(MarkRead(row,p,throughSeq))row.revision++;
 return {id:row.id};
}
function Delete(p,body={}){
 const row=Row(p,body.id);if(body.confirmed!==true)s.Fail('DM_DELETE_CONFIRM');
 if(!row.deletedAt){
  // Keep only a participant-authorized tombstone: both lists drop the pair,
  // queued writes fail, and an explicit future Open creates a different ID.
  row.deletedAt=Date.now();row.updatedAt=row.deletedAt;row.revision++;row.messages=[];row.lastSeq=0;
  for(const id of row.members){row.readSeq[id]=0;row.received[id]=0;row.readReceived[id]=0;}
 }
 return {id:row.id,deleted:true};
}
function Project(p,action,receipt){
 if(action==='dm.delete')return {...List(p),id:receipt.id,deleted:true};
 const data=Thread(p,{id:receipt.id});
 if(receipt.sentMessageId&&!data.thread.deleted&&!data.thread.unavailable){data.sentMessageId=receipt.sentMessageId;data.sentSeq=receipt.sentSeq;}
 return data;
}
module.exports={List,Thread,Open,Send,Read,Delete,Project,PAGE_SIZE,MAX_TEXT};
