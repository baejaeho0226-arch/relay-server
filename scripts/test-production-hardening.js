'use strict';

const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const os=require('os');
const path=require('path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-production-test-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';process.env.WEBAUTHN_RP_ID='relay.test';process.env.WEBAUTHN_ORIGIN='https://relay.test';

function socket(){return{destroyed:false,writes:[],write(v){this.writes.push(String(v));return true;}};}
function authData(rpId,count){const b=Buffer.alloc(37);crypto.createHash('sha256').update(rpId).digest().copy(b,0);b[32]=5;b.writeUInt32BE(count,33);return b.toString('base64url');}
function clientData(type,challenge){return Buffer.from(JSON.stringify({type,challenge,origin:'https://relay.test'})).toString('base64url');}

async function run(){
  const state=require('../core/state');require('../core/utils').EnsureDirs();
  const s1='1111111111111111',s2='2222222222222222',c1='AAAAAAAAAAAAAAAA',c2='BBBBBBBBBBBBBBBB';
  state.serverIdentities.set('WIN-A',s1);state.serverIdentities.set('WIN-B',s2);
  state.servers.set(s1,{serverId:s1,registered:true,clients:new Set(),socket:socket(),protocolVersion:2,appVersion:'2.6.0'});
  state.servers.set(s2,{serverId:s2,registered:true,clients:new Set([c2]),socket:socket(),protocolVersion:2,appVersion:'2.6.0'});
  state.clientIdentities.set('APK-A',{id:c1,serverId:'',createdAt:1});state.clientIdentities.set('APK-B',{id:c2,serverId:s2,createdAt:2});
  state.clients.set(c1,{clientId:c1,connected:true,socket:socket(),protocolVersion:2,appVersion:'2.6.0'});
  const pairing=require('../services/pairingApproval');
  assert.equal(pairing.BindForApproval(c1,s1,'TEST').ok,true);
  assert.equal(pairing.BindForApproval(c2,s1,'TEST').reason,'SERVER_ALREADY_PAIRED');
  assert.equal(state.clientIdentities.get('APK-A').serverId,s1);

  for(const [type,id,caps]of[['SERVER',s1,['DEVICE_HMAC','BUILD_SESSION_LEASE','FIXED_BUILD_BINDING','SIGNED_UPDATE','SERVER_AUTHORITY']],['CLIENT',c1,['DEVICE_HMAC','QR_DEVICE_APPROVAL','PIN6_ONLY','BUILD_SESSION_LEASE','FIXED_BUILD_BINDING','SIGNED_UPDATE','SERVER_AUTHORITY']]])state.deviceCapabilities.set(`${type}:${id}`,new Set(caps));
  const center=require('../services/productionCenter');
  const compatibility=center.CompatibilityOverview();assert.ok(compatibility.devices.find(x=>x.id===c1).compatible);
  const plan=center.ConfigDryRun({minProtocolVersion:2,heartbeatMs:12000},'TEST');assert.ok(plan.ok);assert.equal(center.ApplyPlan(plan.plan.planId,'TEST').ok,true);assert.equal(state.desiredRuntimeConfig.heartbeatMs,12000);

  const audit=require('../storage/audit');audit.LogEvent('TEST_CHAIN','one');audit.LogEvent('TEST_CHAIN','two');const verified=audit.VerifyAuditChain();assert.ok(verified.ok);assert.ok(verified.count>=2);assert.match(verified.head,/^[0-9A-F]{64}$/);
  const diag=center.Diagnostics('CLIENT',c1,'TEST');assert.ok(diag.ok);assert.ok(!JSON.stringify(diag).includes('deviceSecrets'));
  assert.ok(center.RecoveryDrill('TEST').drill.ok);
  assert.ok(center.SloSnapshot().errorBudget);
  assert.ok(center.SupplyChainManifest().manifest.sbom.length>0);
  assert.equal(center.ChaosRun('SERVER_OUTAGE','TEST').run.mode,'SIMULATION_ONLY');
  assert.ok(center.RetentionApply('TEST').ok);
  assert.equal(require('../services/transportSecurity').Status().actualMode,'HMAC_ONLY');

  const dual=require('../services/privilegedApproval'),a={id:'ADMIN-A',role:'admin'},b={id:'ADMIN-B',role:'admin'},payload={planId:'X'};
  const ticket=dual.Request(a,'POST','/api/production/config/apply',payload,'test').ticket;
  assert.equal(dual.Approve(ticket.ticketId,a).reason,'SECOND_ADMIN_SESSION_REQUIRED');assert.ok(dual.Approve(ticket.ticketId,b).ok);assert.ok(dual.Consume('',a,'POST','/api/production/config/apply',payload).ok);

  const old={artifactId:'OLD',type:'SERVER',channel:'TEST',version:'2.6.0',fileName:'old.exe',enabled:true,rolloutPercent:100};
  const current={artifactId:'NEW',type:'SERVER',channel:'TEST',version:'2.7.0',fileName:'new.exe',enabled:true,rolloutPercent:10,previous:old};
  state.releaseCatalog.set('SERVER:TEST',current);state.production.updatePolicy={...state.production.updatePolicy,autoRollback:true,minimumSamples:1,failureThresholdPercent:1};
  const update=require('../services/updateSupervisor');update.Begin('SERVER',s1,current);update.Record('SERVER',s1,'2.7.0','SIGNATURE_INVALID','test');assert.equal(state.releaseCatalog.get('SERVER:TEST').version,'2.6.0');

  const passkey=require('../services/passkeyAuth');const req={headers:{host:'relay.test','x-forwarded-proto':'https'},socket:{encrypted:true}};const session={id:'PASSKEY-ADMIN',role:'admin'};
  const begin=passkey.RegistrationBegin(session,req);const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});const spki=keys.publicKey.export({type:'spki',format:'der'});const credentialId=crypto.randomBytes(32).toString('base64url');
  const registered=passkey.RegistrationFinish(session,req,{challengeId:begin.challengeId,credentialId,clientDataJSON:clientData('webauthn.create',begin.publicKey.challenge),authenticatorData:authData('relay.test',1),publicKeySpki:spki.toString('base64url'),name:'Test Key'});assert.ok(registered.ok,registered.reason);
  const login=passkey.LoginBegin('admin',req);const cdata=clientData('webauthn.get',login.publicKey.challenge),adata=authData('relay.test',2);const signed=Buffer.concat([Buffer.from(adata,'base64url'),crypto.createHash('sha256').update(Buffer.from(cdata,'base64url')).digest()]);const signature=crypto.sign('sha256',signed,keys.privateKey).toString('base64url');
  const authenticated=passkey.LoginFinish(req,{challengeId:login.challengeId,credentialId,clientDataJSON:cdata,authenticatorData:adata,signature});assert.ok(authenticated.ok,authenticated.reason);

  const apk=fs.readFileSync(path.resolve(__dirname,'../../ApkWinSock_Android64/ApkWinSock.Lifecycle.inc'),'utf8');const immersive=apk.slice(apk.indexOf('procedure TForm1.ApplyImmersiveFullscreen'),apk.indexOf('procedure TForm1.FormActivated'));
  assert.ok(immersive.includes('FullScreen := True'));assert.ok(!/Androidapi|JNI|WindowManager/.test(immersive));
  const web=fs.readFileSync(path.resolve(__dirname,'../public/admin-pages-production.js'),'utf8');assert.ok(web.includes('renderProductionHardening'));assert.ok(web.includes('navigator.credentials'));
  console.log('PRODUCTION HARDENING 28-43 PASS');
  console.log('- Explicit atomic QR to PC pairing: PASS');
  console.log('- Compatibility fingerprints, TLS truth-state and signed rollback: PASS');
  console.log('- WebAuthn, dual approval and config dry-run: PASS');
  console.log('- Audit chain, diagnostics, incidents, SLO and recovery drill: PASS');
  console.log('- Anomaly, retention, SBOM and safe chaos simulation: PASS');
  console.log('- FireMonkey immersive fullscreen without JNI window calls: PASS');
}
run().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
