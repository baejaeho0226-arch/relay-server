'use strict';
// Temporary FIX33 multi-device member UI entry. Set MEMBER_BIOMETRIC_TEST_MODE=0
// and APK MEMBER_BIOMETRIC_TEST_MODE=False to restore the button-free flow.
// Grants are connection/challenge scoped and never persisted as biometric proof.
const grants=new WeakMap();
const Enabled=()=>String(process.env.MEMBER_BIOMETRIC_TEST_MODE??'1')==='1';
function Valid(c){
 if(!c)return false;
 const challenge=grants.get(c);
 if(!Enabled()||!challenge||challenge!==c.deviceAuthChallengeId){grants.delete(c);return false;}
 return true;
}
function Grant(c){if(!Enabled()||!c?.deviceAuthChallengeId)return false;grants.set(c,c.deviceAuthChallengeId);return true;}
function Revoke(c){if(c)grants.delete(c);}
module.exports={Enabled,Valid,Grant,Revoke};
