/* Shared native-wire/WebAdmin body format model. UTF-16 ranges; no HTML input. */
(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory();else root.MemberBodyFormat=factory();})(typeof globalThis==='object'?globalThis:this,function(){
'use strict';
const LIMIT=2000;
function invalid(){throw Error('INPUT_INVALID');}
function boundary(text,i){return i===0||i===text.length||!(text.charCodeAt(i-1)>=0xd800&&text.charCodeAt(i-1)<=0xdbff&&text.charCodeAt(i)>=0xdc00&&text.charCodeAt(i)<=0xdfff);}
function decode(text,ranges=[]){
 if(!Array.isArray(ranges)||ranges.length>LIMIT)invalid();const styles=new Uint8Array(text.length);
 for(const r of ranges){if(!r||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.length)||!Number.isSafeInteger(r.style)||r.start<0||r.length<1||r.start+r.length>text.length||r.style<1||r.style>15||!boundary(text,r.start)||!boundary(text,r.start+r.length))invalid();for(let i=r.start;i<r.start+r.length;i++)styles[i]|=r.style;}
 return styles;
}
function encode(styles){const ranges=[];for(let i=0;i<styles.length;){let end=i+1;while(end<styles.length&&styles[end]===styles[i])end++;if(styles[i])ranges.push({start:i,length:end-i,style:styles[i]});i=end;}return ranges;}
function rebase(before,after,ranges){
 const old=decode(before,ranges),next=new Uint8Array(after.length);let a=0,b=0;
 while(a<before.length&&a<after.length&&before[a]===after[a])a++;
 while(a>0&&(!boundary(before,a)||!boundary(after,a)))a--;
 while(b<before.length-a&&b<after.length-a&&before[before.length-b-1]===after[after.length-b-1])b++;
 while(b>0&&(!boundary(before,before.length-b)||!boundary(after,after.length-b)))b--;
 next.set(old.subarray(0,a));const inherit=before.length-b>a?old[a]:(a?old[a-1]:0);next.fill(inherit,a,after.length-b);next.set(old.subarray(before.length-b),after.length-b);return encode(next);
}
function toggle(text,ranges,start,length,style){
 if(![1,2,4,8].includes(style)||!Number.isSafeInteger(start)||!Number.isSafeInteger(length)||start<0||length<1||start+length>text.length)invalid();
 let end=start+length;if(!boundary(text,start))start--;if(!boundary(text,end))end++;
 const values=decode(text,ranges),remove=values.subarray(start,end).every(x=>(x&style)!==0);
 for(let i=start;i<end;i++)values[i]=remove?values[i]&(15^style):values[i]|style;return encode(values);
}
function prepare(value,ranges,previous){
 const raw=String(value??'');if(raw.length>10000)invalid();
 if(ranges===undefined)ranges=previous?rebase(String(previous.body||''),raw,previous.bodyFormats||[]):[];
 const source=decode(raw,ranges);let text='',styles=[];
 for(let i=0;i<raw.length;i++){
  const c=raw[i],n=raw.charCodeAt(i);if(n<=8||n===11||n===12||(n>=14&&n<=31))continue;
  if(c==='\r'){text+='\n';styles.push(source[i]);if(raw[i+1]==='\n')i++;}else {text+=c;styles.push(source[i]);}
 }
 const start=text.length-text.trimStart().length,end=text.trimEnd().length;
 text=text.slice(start,Math.max(start,end));styles=styles.slice(start,Math.max(start,end));if(text.length>LIMIT)invalid();
 return {body:text,bodyFormats:encode(styles)};
}
function segments(text,ranges){const mask=decode(text,ranges||[]),out=[];for(let i=0;i<text.length;){let j=i+1;while(j<text.length&&mask[j]===mask[i])j++;out.push({text:text.slice(i,j),style:mask[i]});i=j;}return out;}
return {LIMIT,boundary,decode,encode,rebase,toggle,prepare,segments};
});
