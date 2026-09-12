'use strict';
const s=require('./store'),extra=require('./socialActions');
function CommentRows(p){return Object.values(s.DB().comments).filter(x=>x.accountId===p.id&&!x.deleted&&!x.hidden&&extra.Visible(s.DB().posts[x.postId],p)).sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));}
function Comments(p,body={}){
 const rows=s.Page(CommentRows(p),body,12);
 return {...rows,items:rows.items.map(x=>({...extra.PublicComment(x,p),postTitle:s.DB().posts[x.postId].title||s.DB().posts[x.postId].body.slice(0,60)||'사진 · 투표 게시글'}))};
}
module.exports={CommentRows,Comments};
