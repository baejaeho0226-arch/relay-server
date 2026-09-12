'use strict';
const assert = require('node:assert/strict');
const net = require('node:net'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fix12-tcp-'));
process.env.DATA_DIR = temp; process.env.STORAGE_ENGINE = 'json';
const state = require('../core/state'), database = require('../storage/database');
const installation = require('../services/clientInstallation');
const lifecycle = require('../services/serviceLifecycle');
require('../core/utils').EnsureDirs();
const acceptedClosed = [];
const server = net.createServer(socket => {
 acceptedClosed.push(new Promise(resolve => socket.once('close',resolve)));
 require('../core/connection').CreateConnection(socket);
});
const sockets = [];
const key = 'ANDROID2-1234567890ABCDEF-1234567890ABCDEF', token = 'A'.repeat(32);
function connect(port) {
 return new Promise((resolve,reject)=>{
  const socket = net.createConnection({port,host:'127.0.0.1'}); sockets.push(socket);
  const lines=[], waiters=[]; let buffer='';
  const peer={socket,lines,send:line=>socket.write(line+'\n'),wait(prefix){
   const i=lines.findIndex(x=>x.startsWith(prefix)); if(i>=0)return Promise.resolve(lines.splice(i,1)[0]);
   return new Promise((res,rej)=>{const item={prefix,res,timer:setTimeout(()=>rej(Error('TCP timeout '+prefix+' '+JSON.stringify(lines))),3000)};waiters.push(item);});
  }};
  socket.on('data',data=>{buffer+=data.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);
   if(line.startsWith('PING|')){peer.send(line.replace('PING|','PONG|'));continue;}
   const index=waiters.findIndex(w=>line.startsWith(w.prefix));if(index<0)lines.push(line);else{const w=waiters.splice(index,1)[0];clearTimeout(w.timer);w.res(line);}
  }});
  socket.once('error',reject);socket.once('connect',()=>resolve(peer));
 });
}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const pc=await connect(port);pc.send('REGISTER|2|2.6.1|FIX12-PC');const pcId=(await pc.wait('REGISTERED|')).split('|')[1];
 const apk=await connect(port);apk.send(`CONNECT_INSTALLATION|2|2.11.0|${key}|${token}`);const oldId=(await apk.wait('CONNECTED|')).split('|')[1];
 const saved=state.clientIdentities.get(key);saved.installationToken=token;saved.installationObservedAt=Date.now();installation.Backfill();
 assert.equal(state.servers.size,1);assert.equal(state.clients.size,1);
 assert.equal(lifecycle.Stop('TCP_TEST').ok,true);
 await pc.wait('SERVICE_STATE|DISABLED');await apk.wait('SERVICE_STATE|DISABLED');
 assert.equal(pc.socket.destroyed,false);assert.equal(apk.socket.destroyed,false);
 assert.equal(state.servers.size,0);assert.equal(state.clients.size,0);assert.equal(state.licenses.size,0);
 apk.send('SUPPORT_SEND|'+Buffer.from('stale').toString('base64'));apk.send('LINK_PING|FIX12');await apk.wait('LINK_PONG|FIX12');
 assert.equal(state.supportThreads.size,0);
 // A process reload retains both the stopped gate and proof that this was a
 // deliberate service reset, not an administrator deleting a single phone.
 const disk=JSON.parse(fs.readFileSync(require('../config/config').DB_FILE));assert.equal(disk.serviceEnabled,false);
 installation.ImportPersisted(disk);
 const waitingMoaPlay=await connect(port);waitingMoaPlay.send(`CONNECT_INSTALLATION|2|2.11.0|${key}|${token}`);await waitingMoaPlay.wait('SERVICE_STATE|DISABLED');
 const waitingPc=await connect(port);waitingPc.send('REGISTER|2|2.6.1|FIX12-PC');await waitingPc.wait('SERVICE_STATE|DISABLED');
 assert.equal(state.clientIdentities.size,0);assert.equal(state.serverIdentities.size,0);
 const start=performance.now();assert.equal(lifecycle.Start('TCP_TEST').ok,true);
 await Promise.all([pc,apk,waitingMoaPlay,waitingPc].map(p=>p.wait('SERVICE_STATE|ONLINE')));
 const elapsed=performance.now()-start;assert.ok(elapsed<1500, 'No scheduled reconnect backoff on start');
 // Native applications close the control transport and register afresh.
 for(const peer of [pc,apk,waitingMoaPlay,waitingPc])peer.socket.destroy();
 const newPc=await connect(port);newPc.send('REGISTER|2|2.6.1|FIX12-PC');const newPcId=(await newPc.wait('REGISTERED|')).split('|')[1];
 const newMoaPlay=await connect(port);newMoaPlay.send(`CONNECT_INSTALLATION|2|2.11.0|${key}|${token}`);const newId=(await newMoaPlay.wait('CONNECTED|')).split('|')[1];
 assert.equal(state.clients.size,1);assert.equal(state.servers.size,1);assert.notEqual(newId,oldId);assert.notEqual(newPcId,pcId);
 assert.equal(state.clients.get(newId).licenseAuthorized,false);assert.equal(state.clients.get(newId).permissionsGranted,false);
 assert.equal(state.licenses.size,0);assert.equal(state.buildSessions.size,0);
 assert.equal(state.clientInstallations.get(installation.RegistryKey(key)).authorized[0].serviceResetAt,0);
 // Consumed reset proof cannot weaken the existing single-device delete rule.
 state.clientIdentities.delete(key);
 const deleted=await connect(port);deleted.send(`CONNECT_INSTALLATION|2|2.11.0|${key}|${token}`);await deleted.wait('ERROR|REINSTALL_NOT_ALLOWED');
 console.log(`FIX12 TCP PASS: real sockets, stopped state and heartbeat, no stale writes, durable installation proof, immediate ONLINE (${elapsed.toFixed(1)} ms), fresh registration, no retained authorization, reset proof consumed`);
}finally{
 for(const socket of sockets)socket.destroy();
 await new Promise(resolve=>server.close(resolve));
 await Promise.all(acceptedClosed);
 fs.rmSync(temp,{recursive:true,force:true});
}})().catch(e=>{console.error(e);process.exitCode=1;});
