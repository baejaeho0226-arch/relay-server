'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Readable } = require('node:stream');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix12-'));
process.env.DATA_DIR = temp; process.env.STORAGE_ENGINE = 'json';
const state = require('../core/state'), { EnsureDirs } = require('../core/utils');
EnsureDirs();
const api = require('../web/webApi'), lifecycle = require('../services/serviceLifecycle');
const licenses = require('../license/licenseManager'), database = require('../storage/database');
const { HandleClientLine } = require('../relay/clientHandler');
const { HandleServerLine } = require('../relay/serverHandler');
function connection(type,id) {
 const c={type,clientId:type==='client'?id:'',serverId:type==='server'?id:'',registered:true,connected:true,
   deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,permissionsGranted:true,
   clients:new Set(),buildClients:new Set(),buildUnlocked:true,lastSeen:Date.now()};
 const lines=[]; c.lines=lines;
 c.socket={destroyed:false,remoteAddress:'127.0.0.1',write(text){lines.push(text.trim());return true;},destroy(){this.destroyed=true;}};
 c.socket.__relayConnection=c;return c;
}
async function request(url,body={},role='admin',method='POST') {
 let status,text;const req=Readable.from([Buffer.from(JSON.stringify(body))]);
 Object.assign(req,{url,method,headers:{},socket:{remoteAddress:'127.0.0.1'}});
 await api.HandleApiRequest(req,{writeHead(n){status=n;},end(v){text=v;}},{role,id:'TEST_ADMIN'});
 assert.ok(status,'Every route must terminate with a response');
 return {status,data:JSON.parse(text)};
}
(async()=>{try{
 const ids=['1111111111111111','2222222222222222','3333333333333333'];
 ids.forEach((id,i)=>state.clientIdentities.set('TEST-'+i,{id,serverId:''}));
 const keys=[licenses.CreateLicense(30,'첫 라이선스').key,licenses.CreateLicense(30,'다음 라이선스').key];
 const before=licenses.FindLicense(keys[0]).expiresAt;
 let r=await request('/api/licenses/bulk',{action:'unknown',keys});assert.equal(r.status,400);assert.equal(r.data.error,'INVALID_ACTION');
 r=await request('/api/licenses/bulk',{action:'extend',keys:[keys[0],keys[0]],days:2});assert.equal(r.data.total,1);assert.equal(licenses.FindLicense(keys[0]).expiresAt,before+2*86400000);
 for(const action of ['extend','suspend','resume','unbind','tags']){
  const body={action,keys,days:1,tags:['우수고객','테스트']};
  r=await request('/api/licenses/bulk',body,'viewer');assert.equal(r.status,403);
  r=await request('/api/licenses/bulk',body,'operator');assert.equal(r.status,200);assert.equal(r.data.success,2);
 }
 assert.deepEqual(licenses.FindLicense(keys[0]).tags,['우수고객','테스트']);
 r=await request('/api/licenses/bulk',{action:'transfer',keys,transfers:keys.map(key=>({key,clientId:ids[0]}))});
 assert.equal(r.status,400);assert.equal(licenses.FindLicense(keys[0]).boundClient,'');
 r=await request('/api/licenses/bulk',{action:'transfer',keys,transfers:keys.map((key,i)=>({key,clientId:ids[i]}))},'operator');
 assert.equal(r.data.success,2);assert.equal(licenses.FindLicense(keys[1]).boundClient,ids[1]);
 for(const action of ['reissue','delete']){r=await request('/api/licenses/bulk',{action,keys},'operator');assert.equal(r.status,403);}
 r=await request('/api/licenses/bulk',{action:'reissue',keys});assert.equal(r.data.success,2);
 const newKeys=r.data.results.map(x=>x.newKey);assert.ok(newKeys.every(Boolean));assert.ok(keys.every(k=>!licenses.FindLicense(k)));
 r=await request('/api/licenses/bulk',{action:'delete',keys:[newKeys[0],keys[0]]});
 assert.equal(r.data.success,1);assert.equal(r.data.failed,1);assert.equal(r.data.results[1].reason,'LICENSE_NOT_FOUND');
 const server=connection('server','AAAAAAAAAAAAAAAA'),client=connection('client',ids[0]);
 client.serverId=server.serverId;server.clients.add(client.clientId);server.buildClients.add(client.clientId);
 state.servers.set(server.serverId,server);state.clients.set(client.clientId,client);
 state.serverIdentities.set('TEST-PC',server.serverId);
 state.buildSessions.set('session',{clientId:client.clientId,serverId:server.serverId});
 state.clientBuildBindings.set(client.clientId,{serverId:server.serverId});
 state.pendingBuildGrants.set(client.clientId,{});state.pendingRequests.set('request',{});
 state.supportThreads.set('thread',{});state.qrAuthRequests.set('qr',{});
 state.clientInstallations.set('anti-reinstall',{authorized:[],blockedAt:1});
 state.releaseCatalog.set('SERVER:STABLE',{version:'2.7.0'});
 state.production.passkeyCredentials.set('existing-admin',{publicKey:'fixture'});
 const stopDenied=await request('/api/system/service/stop',{},'operator');assert.equal(stopDenied.status,403);
 r=await request('/api/system/service/stop');assert.equal(r.status,200);assert.equal(state.serviceEnabled,false);
 for(const name of lifecycle.DEVICE_MAPS)assert.equal(state[name].size,0,name+' must be empty');
 assert.equal(state.clientInstallations.size,1);assert.equal(state.releaseCatalog.size,1);assert.equal(state.production.passkeyCredentials.size,1);
 assert.ok(server.lines.includes('CLIENT_UNAUTHORIZED|'+client.clientId+'|SERVICE_DISABLED'));
 assert.ok(server.lines.includes('SERVICE_STATE|DISABLED'));assert.ok(client.lines.includes('SERVICE_STATE|DISABLED'));
 assert.equal(server.buildUnlocked,false);assert.equal(client.licenseAuthorized,false);
 assert.equal(JSON.parse(fs.readFileSync(require('../config/config').DB_FILE)).serviceEnabled,false);
 const stoppedNewClient=connection('client',''),stoppedNewServer=connection('server','');
 HandleClientLine(stoppedNewClient,'CONNECT|2|2.6.0|TEST-NEW');
 HandleServerLine(stoppedNewServer,'REGISTER|2|2.6.0|TEST-NEW-PC');
 assert.equal(state.clients.size,0);assert.equal(state.servers.size,0);assert.equal(state.clientIdentities.size,0);
 assert.ok(stoppedNewClient.lines.includes('SERVICE_STATE|DISABLED'));assert.ok(stoppedNewServer.lines.includes('SERVICE_STATE|DISABLED'));
 HandleClientLine(client,'LINK_PING|CHECK');assert.ok(client.lines.includes('LINK_PONG|CHECK'));
 // A failed start must remain closed and must not send an ONLINE notification.
 const save=database.SaveDatabase;database.SaveDatabase=()=>false;
 assert.equal(lifecycle.Start().ok,false);assert.equal(state.serviceEnabled,false);assert.ok(!client.lines.includes('SERVICE_STATE|ONLINE'));
 database.SaveDatabase=save;
 r=await request('/api/system/service/start');assert.equal(r.status,200);assert.equal(state.serviceEnabled,true);
 for(const c of [client,server,stoppedNewClient,stoppedNewServer])assert.ok(c.lines.includes('SERVICE_STATE|ONLINE'));
 assert.equal(r.data.resumed,4);assert.equal(state.clients.size,0);
 r=await request('/api/system/service/start');assert.equal(r.data.alreadyStarted,true);
 console.log('FIX12 PASS: all 8 bulk actions, role gates, deduplication, transfer mapping, partial failures, full stop cleanup, retained admin/security/policies, stopped registration gate, heartbeat, immediate restart, save-failure guard');
}finally{fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
