'use strict';
const crypto=require('node:crypto');
function Key(secret){return crypto.createHash('sha256').update('RELAY-QR-V2\0'+secret).digest();}
const AAD=Buffer.from('RELAY/QR/APPROVAL/V2');
function Encode(secret,requestId,clientId,expiresAt,token){
 if(!/^QRA-[0-9A-F]{24}$/.test(requestId)||!/^[0-9A-F]{16}$/.test(clientId)||!Number.isSafeInteger(expiresAt)||expiresAt<=0)throw Error('QR_PAYLOAD_INVALID');
 const plain=Buffer.alloc(58);Buffer.from(requestId.slice(4),'hex').copy(plain,0);Buffer.from(clientId,'hex').copy(plain,12);plain.writeUIntBE(expiresAt,20,6);
 const t=Buffer.from(token,'base64url');if(t.length!==32)throw Error('QR_TOKEN_INVALID');t.copy(plain,26);
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',Key(secret),iv);cipher.setAAD(AAD);
 const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
 return 'RLY2.'+Buffer.concat([iv,encrypted,cipher.getAuthTag()]).toString('base64url');
}
function Decode(secret,value){
 if(!/^RLY2\.[A-Za-z0-9_-]{115}$/.test(value))throw Error('QR_PAYLOAD_INVALID');
 const packet=Buffer.from(value.slice(5),'base64url');if(packet.length!==86||packet.toString('base64url')!==value.slice(5))throw Error('QR_PAYLOAD_INVALID');
 try{
  const decipher=crypto.createDecipheriv('aes-256-gcm',Key(secret),packet.subarray(0,12));decipher.setAAD(AAD);decipher.setAuthTag(packet.subarray(-16));
  const plain=Buffer.concat([decipher.update(packet.subarray(12,-16)),decipher.final()]);
  return {version:'2',requestId:'QRA-'+plain.subarray(0,12).toString('hex').toUpperCase(),clientId:plain.subarray(12,20).toString('hex').toUpperCase(),expiresAt:plain.readUIntBE(20,6),token:plain.subarray(26).toString('base64url')};
 }catch(_){throw Error('QR_SIGNATURE_INVALID');}
}
module.exports={Encode,Decode};
