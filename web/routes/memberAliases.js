'use strict';
// Resolve registered client addresses before HA/operation/dual-approval gates.
// Account names never substitute for the QR scan token or device authentication.
const CLIENT_PATH=/^(\/api\/(?:clients|request-recovery\/clients|failover\/clients|control\/client|build-bindings)\/)((?:@|%40)[^/]+)(\/.*)?$/i;
const SUPPORT_PATH=/^(\/api\/support\/)((?:@|%40)[^/]+)(\/.*)?$/i;
const typedPaths=new Set(['/api/releases/device-channel','/api/control/features/device','/api/control/security/challenge','/api/control/security/reset','/api/control/security/rotate','/api/production/diagnostics']);
const alias=v=>typeof v==='string'&&v.startsWith('@');
function PathMatch(path,pattern){return path.match(pattern);}
function NeedsResolution(path,body){return !!PathMatch(path,CLIENT_PATH)||!!PathMatch(path,SUPPORT_PATH)||['clientId','targetClientId'].some(k=>alias(body[k]))||(typedPaths.has(path)&&String(body.type).toUpperCase()==='CLIENT'&&alias(body.id));}
function Resolve(pathname,body,url){
 if(!NeedsResolution(pathname,body))return null;
 const identity=require('../../services/member/identity'),next={...body},selection=String(body.deviceId||url.searchParams.get('deviceId')||'').toUpperCase();
 const match=PathMatch(pathname,CLIENT_PATH),support=PathMatch(pathname,SUPPORT_PATH);
 if(match)pathname=match[1]+identity.ResolveClient(decodeURIComponent(match[2]),selection)+(match[3]||'');
 if(support)pathname=support[1]+identity.ResolveSupport(decodeURIComponent(support[2]),selection)+(support[3]||'');
 for(const k of ['clientId','targetClientId'])if(alias(body[k]))next[k]=identity.ResolveClient(body[k],selection);
 if(typedPaths.has(pathname)&&String(body.type).toUpperCase()==='CLIENT'&&alias(body.id))next.id=identity.ResolveClient(body.id,selection);
 return {pathname,body:next};
}
module.exports={NeedsResolution,Resolve};
