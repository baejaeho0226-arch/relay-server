'use strict';
const s=require('./store'),jpeg=require('jpeg-js'),{PNG}=require('pngjs');
function Decode(value){
 const m=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value||'');
 if(!m||m[2].length>300000)s.Fail('CONTENT_IMAGE_INVALID');
 const b=Buffer.from(m[2],'base64');let image;
 try{
  if(m[1]==='png'){
   if(b.length<24||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||b.readUInt32BE(16)>1024||b.readUInt32BE(20)>1024)throw Error('size');
   image=PNG.sync.read(b,{checkCRC:true});
  }else image=jpeg.decode(b,{useTArray:true,maxResolutionInMP:1.1,maxMemoryUsageInMB:64});
  if(!image.width||!image.height||image.width>1024||image.height>1024)throw Error('size');
 }catch(_){s.Fail('CONTENT_IMAGE_INVALID');}
 return image;
}
function Resize(image,edge){
 const ratio=Math.min(1,edge/Math.max(image.width,image.height)),width=Math.max(1,Math.round(image.width*ratio)),height=Math.max(1,Math.round(image.height*ratio)),data=Buffer.alloc(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const sx=Math.min(image.width-1,Math.floor(x/ratio)),sy=Math.min(image.height-1,Math.floor(y/ratio)),i=(sy*image.width+sx)*4,o=(y*width+x)*4,a=image.data[i+3]/255;
  for(let c=0;c<3;c++)data[o+c]=Math.round(image.data[i+c]*a+255*(1-a));data[o+3]=255;
 }
 return {width,height,data};
}
function Encoded(image,edge,max){
 // Bound each wire image; detailed/noisy photos shrink instead of failing late.
 for(let pass=0;pass<6;pass++){
  const resized=Resize(image,Math.max(96,Math.floor(edge*Math.pow(0.8,pass))));
  for(let quality=84;quality>=36;quality-=12){const b=jpeg.encode(resized,quality).data;if(b.length<=max)return 'data:image/jpeg;base64,'+b.toString('base64');}
 }
 s.Fail('CONTENT_IMAGE_INVALID');
}
function Fields(value,previous={}){
 if(value===undefined)return {image:previous.image||'',imageThumb:previous.imageThumb||''};
 if(value==='')return {image:'',imageThumb:''};
 if(typeof value!=='string')s.Fail('CONTENT_IMAGE_INVALID');
 const image=Decode(value);return {image:Encoded(image,960,180000),imageThumb:Encoded(image,160,12000)};
}
function PostFields(value,previous={}){
 if(value===undefined)return {image:previous.image||'',imageFeed:previous.imageFeed||'',imageThumb:previous.imageThumb||''};
 if(value==='')return {image:'',imageFeed:'',imageThumb:''};
 if(typeof value!=='string')s.Fail('CONTENT_IMAGE_INVALID');const image=Decode(value);return {image:Encoded(image,960,180000),imageFeed:Encoded(image,480,35000),imageThumb:Encoded(image,160,12000)};
}
function Url(value){const text=s.Text(value,350);if(!text)return '';let url;try{url=new URL(text);}catch(_){s.Fail('CONTENT_URL_INVALID');}if(!['https:','http:'].includes(url.protocol)||url.username||url.password)s.Fail('CONTENT_URL_INVALID');return url.href;}
function GameDetails(value,previous={}){
 if(value===undefined)return structuredClone(previous||{});
 if(!value||typeof value!=='object'||Array.isArray(value))s.Fail('INPUT_INVALID');
 const result={};for(const key of ['releaseDate','developer','publisher','genre','ageRating','language','platform'])result[key]=s.Text(value[key],120);
 result.channels={};for(const key of ['official','instagram','twitter','facebook','youtube'])result.channels[key]=Url(value.channels?.[key]);

 return result;
}
module.exports={Fields,PostFields,GameDetails};
