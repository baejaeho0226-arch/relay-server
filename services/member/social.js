'use strict';
const s=require('./store'),extra=require('./socialActions');
function Avatar(value){
 if(!value)return '';
 const m=/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value));if(!m||m[1].length>360000)s.Fail('AVATAR_INVALID');
 const b=Buffer.from(m[1],'base64');if(b.length<24||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')s.Fail('AVATAR_INVALID');
 const w=b.readUInt32BE(16),h=b.readUInt32BE(20);if(w<1||h<1||w>256||h>256)s.Fail('AVATAR_INVALID');
 try{const {PNG}=require('pngjs');const png=PNG.sync.read(b);const normalized=PNG.sync.write(png).toString('base64');if(normalized.length>360000)s.Fail('AVATAR_INVALID');return 'data:image/png;base64,'+normalized;}catch(_){s.Fail('AVATAR_INVALID');}
}
function AvatarThumb(value){
 if(!value)return '';
 const png=require('pngjs').PNG.sync.read(Buffer.from(value.split(',')[1],'base64'));
 const width=Math.min(128,png.width),height=Math.min(128,png.height),data=Buffer.alloc(width*height*4);
 // Area resampling preserves detail; flatten transparency on a neutral surface.
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const sum=[0,0,0];let count=0;
  for(let sy=Math.floor(y*png.height/height);sy<Math.ceil((y+1)*png.height/height);sy++)for(let sx=Math.floor(x*png.width/width);sx<Math.ceil((x+1)*png.width/width);sx++){
   const i=(sy*png.width+sx)*4,a=png.data[i+3]/255;for(let c=0;c<3;c++)sum[c]+=png.data[i+c]*a+255*(1-a);count++;
  }
  const out=(y*width+x)*4;for(let c=0;c<3;c++)data[out+c]=Math.round(sum[c]/count);data[out+3]=255;
 }
 for(let quality=82;quality>=22;quality-=12){const encoded=require('jpeg-js').encode({width,height,data},quality).data;if(encoded.length<=12000)return 'data:image/jpeg;base64,'+encoded.toString('base64');}
 return '';
}
function SaveProfile(p,body){const revision=Math.max(p.profileRevision||0,p.avatarRevision||0)+1;const nickname=s.Text(body.nickname,24,true),now=Date.now();if(nickname!==p.nickname){if(p.nicknameChangedAt&&now<p.nicknameChangedAt+30*86400000)s.Fail('NICKNAME_COOLDOWN');p.nickname=nickname;p.nicknameChangedAt=now;}if(body.handle!==undefined){const handle=s.NormalizeHandle(body.handle);if(handle!==s.Handle(p)){if(p.handleChangedAt)s.Fail('HANDLE_LOCKED');if(s.Resolve(handle))s.Fail('HANDLE_TAKEN');p.handle=handle;p.handleChangedAt=now;}}p.bio=s.Text(body.bio,160);if(body.avatar!==undefined){p.avatar=Avatar(body.avatar);p.avatarThumb=AvatarThumb(p.avatar);p.avatarRevision++;}p.profileRevision=revision;return {profile:s.PublicProfile(p,true),publicProfile:s.PublicProfile(p)};}
function Author(id){const p=s.ProfileById(id);return p?s.PublicProfile(p):{id,nickname:'탈퇴 회원',avatar:''};}
function News(p,body={}){
 const rows=Object.values(s.DB().news).filter(x=>!x.deleted&&x.published&&(!x.publishAt||x.publishAt<=Date.now())&&(!x.audience||x.audience===p.id)&&(!body.category||x.category===body.category))
  .sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.at-a.at);
 return s.Page(rows.map(x=>({
  ...Object.fromEntries(Object.entries(x).filter(([k])=>k!=='image'&&(!body.summary||k!=='body'))),
  views:s.ViewCount('news',x.id),
  unread:(p.readNews?.[x.id]||((p.readNewsAt||0)>=x.at?(x.revision||1):0))<(x.revision||1)
 })),body);
}
function Article(p,body){
 const row=s.DB().news[body.id];
 if(!row||row.deleted||!row.published||(row.publishAt&&row.publishAt>Date.now())||(row.audience&&row.audience!==p.id))s.Fail('NEWS_NOT_FOUND');
 const revision=row.revision||1;
 if((p.readNews?.[row.id]||0)<revision)s.Atomic(()=>{p.readNews={...(p.readNews||{}),[row.id]:revision};});
 require('./views').Article(p,row);return {article:{...row,views:s.ViewCount('news',row.id),unread:false}};
}
function EditPost(p,body){
 const post=extra.Post(p,body.id);if(post.accountId!==p.id)s.Fail('NOT_OWNER');
 if(body.revision!==(post.revision||0))s.Fail('CONTENT_CHANGED');
 post.title=s.Text(body.title===undefined?post.title:body.title,90);post.poll=extra.PollInput(body.poll,post.poll,post.id);Object.assign(post,require('./gifMedia').Fields(body,post));post.body=s.Text(body.body,2000);Object.assign(post,require('./media').PostFields(body.image,post));post.imagePosition=require('./media').PostPosition(body.imagePosition,post);if(!post.title&&!post.body&&!post.image&&!post.gifId&&!post.poll)s.Fail('INPUT_INVALID');post.updatedAt=Date.now();post.revision=(post.revision||0)+1;
 return {post:PublicPost(post,p,false,body._wire==='zlib')};
}
function NewsAudience(value){const text=s.Text(value,40);if(!text.startsWith('@'))return text;const member=s.Resolve(text);if(!member)s.Fail('MEMBER_NOT_FOUND');return member.id;}
function SaveNews(body){const id=body.id||s.Id('NEWS');if(body.id&&!s.DB().news[id])s.Fail('NEWS_NOT_FOUND');const previous=s.DB().news[id];if(previous&&body.revision!==undefined&&body.revision!==(previous.revision||0))s.Fail('CONTENT_CHANGED');const category=s.Text(body.category,20);if(!['UPDATE','NOTICE','EVENT','ALERT'].includes(category))s.Fail('CATEGORY_INVALID');const row={...require('./media').Fields(body.image,previous),id,deleted:previous?.deleted||false,revision:(previous?.revision||0)+1,title:s.Text(body.title,90,true),body:s.Text(body.body,5000,true),category,published:body.published===true,pinned:body.pinned===true,audience:NewsAudience(body.audience),at:Date.now(),publishAt:0};return s.Atomic(()=>{s.DB().news[id]=row;return row;});}
function VisiblePost(id){const post=s.DB().posts[id];if(!post||post.deleted||post.hidden)s.Fail('POST_NOT_FOUND');return post;}
function PublicPost(post,p,detail=false,sharp=false,compact=false){const reactions=Object.values(s.DB().reactions).filter(x=>x.postId===post.id);return {id:post.id,title:post.title||'',body:post.body,poll:extra.Poll(post,p),gif:compact?undefined:require('./gifMedia').Public(post,false,sharp),bookmarked:extra.Bookmarked(p,'post',post.id),...extra.RepostInfo(post,p),imagePosition:post.imagePosition==='before'?'before':'after',image:compact?undefined:detail?(post.image||''):(sharp?require('./media').FeedImage(post):require('./media').LegacyFeedImage(post)),at:post.at,updatedAt:post.updatedAt||post.at,revision:post.revision||0,views:s.ViewCount('post',post.id),author:compact?undefined:Author(post.accountId),own:post.accountId===p.id,following:require('./follows').IsFollowing(p.id,post.accountId),likes:reactions.filter(x=>x.value===1).length,myReaction:reactions.find(x=>x.accountId===p.id)?.value===1?1:0,comments:Object.values(s.DB().comments).filter(x=>x.postId===post.id&&!x.deleted&&!x.hidden&&!extra.Blocked(p.id,x.accountId)&&!s.ProfileById(x.accountId)?.blocked).length};}
function Feed(p,body){
 const latest=new Map();for(const row of Object.values(s.DB().reposts))if(!extra.Blocked(p.id,row.accountId)&&!s.ProfileById(row.accountId)?.blocked)latest.set(row.postId,Math.max(latest.get(row.postId)||0,row.at));
 const rows=Object.values(s.DB().posts).filter(x=>extra.Visible(x,p)&&(!body.mine||x.accountId===p.id)&&(!body.following||require('./follows').IsFollowing(p.id,x.accountId)));
 rows.sort((a,b)=>Math.max(b.at,latest.get(b.id)||0)-Math.max(a.at,latest.get(a.id)||0)||b.id.localeCompare(a.id));
 const page=s.Page(rows,body,8);require('./views').Impressions(p,page.items);return {...page,items:page.items.map(x=>PublicPost(x,p,false,body._wire==='zlib'))};
}
function Thread(p,body){
 const post=extra.Post(p,body.postId);
 const visible=Object.values(s.DB().comments).filter(x=>x.postId===post.id&&!x.deleted&&!x.hidden&&!extra.Blocked(p.id,x.accountId)&&!s.ProfileById(x.accountId)?.blocked);
 // Group by the original parent before paging: late replies stay beside their conversation.
 const rootId=x=>x.parentId||x.id,rootTime=x=>s.DB().comments[rootId(x)]?.at||x.at;
 visible.sort((a,b)=>rootTime(a)-rootTime(b)||rootId(a).localeCompare(rootId(b))||Number(!!a.parentId)-Number(!!b.parentId)||a.at-b.at||a.id.localeCompare(b.id));
 const comments=s.Page(visible,body,12);
 require('./views').Impressions(p,[post]);
 return {post:PublicPost(post,p,true,body._wire==='zlib'),comments:{...comments,items:comments.items.map(x=>extra.PublicComment(x,p))}};
}
function Rate(p,kind,ms){const at=Date.now(),key='last_'+kind;if(at-(p[key]||0)<ms)s.Fail('PLEASE_WAIT');p[key]=at;}
function Post(p,body){Rate(p,'post',10000);const id=s.Id('POST'),post={id,accountId:p.id,title:s.Text(body.title,90),poll:extra.PollInput(body.poll),...require('./gifMedia').Fields(body),body:s.Text(body.body,2000),...require('./media').PostFields(body.image),imagePosition:require('./media').PostPosition(body.imagePosition),at:Date.now(),deleted:false,hidden:false};if(!post.title&&!post.body&&!post.image&&!post.gifId&&!post.poll)s.Fail('INPUT_INVALID');s.DB().posts[id]=post;return {post:PublicPost(post,p,false,body._wire==='zlib')};}
function Comment(p,body){const post=extra.Post(p,body.postId);Rate(p,'comment',1500);const parent=body.parentId?extra.Comment(p,body.parentId):null;if(parent&&parent.postId!==post.id)s.Fail('INPUT_INVALID');const id=s.Id('COM'),comment={id,postId:post.id,parentId:parent?(parent.parentId||parent.id):'',replyTo:parent?.accountId||'',revision:0,accountId:p.id,body:s.Text(body.body,600,true),at:Date.now(),deleted:false,hidden:false};s.DB().comments[id]=comment;return {comment:extra.PublicComment(comment,p)};}
function Remove(p,body,table){const item=s.DB()[table][body.id];if(!item||item.accountId!==p.id)s.Fail('NOT_OWNER');item.deleted=true;item.deletedByMember=true;item.body='';if(table==='posts'){item.image='';item.imageFeed='';item.imageThumb='';item.gifMedia=null;item.gifId='';item.poll=null;}return {removed:true,id:item.id,kind:table==='posts'?'post':'comment',postId:table==='posts'?item.id:item.postId};}
function React(p,body){const post=extra.Post(p,body.postId);const value=Number(body.value);if(![0,1].includes(value))s.Fail('REACTION_INVALID');const key=p.id+':'+post.id;if(value===0)delete s.DB().reactions[key];else s.DB().reactions[key]={postId:post.id,accountId:p.id,value};return {post:PublicPost(post,p,false,body._wire==='zlib',body._delta===true)};}
function Report(p,body){return extra.Report(p,body);}
module.exports={AvatarThumb,Article,EditPost,Avatar,SaveProfile,News,SaveNews,Feed,Thread,Post,Comment,Remove,React,Report,PublicPost,Author};
