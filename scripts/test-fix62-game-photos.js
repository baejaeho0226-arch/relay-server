'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{PNG}=require('pngjs'),jpeg=require('jpeg-js');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix62-game-photos-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const s=require('../services/member/store'),commerce=require('../services/member/commerce'),media=require('../services/member/media'),admin=require('../services/member/admin'),database=require('../storage/database');
function photo(){
 const png=new PNG({width:1200,height:600});
 for(let y=0;y<png.height;y++)for(let x=0;x<png.width;x++){const n=(y*png.width+x)*4;png.data[n]=x>=300&&x<900?240:10;png.data[n+1]=25;png.data[n+2]=x>=300&&x<900?30:240;png.data[n+3]=255;}
 return 'data:image/png;base64,'+PNG.sync.write(png).toString('base64');
}
const decoded=value=>jpeg.decode(Buffer.from(value.split(',')[1],'base64'),{useTArray:true});
function calls(fn){const original=media.GameCover;let count=0;media.GameCover=(...args)=>{count++;return original(...args);};try{return {value:fn(),count};}finally{media.GameCover=original;}}
try{
 const image=photo(),created=commerce.SaveProduct({title:'사진과 장르',description:'게임 소개',genre:'액션 / 어드벤처',image,accessType:'TYPE1',published:true,plans:[{days:1,price:100}]}),row=s.DB().products[created.id];
 const cover=decoded(row.imageCover),full=decoded(row.image),thumb=decoded(row.imageThumb);
 assert.deepEqual([cover.width,cover.height],[384,384],'4x density square card keeps 384 real pixels');
 assert.deepEqual([full.width,full.height],[960,480],'detail image keeps original aspect ratio');
 assert.deepEqual([thumb.width,thumb.height],[160,160]);
 assert.ok(Buffer.from(row.imageCover.split(',')[1],'base64').length<=28000,'per-row wire size remains bounded');
 for(const [x,y] of [[0,0],[192,192],[383,383]]){const n=(y*384+x)*4;assert.ok(cover.data[n]>200&&cover.data[n+2]<60,'center crop has no compressed blue side panels');}
 assert.equal(created.image,undefined,'ordinary save/list result contains a small cover only');
 assert.equal(commerce.Product({id:created.id}).product.image,row.image);
 assert.equal(admin.Read({view:'products',id:created.id}).items[0].image,row.image);
 const original=structuredClone(row);commerce.SaveProduct({id:row.id,revision:row.revision,title:'제목만 수정',genre:row.genre,accessType:row.accessType,published:true});
 for(const key of ['image','imageThumb','imageCover'])assert.equal(s.DB().products[row.id][key],original[key],'omitted upload never loses quality');
 const before=JSON.stringify(s.DB());for(const value of ['https://remote.invalid/image.png','data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,AAAA',{},42,null])assert.throws(()=>commerce.SaveProduct({id:row.id,title:'실패',genre:row.genre,accessType:row.accessType,image:value}),/CONTENT_IMAGE_INVALID/);
 assert.equal(JSON.stringify(s.DB()),before,'invalid photo never partially edits a game');
 const persist=database.SaveDatabase;try{database.SaveDatabase=()=>false;assert.throws(()=>commerce.SaveProduct({id:row.id,title:'저장 실패',genre:row.genre,accessType:row.accessType,image:''}),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=persist;}
 assert.equal(JSON.stringify(s.DB()),before);
 // Old products have a full photo but no new cover. Reading is a lazy projection,
 // retains retired details privately, and does not write or migrate on a poll.
 for(let i=0;i<30;i++)s.DB().products['LEGACY'+i]={id:'LEGACY'+i,title:'이전 게임 '+i,description:'안내',genre:'퍼즐',image,details:{private:'hidden'},accessType:'TYPE1',plans:[{days:1,price:100}],published:true,sort:0,revision:1,updatedAt:Date.now()+i};
 const legacyBefore=JSON.stringify(s.DB()),catalog=calls(()=>commerce.Catalog({limit:2})),adminPage=calls(()=>admin.Read({view:'products',limit:2}));
 assert.equal(catalog.count,2);assert.equal(adminPage.count,2,'admin cover projection is limited to the returned page');
 for(const item of [...catalog.value.items,...adminPage.value.items]){assert.equal(item.image,undefined);assert.equal(item.details,undefined);assert.ok(item.imageCover.startsWith('data:image/jpeg;'));}
 assert.equal(JSON.stringify(s.DB()),legacyBefore,'legacy reads never save the database');
 const profile={id:'USR-PHOTO',recentHistory:{products:[{id:created.id,at:Date.now()}],services:[]}};
 assert.equal(require('../services/member/history').Read(profile).recentProducts[0].imageCover,original.imageCover);
 assert.equal(media.GameCover({image:'javascript:alert(1)'}),'');assert.equal(media.GameCover({image:'data:image/png;base64,AAAA'}),'');
 // Explicit removal clears all active photo sources; hidden old previews cannot
 // unexpectedly reappear after a subsequent title-only edit.
 s.DB().products[created.id].imagePreview=image;
 commerce.SaveProduct({id:created.id,title:'사진 삭제',genre:'액션',accessType:'TYPE1',image:'',published:true});
 const removed=s.DB().products[created.id];assert.equal(removed.image,'');assert.equal(removed.imageThumb,'');assert.equal(media.GameCover(removed),'');assert.equal(removed.imagePreview,image);
 const snapshot=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(snapshot),true);assert.equal(commerce.PublicGame(s.DB().products[created.id]).imageCover,'');assert.ok(commerce.PublicGame(s.DB().products.LEGACY0).imageCover);
 const native=fs.readFileSync(path.join(__dirname,'../../MoaPlayApp_Android64/MoaPlayApp.Member.NewsShop.inc'),'utf8'),gameCard=native.slice(native.indexOf('function TMoaPlayForm.HubFillGameCard'),native.indexOf('procedure TMoaPlayForm.HubRenderNews'));
 assert.match(gameCard,/HubGamePhoto\(C,Item/);assert.doesNotMatch(gameCard,/HubContentIcon/);assert.match(gameCard,/C\.OnClick:=HubActionClick/);assert.match(gameCard,/TextSettings\.WordWrap:=True/);
 const web=fs.readFileSync(path.join(__dirname,'../public/admin-pages-member.js'),'utf8');assert.match(web,/member-game-photo/);assert.match(web,/member-game-genre/);assert.doesNotMatch(web,/member-game-icon/);
 console.log('FIX62 GAME PHOTOS PASS: validated square covers, original aspect ratio, 4x pixel density, bounded page-only projection, legacy preservation, upload/remove/rollback/import, native whole-card navigation and Web photo/genre layout');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
