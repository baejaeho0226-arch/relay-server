'use strict';
const s=require('./store'),crypto=require('node:crypto'),jpeg=require('jpeg-js');
const MAX_BYTES=2*1024*1024;
function Invalid(){s.Fail('GIF_INVALID');}
function Parse(data){
 const match=/^data:image\/gif;base64,([A-Za-z0-9+/]+={0,2})$/.exec(data||'');
 if(!match||match[1].length>Math.ceil(MAX_BYTES/3)*4)Invalid();
 const b=Buffer.from(match[1],'base64');if(b.length<14||b.length>MAX_BYTES||!['GIF87a','GIF89a'].includes(b.toString('ascii',0,6)))Invalid();
 let at=6;const byte=()=>{if(at>=b.length)Invalid();return b[at++];},word=()=>byte()+256*byte();
 const width=word(),height=word();if(!width||!height||width>1024||height>1024)Invalid();
 const flags=byte(),background=byte();byte();
 const palette=size=>{const bytes=size*3;if(at+bytes>b.length)Invalid();const table=b.subarray(at,at+bytes);at+=bytes;return table;};
 const global=flags&128?palette(1<<((flags&7)+1)):null;
 const blocks=()=>{const chunks=[];let n;while((n=byte())){if(at+n>b.length)Invalid();chunks.push(b.subarray(at,at+n));at+=n;}return Buffer.concat(chunks);};
 const frames=[];let control={delay:100,disposal:0,transparent:-1},pixels=0,ended=false;
 while(at<b.length){
  const type=byte();if(type===0x3b){ended=true;break;}
  if(type===0x21){const label=byte();if(label===0xf9){if(byte()!==4)Invalid();const packed=byte(),delay=word()*10,transparent=byte();if(byte()!==0)Invalid();control={delay:Math.max(20,delay||100),disposal:(packed>>2)&7,transparent:packed&1?transparent:-1};if(control.disposal>3)Invalid();}else blocks();continue;}
  if(type!==0x2c)Invalid();
  const left=word(),top=word(),w=word(),h=word(),packed=byte();if(!w||!h||left+w>width||top+h>height)Invalid();
  const colors=packed&128?palette(1<<((packed&7)+1)):global;if(!colors)Invalid();const min=byte();if(min<2||min>8)Invalid();
  pixels+=w*h;if(pixels>64*1024*1024||frames.length>=180)Invalid();
  frames.push({left,top,w,h,interlaced:!!(packed&64),colors,min,bytes:blocks(),...control});control={delay:100,disposal:0,transparent:-1};
 }
 if(!ended||!frames.length)Invalid();return {b,width,height,background,global,frames};
}
function Decode(frame){
 const clear=1<<frame.min,end=clear+1,prefix=new Uint16Array(4096),suffix=new Uint8Array(4096),stack=new Uint8Array(4097),out=new Uint8Array(frame.w*frame.h);
 for(let i=0;i<clear;i++)suffix[i]=i;
 let bit=0,bits=frame.min+1,next=end+1,old=-1,first=0,pos=0,ended=false;
 const code=()=>{if(bit+bits>frame.bytes.length*8)Invalid();let value=0;for(let i=0;i<bits;i++,bit++)value|=((frame.bytes[bit>>3]>>(bit&7))&1)<<i;return value;};
 for(;;){
  let value=code();if(value===clear){bits=frame.min+1;next=end+1;old=-1;continue;}if(value===end){ended=true;break;}
  const original=value;let count=0;
  if(value===next){if(old<0)Invalid();stack[count++]=first;value=old;}else if(value>next)Invalid();
  while(value>=clear){if(value>=next||count>=4096)Invalid();stack[count++]=suffix[value];value=prefix[value];}
  first=value;stack[count++]=first;
  while(count){if(pos>=out.length)Invalid();out[pos++]=stack[--count];}
  if(old>=0&&next<4096){prefix[next]=old;suffix[next]=first;next++;if(next===(1<<bits)&&bits<12)bits++;}
  old=original;
 }
 if(!ended||pos!==out.length)Invalid();return out;
}
function Thumbnail(canvas,width,height){
 for(const side of [144,112,80,48]){
  const ratio=Math.min(1,side/Math.max(width,height)),w=Math.max(1,Math.round(width*ratio)),h=Math.max(1,Math.round(height*ratio)),rgba=Buffer.alloc(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const from=(Math.min(height-1,Math.floor(y/ratio))*width+Math.min(width-1,Math.floor(x/ratio)))*4,to=(y*w+x)*4;canvas.copy(rgba,to,from,from+4);}
  const encoded=jpeg.encode({width:w,height:h,data:rgba},40).data;
  if(encoded.length<=2400)return 'data:image/jpeg;base64,'+encoded.toString('base64');
 }
 Invalid();
}
function Validate(data){
 const gif=Parse(data),canvas=Buffer.alloc(gif.width*gif.height*4,255),previews=[],intervals=[];
 let previous=null,restore=null;const picks=new Set();for(let i=0;i<Math.min(8,gif.frames.length);i++)picks.add(Math.floor(i*gif.frames.length/Math.min(8,gif.frames.length)));
 for(let index=0;index<gif.frames.length;index++){
  if(previous?.disposal===2){for(let y=previous.top;y<previous.top+previous.h;y++)for(let x=previous.left;x<previous.left+previous.w;x++){const n=(y*gif.width+x)*4;canvas.fill(255,n,n+4);}}
  else if(previous?.disposal===3&&restore)restore.copy(canvas);
  const f=gif.frames[index];restore=f.disposal===3?Buffer.from(canvas):null;
  const decoded=Decode(f),rows=[];if(f.interlaced){for(const [start,step] of [[0,8],[4,8],[2,4],[1,2]])for(let y=start;y<f.h;y+=step)rows.push(y);}else for(let y=0;y<f.h;y++)rows.push(y);
  for(let row=0;row<f.h;row++)for(let x=0;x<f.w;x++){
   const color=decoded[row*f.w+x];if(color===f.transparent)continue;if(color*3+2>=f.colors.length)Invalid();
   const out=((f.top+rows[row])*gif.width+f.left+x)*4;canvas[out]=f.colors[color*3];canvas[out+1]=f.colors[color*3+1];canvas[out+2]=f.colors[color*3+2];canvas[out+3]=255;
  }
  if(picks.has(index)){previews.push(Thumbnail(canvas,gif.width,gif.height));intervals.push(0);}
  intervals[intervals.length-1]+=f.delay;previous=f;
 }
 return {id:'upload-'+crypto.createHash('sha256').update(gif.b).digest('hex').slice(0,24),data:'data:image/gif;base64,'+gif.b.toString('base64'),width:gif.width,height:gif.height,frames:previews,intervals};
}
function Fields(body,previous={}){
 if(body.gifData!==undefined&&body.gifData!==''){if(typeof body.gifData!=='string')Invalid();const gifMedia=Validate(body.gifData);return {gifId:gifMedia.id,gifMedia};}
 if(body.gifId===previous.gifId&&previous.gifMedia)return {gifId:previous.gifId,gifMedia:previous.gifMedia};
 if(body.gifId===undefined&&body.gifData===undefined)return {gifId:previous.gifId||'',gifMedia:previous.gifMedia||null};
 return {gifId:require('./gifs').Validate(body.gifId),gifMedia:null};
}
function Public(post,original=false){
 if(!post.gifMedia)return require('./gifs').Get(post.gifId);
 const {id,width,height,frames,intervals,data}=post.gifMedia;return original?{id,width,height,data}:{id,width,height,frames,intervals};
}
module.exports={Validate,Fields,Public,Parse,Decode};
