'use strict';
const s=require('./store'),social=require('./social'),extra=require('./socialActions');
// Only destination counts are projected for All menus. No product/feed media,
// ranking, reward history or other dashboard summaries are built on this read.
function Read(p){
 const db=s.DB(),news=social.NewsRows(p),posts=Object.values(db.posts);
 const counts={
  news:news.length,catalog:Object.values(db.products).filter(x=>x.published&&!x.deleted).length,
  feed:posts.filter(x=>extra.Visible(x,p)).length,events:news.filter(x=>x.category==='EVENT').length,
  posts:posts.filter(x=>x.accountId===p.id&&!x.deleted&&!x.hidden).length,
  orders:Object.values(db.orders).filter(x=>x.accountId===p.id&&!x.mergedInto).length,
  payments:Object.values(db.ledger).filter(x=>x.accountId===p.id&&x.kind==='PURCHASE').length
 };
 return {profile:s.PublicProfile(p,true),counts};
}
module.exports={Read};
