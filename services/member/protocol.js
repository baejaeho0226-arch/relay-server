'use strict';
const crypto=require('node:crypto'),state=require('../../core/state');
function Sign(c,prefix,fields){
 const secret=c&&state.deviceSecrets.get('CLIENT:'+c.clientId);
 if(!secret||!c.deviceAuthChallengeId||!c.deviceAuthVerified)return '';
 return crypto.createHmac('sha256',secret).update([prefix,c.clientId,c.deviceAuthChallengeId,...fields].join('|'),'utf8').digest('hex').toUpperCase();
}
function Verify(c,fields,mac,prefix='HUB'){
 if(!/^[0-9a-f]{64}$/i.test(mac||''))return false;
 const expected=Sign(c,prefix,fields);
 return !!expected&&crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(mac,'hex'));
}
module.exports={Sign,Verify};
