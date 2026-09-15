'use strict';
const crypto=require('node:crypto');
// Authenticate and build the viewer-specific projection before comparing a
// content token. An unrelated global revision must not rebuild the APK page.
// No cached authorization or source rows are reused here.
function Pack(data,viewer,revision,body={}){
 const content={...data,viewer,memberProtocol:35};
 delete content.revision;delete content.contentTag;
 const contentTag=crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
 if(body._ifNoneMatch===contentTag)return {unchanged:true,revision,contentTag,memberProtocol:35};
 return {...content,contentTag,revision};
}
module.exports={Pack};
