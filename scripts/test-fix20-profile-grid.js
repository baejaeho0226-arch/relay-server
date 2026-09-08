'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix20-profile-'));process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service');let seq=0;
const run=(c,action,body={})=>hub.Execute(c,'PROFILE20_'+(++seq),action,body);
function client(id){const c={clientId:id,type:'client',connected:true,permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'GRID-'+id,socket:{destroyed:false,write(){return true;}}};state.clients.set(id,c);state.clientIdentities.set('GRID20-'+id,{id,serverId:''});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));return c;}
try{
 const a=client('A000000000000020'),b=client('B000000000000020');assert.equal(run(a,'me').profile.posts,0);assert.deepEqual(run(a,'me').posts.items,[]);
 const ids=[];for(let i=0;i<16;i++){s.Account(a).last_post=0;ids.push(run(a,'post.create',{body:'본문 '+i+' 가나다'.repeat(90)}).post.id);}
 const other=run(b,'post.create',{body:'다른 회원의 글'}).post;
 run(a,'post.delete',{id:ids[0]});s.DB().posts[ids[1]].hidden=true;
 const me=run(a,'me');assert.equal(me.profile.posts,14);assert.equal(me.posts.total,14);assert.equal(me.posts.items.length,12);assert.equal(me.posts.nextOffset,12);
 const next=run(a,'me',{offset:12,limit:12});assert.equal(next.posts.items.length,2);assert.equal(next.posts.nextOffset,null);assert.equal(new Set([...me.posts.items,...next.posts.items].map(x=>x.id)).size,14);
 for(const row of [...me.posts.items,...next.posts.items]){assert.notEqual(row.id,other.id);assert.ok(![ids[0],ids[1]].includes(row.id));assert.ok(row.body.length<=140);assert.equal(row.author,undefined);assert.equal(row.avatar,undefined);assert.equal(row.views,undefined);}
 const viewed=run(b,'feed').items.find(x=>x.author.id===me.profile.id);assert.equal(viewed.author.posts,14);assert.equal(viewed.author.balance,undefined);
 run(b,'follow.set',{id:me.profile.id,following:true});assert.equal(run(a,'me').profile.followers,1);assert.equal(run(b,'me').profile.following,1);
 assert.equal(run(b,'follows',{mode:'following'}).items[0].posts,14);
 const post=me.posts.items[0],thread=run(a,'thread',{postId:post.id});assert.ok(thread.post.body.length>140,'grid preview opens the full post');assert.equal(thread.post.own,true);
 assert.ok('orders' in me && 'payments' in me,'history remains accessible through Menu');
 console.log('FIX20 PROFILE GRID PASS: real visible-post totals, hidden/deleted/other-member exclusion, pagination, bounded previews, full post detail and follower counts');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
