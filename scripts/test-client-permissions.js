'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-permissions-'));
process.env.DATA_DIR = dir;
process.env.STORAGE_ENGINE = process.env.STORAGE_ENGINE || 'json';
process.env.QR_APPROVAL_SECRET = 'permissions-regression-test-only-secret';
const state = require('../core/state');
const gate = require('../services/clientPermissions');
const handler = require('../relay/clientHandler');
const qr = require('../services/qrApproval');
const biometric = require('../services/clientBiometric');
const db = require('../storage/database');
const build = require('../services/buildGate');
const installation = require('../services/clientInstallation');
const support = require('../services/supportCenter');
const id = 'A123456789ABCDEF';
const key = 'ANDROID2-1122334455667788-AAAAAAAAAAAAAAAA';
const token = 'A'.repeat(32), secret = 'permissions-test-secret-never-production';
const saved = { id, serverId:'', installationToken:token, installationAuthorizedAt:Date.now() };
const c = { type:'client', clientId:id, connected:true, installationToken:token,
  installationDeviceKey:key, deviceAuthVerified:true, deviceAuthChallengeId:'A123456789ABCDEF', writes:[] };
c.socket = { destroyed:false, remoteAddress:'127.0.0.1', write(text) { c.writes.push(text.trim()); return true; }, destroy() { this.destroyed=true; } };
c.socket.__relayConnection = c;
function frame(sequence, mask, challenge=c.deviceAuthChallengeId) {
  const proof = crypto.createHmac('sha256',secret).update(`PERMISSIONS|${id}|${challenge}|${sequence}|${mask}`).digest('hex');
  return `CLIENT_PERMISSIONS|${sequence}|${mask}|${proof}`;
}
function send(sequence,mask) { handler.HandleClientLine(c,frame(sequence,mask)); }
function requestApproval(record) {
  const proof=crypto.createHmac('sha256',process.env.QR_APPROVAL_SECRET).update(
    `APPROVE|${record.requestId}|${id}|${record.tokenHash}|${record.expiresAt}`).digest('hex');
  return qr.Approve(record.requestId,proof,{accessType:'TYPE1'},'TEST');
}
try {
  require('../core/utils').EnsureDirs();
  state.clients.set(id,c); state.clientIdentities.set(key,saved);
  state.deviceSecrets.set('CLIENT:'+id,secret);
  require('../services/deviceControl').RecordCapabilities('CLIENT',id,'DEVICE_HMAC,QR_DEVICE_APPROVAL,BIOMETRIC_AUTH');
  installation.Backfill(); gate.Reset(c);
  assert.equal(gate.Ready(c),false);
  assert.equal(qr.Resume(c).reason,'PERMISSIONS_REQUIRED');
  assert.equal(build.Queue(c,'BUILD1').reason,'PERMISSIONS_REQUIRED');
  c.licenseAuthorized=true;
  assert.equal(biometric.Begin(c).reason,'PERMISSIONS_REQUIRED');
  assert.equal(biometric.HandleProof(c,['BIOMETRIC_PROOF','ENROLL','old','bad']),false);
  support.Handle(c,`SUPPORT_OPEN|${id}`);
  assert.equal(state.supportThreads.size,0);
  for (const line of [`QR_AUTH_RESUME|${id}`,`BIOMETRIC_BEGIN|${id}`,`BUILD|TESTBUILD|${id}`,`SEND|TESTSEND|${id}|1`]) {
    handler.HandleClientLine(c,line); assert.equal(c.writes.at(-1),'ERROR|PERMISSIONS_REQUIRED');
  }
  handler.HandleClientLine(c,frame(1,7).slice(0,-1)+'Z');
  assert.equal(gate.Ready(c),false,'malformed signatures fail closed');
  send(1,7); assert.equal(gate.Ready(c),true);
  assert.equal(c.writes.at(-1),'CLIENT_PERMISSIONS_OK|1|7');
  send(1,7); assert.equal(gate.Ready(c),true,'lost ACK retry is idempotent');
  const issue=qr.Resume(c); assert.equal(issue.ok,true);
  const oldRecord=state.qrAuthRequests.get(issue.request.requestId);
  assert.equal(requestApproval(oldRecord).ok,true);
  assert.equal(c.licenseAuthorized,true);
  const oldChallenge=state.clientBiometricChallenges.get(id);
  const oldBioProof=biometric.Proof(secret,oldChallenge.mode,id,oldChallenge.nonce,oldChallenge.accessType);
  assert.equal(biometric.HandleProof(c,['BIOMETRIC_PROOF',oldChallenge.mode,oldChallenge.nonce,oldBioProof]),true);
  support.Handle(c,`SUPPORT_OPEN|${id}`);
  const room=c.supportRoomId;
  state.clientBuildBindings.set(id,{clientId:id,serverId:'B123456789ABCDEF'});
  state.buildSessions.set('TEST-LEASE',{sessionId:'TEST-LEASE',clientId:id,serverId:'B123456789ABCDEF',status:'AUTHORIZED',expiresAt:Date.now()+60000});
  state.pendingRequests.set('old-request',{clientId:id,requestId:'OLD'});
  state.offlineQueue.set('old-queue',{clientId:id,requestId:'OLD2'});
  send(2,6); // notification denied
  assert.equal(gate.Ready(c),false);
  assert.equal(c.licenseAuthorized,false); assert.equal(c.biometricVerified,false);
  assert.equal(state.clientBiometricProfiles.has(id),false);
  assert.equal(state.clientBiometricChallenges.has(id),false);
  assert.equal(state.buildSessions.get('TEST-LEASE').status,'REVOKED');
  assert.equal(state.pendingRequests.size,0); assert.equal(state.offlineQueue.size,0);
  assert.equal(state.clientBuildBindings.has(id),true,'fixed pairing is preserved');
  assert.equal(support.Read(room).clientId,room,'conversation is preserved');
  assert.equal(saved.installationToken,token); assert.ok(saved.installationAuthorizedAt);
  assert.equal(oldRecord.status,'SUPERSEDED'); assert.equal(requestApproval(oldRecord).ok,false);
  send(1,7); assert.equal(gate.Ready(c),false,'old grant cannot override newer denial');
  send(2,7); assert.equal(gate.Ready(c),false,'same sequence cannot change payload');
  send(3,7); assert.equal(gate.Ready(c),true);
  assert.equal(gate.NeedsApproval(c),true);
  assert.equal(biometric.Begin(c).reason,'PERMISSIONS_REQUIRED');
  assert.equal(biometric.HandleProof(c,['BIOMETRIC_PROOF',oldChallenge.mode,oldChallenge.nonce,oldBioProof]),false);
  assert.equal(require('../license/licenseManager').AuthorizeBoundClientByQr(c),false,'bound license cannot bypass reapproval');
  const newIssue=qr.Resume(c); assert.equal(newIssue.ok,true); assert.ok(!newIssue.resumed);
  assert.notEqual(newIssue.request.requestId,oldRecord.requestId);
  const newRecord=state.qrAuthRequests.get(newIssue.request.requestId);
  c.permissionsGranted=false;
  assert.equal(requestApproval(newRecord).reason,'PERMISSIONS_REQUIRED','web cannot approve missing permissions');
  c.permissionsGranted=true;
  const save=db.SaveDatabase; db.SaveDatabase=()=>false;
  try { assert.equal(requestApproval(newRecord).reason,'STORAGE_SAVE_FAILED'); assert.equal(saved.permissionsReapprovalRequired,true); }
  finally { db.SaveDatabase=save; }
  assert.equal(requestApproval(newRecord).ok,true);
  assert.equal(gate.NeedsApproval(c),false);
  send(4,5); // phone denied
  assert.equal(gate.Ready(c),false); assert.equal(gate.NeedsApproval(c),true);
  const disk=process.env.STORAGE_ENGINE==='sqlite' ? require('../storage/sqliteDatabase').LoadSnapshot().data : JSON.parse(fs.readFileSync(require('../config/config').DB_FILE));
  db.ImportDatabaseObject(disk);
  assert.equal(gate.NeedsApproval(c),true,'revocation survives JSON/SQLite reload');
  const oldAuth=c.deviceAuthChallengeId;
  c.deviceAuthChallengeId='B123456789ABCDEF'; gate.Reset(c);
  handler.HandleClientLine(c,frame(5,7,oldAuth)); assert.equal(gate.Ready(c),false,'proof binds to this HMAC handshake');
  send(1,7); assert.equal(gate.Ready(c),true);
  const original=db.SaveDatabase; db.SaveDatabase=()=>false;
  try { send(2,0); assert.equal(gate.Ready(c),false); assert.notEqual(c.writes.at(-1),'CLIENT_PERMISSIONS_OK|2|0'); }
  finally { db.SaveDatabase=original; }
  send(2,0); assert.equal(c.writes.at(-1),'CLIENT_PERMISSIONS_OK|2|0');
  console.log('PERMISSION GATE PASS: signed grants, replay, denial, stale QR/biometric, lease/queue revoke, reapproval, persistence and save failure');
} finally {
  try { require('../storage/sqliteDatabase').Close(); } catch (_) {}
  fs.rmSync(dir,{recursive:true,force:true});
}
