'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const qr=require('../services/qrApproval'),tokens=require('../services/qrToken'),{PNG}=require('pngjs'),decode=require('../services/qrImageDecoder').DecodeQrImage;
const request='QRA-00112233445566778899AABB',client='0123456789ABCDEF',expires=Date.now()+60000,token=crypto.randomBytes(32).toString('base64url');
const payload=tokens.Encode('TEST_SECRET',request,client,expires,token);
assert.ok(payload.startsWith('RLY2.'));assert.ok(!payload.includes(client)&&!payload.includes(request)&&!payload.includes(token));
assert.deepEqual(tokens.Decode('TEST_SECRET',payload),{version:'2',requestId:request,clientId:client,expiresAt:expires,token});
assert.notEqual(tokens.Encode('TEST_SECRET',request,client,expires,token),payload,'fresh encryption nonce');
assert.throws(()=>tokens.Decode('OTHER_SECRET',payload),/SIGNATURE_INVALID/);
const changed=payload.slice(0,30)+(payload[30]==='A'?'B':'A')+payload.slice(31);assert.throws(()=>tokens.Decode('TEST_SECRET',changed),/SIGNATURE_INVALID/);
const matrix=qr.QrMatrix(payload);
// Erase the complete nine-module logo area, then test a filled area too.
// Both exceed the damage caused by the native inset R glyph.
for(const color of [0,255])for(const scale of [4,8]){
 const side=(matrix.size+16)*scale,png=new PNG({width:side,height:side});png.data.fill(255);
 for(let y=0;y<matrix.size;y++)for(let x=0;x<matrix.size;x++)if(matrix.bits[y*matrix.size+x]==='1')for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
  const i=(((y+8)*scale+dy)*side+(x+8)*scale+dx)*4;png.data[i]=png.data[i+1]=png.data[i+2]=0;
 }
 const start=(side-9*scale)/2,end=(side+9*scale)/2;
 for(let y=Math.floor(start);y<end;y++)for(let x=Math.floor(start);x<end;x++){const i=(y*side+x)*4;png.data[i]=png.data[i+1]=png.data[i+2]=color;}
 assert.equal(decode('data:image/png;base64,'+PNG.sync.write(png).toString('base64')),payload);
}
console.log('FIX13 QR PASS: opaque AES-GCM token, nonce uniqueness, tamper/wrong-key rejection, logo tolerance at two raster scales');
