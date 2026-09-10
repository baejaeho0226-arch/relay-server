'use strict';
const zlib=require('node:zlib');
function Decode(encoded,compressed){const bytes=Buffer.from(encoded,'base64');return (compressed?zlib.inflateSync(bytes,{maxOutputLength:6000000}):bytes).toString('utf8');}
function Encode(value,allow){const plain=Buffer.from(JSON.stringify(value));if(plain.length>8000000)throw Error('RESPONSE_LIMIT');if(allow&&plain.length>16000){const packed=zlib.deflateSync(plain,{level:1});if(packed.length<plain.length*.95)return {encoded:packed.toString('base64'),prefix:'HUB_ZCHUNK',signature:'HUB_ZRESPONSE'};}return {encoded:plain.toString('base64'),prefix:'HUB_CHUNK',signature:'HUB_RESPONSE'};}
function Compact(result,action){
 if(!['react','repost.set','poll.vote','comment.react'].includes(action))return result;
 if(result.post){const keys=['id','revision','myReaction','likes','comments','reposts','myRepost','poll','repostedBy','bookmarked','views'];return {post:Object.fromEntries(keys.map(k=>[k,result.post[k]])),partial:true};}
 if(result.comment){const keys=['id','postId','revision','likes','myReaction'];return {comment:Object.fromEntries(keys.map(k=>[k,result.comment[k]])),partial:true};}
 return result;
}
module.exports={Decode,Encode,Compact};
