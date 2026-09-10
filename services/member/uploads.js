'use strict';
const protocol=require('./protocol');
// At most one bounded, session-bound profile upload per authenticated connection.
function Accept(c,parts){
 if(parts.length!==7||!['profile.save','post.create','post.edit'].includes(parts[2])||!/^[A-Za-z0-9_-]{8,80}$/.test(parts[1])||!/^\d{1,3}$/.test(parts[3])||!/^\d{1,3}$/.test(parts[4]))return null;
 const [_,id,action,indexText,totalText,chunk,mac]=parts,index=Number(indexText),total=Number(totalText);
 if(total<1||total>384||index>=total||!chunk||chunk.length>12000||!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)||!['HUB_UPLOAD','HUB_ZUPLOAD'].includes(parts[0])||!protocol.Verify(c,[id,action,indexText,totalText,chunk],mac,parts[0]))return null;
 const now=Date.now();let upload=c.hubUpload;
 if(upload&&(now-upload.at>60000||upload.challenge!==c.deviceAuthChallengeId)){c.hubUpload=null;upload=null;}
 if(index===0){upload={id,action,total,prefix:parts[0],challenge:c.deviceAuthChallengeId,at:now,parts:[],length:0};c.hubUpload=upload;}
 if(!upload||upload.id!==id||upload.action!==action||upload.total!==total||upload.prefix!==parts[0])return null;
 if(index<upload.parts.length)return null;
 if(index!==upload.parts.length){c.hubUpload=null;return null;}
 upload.parts.push(chunk);upload.length+=chunk.length;
 if(upload.length>4608000){c.hubUpload=null;return null;}
 if(upload.parts.length!==total)return null;
 c.hubUpload=null;const encoded=upload.parts.join('');if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))return null;
 return {id,action,encoded,compressed:parts[0]==='HUB_ZUPLOAD'};
}
module.exports={Accept};
