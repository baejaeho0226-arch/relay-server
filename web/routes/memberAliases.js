'use strict';
// Resolve only known CLIENT addressing fields; operation-specific authorization still runs.
function Resolve(pathname,body,url){
 const match=pathname.match(/^\/api\/clients\/((?:@|%40)[^/]+)(\/.*)?$/i);
 const aliasFields=['clientId','targetClientId'].filter(k=>typeof body[k]==='string'&&body[k].startsWith('@'));
 if(!match&&!aliasFields.length)return null;
 const identity=require('../../services/member/identity'),next={...body};
 if(match)pathname='/api/clients/'+identity.ResolveClient(decodeURIComponent(match[1]),url.searchParams.get('deviceId')||'')+(match[2]||'');
 for(const k of aliasFields)next[k]=identity.ResolveClient(body[k],body.deviceId||'');
 return {pathname,body:next};
}
module.exports={Resolve};
