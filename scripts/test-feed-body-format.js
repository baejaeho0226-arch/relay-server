'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const format=require('../public/member-body-format');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-body30-'));process.env.DATA_DIR=temp;process.env.DB_AUTOSAVE_MS='0';process.env.STORAGE_ENGINE='json';
const store=require('../services/member/store'),social=require('../services/member/social'),admin=require('../services/member/admin'),actions=require('../services/member/socialActions');
const {JSDOM}=require('jsdom'),vm=require('node:vm');
(async()=>{try{
 // Ranges refer to UTF-16 positions, including emoji, Korean and Windows line endings.
 const value='  한😀글\r\n끝  ',input=[{start:2,length:4,style:1},{start:5,length:4,style:12}];
 const result=format.prepare(value,input);assert.equal(result.body,'한😀글\n끝');assert.deepEqual(format.decode(result.body,result.bodyFormats),Uint8Array.from([1,1,1,13,12,12]));
 for(const bad of [[{start:2,length:1,style:1}],[{start:0,length:999,style:1}],[{start:0,length:1,style:16}],null,[{start:0.5,length:1,style:1}]])assert.throws(()=>format.prepare('한😀글',bad),/INPUT_INVALID/);
 assert.throws(()=>format.prepare('a'.repeat(2001),[]),/INPUT_INVALID/);
 const edited=format.rebase('가나😀다','가나다😀다',[{start:1,length:3,style:3}]);assert.deepEqual([...format.decode('가나다😀다',edited)],[0,3,3,3,3,0]);
 let ranges=[];for(const bit of [1,2,4,8])ranges=format.toggle('가나다',ranges,1,1,bit);assert.deepEqual(ranges,[{start:1,length:1,style:15}]);ranges=format.toggle('가나다',ranges,1,1,1);assert.equal(ranges[0].style,14);
 // Exercise actual storage/public response/admin edit paths inside their transactional guard.
 const db=store.DB();const owner={id:'MEMBER-FMT-A',nickname:'작성자',handle:'fmt_a',bio:'',readNews:{},balance:0},viewer={id:'MEMBER-FMT-B',nickname:'독자',handle:'fmt_b',bio:'',balance:0};db.profiles[owner.id]=owner;db.profiles[viewer.id]=viewer;
 const post=store.Atomic(()=>social.Post(owner,{title:'서식 제목',body:value,bodyFormats:input,poll:{question:'선택',options:['첫 선택','다음 선택']}})).post;
 assert.deepEqual(post.bodyFormats,result.bodyFormats);assert.equal(post.title,'서식 제목');assert.equal(post.poll.total,0);
 const thread=social.Thread(viewer,{postId:post.id});assert.deepEqual(thread.post.bodyFormats,result.bodyFormats);
 actions.Bookmark(viewer,{kind:'post',id:post.id,saved:true});assert.deepEqual(actions.Bookmarks(viewer,{}).items[0].post.bodyFormats,result.bodyFormats);
 const vote=store.Atomic(()=>actions.Vote(viewer,{postId:post.id,optionId:'1',_delta:true})).post;assert.deepEqual(vote.bodyFormats,result.bodyFormats);assert.equal(vote.poll.options[1].votes/vote.poll.total,1);
 const changed=admin.Write('post.save',{id:post.id,revision:0,body:'앞 '+result.body},'admin');assert.equal(changed.bodyFormats[0].start,2);assert.equal(changed.poll.options.length,2);
 const before=JSON.stringify(store.DB().posts[post.id]);assert.throws(()=>admin.Write('post.save',{id:post.id,revision:1,body:'bad',bodyFormats:[{start:8,length:1,style:1}]},'admin'),/INPUT_INVALID/);assert.equal(JSON.stringify(store.DB().posts[post.id]),before);
 const saved=admin.Write('post.save',{id:post.id,revision:1,body:'수정 내용',bodyFormats:[{start:0,length:2,style:15}]},'admin');assert.equal(saved.bodyFormats[0].style,15);
 assert.throws(()=>store.Atomic(()=>social.EditPost(viewer,{id:post.id,revision:2,body:'도용',bodyFormats:[]})),/NOT_OWNER/);
 const database=require('../storage/database');const snapshot=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(snapshot),true);assert.deepEqual(social.Thread(viewer,{postId:post.id}).post.bodyFormats,[{start:0,length:2,style:15}]);
 // Real modal events: selection toggle, typing, escaping and confirm serialization.
 const dom=new JSDOM('<div id="modal"><h2 id="modal-title"></h2><div id="modal-body"></div><button id="modal-confirm"></button><button id="modal-cancel"></button></div>',{runScripts:'outside-only',url:'https://relay.invalid'}),w=dom.window;
 vm.runInContext('const modalTitle=document.querySelector("#modal-title"),modalBody=document.querySelector("#modal-body"),modalConfirm=document.querySelector("#modal-confirm"),modalCancel=document.querySelector("#modal-cancel"),modalEl=document.querySelector("#modal");function esc(s){const e=document.createElement("span");e.textContent=String(s??"");return e.innerHTML.replace(/"/g,"&quot;");}',dom.getInternalVMContext());
 for(const file of ['member-body-format.js','admin-rich-body.js','admin-modal.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../public',file),'utf8'),dom.getInternalVMContext());
 const done=w.openModal({fields:[{name:'body',label:'내용',type:'richtext',value:'안녕 <img src=x onerror=alert(1)>',formats:[]}]});
 const editor=w.document.querySelector('[data-rich-editor]'),area=editor.querySelector('textarea');area.setSelectionRange(0,2);editor.querySelector('[data-rich-style="1"]').click();assert.ok(editor.querySelector('[data-rich-preview] .body-style-1'));assert.equal(editor.querySelector('[data-rich-preview] img'),null);
 area.value='앞 '+area.value;area.dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal(editor.readFormats()[0].start,2);
 w.document.querySelector('#modal-confirm').click();const v=await done;assert.deepEqual(JSON.parse(JSON.stringify(v.bodyFormats)),[{start:2,length:2,style:1}]);dom.window.close();
 console.log('FIX30 body formatting passed: UTF-16/Korean/emoji/newline normalization, overlap/toggle/edit ranges, server/public/admin/rollback/persistence, poll delta and live WebAdmin modal selection/XSS checks.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
