'use strict';
const fs=require('fs');
const config=require('../config/config');
const state=require('../core/state');
function ObjectData(){return {version:1,licenseRevision:Number(state.licenseRevision)||0,licenses:Object.fromEntries(state.licenses)};}
function SaveLicenseSnapshot(){const file=config.LICENSE_SNAPSHOT_FILE,bak=config.LICENSE_SNAPSHOT_BAK_FILE,tmp=file+'.tmp';try{if(fs.existsSync(file))try{fs.copyFileSync(file,bak)}catch(_){}fs.writeFileSync(tmp,JSON.stringify(ObjectData(),null,2),'utf8');fs.renameSync(tmp,file);return true;}catch(e){try{if(fs.existsSync(tmp))fs.unlinkSync(tmp)}catch(_){}console.error('LICENSE SNAPSHOT SAVE ERROR:',e.message);return false;}}
function Read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(_){return null;}}
function RecoverIfNewer(){let best=null;for(const file of [config.LICENSE_SNAPSHOT_FILE,config.LICENSE_SNAPSHOT_BAK_FILE]){if(!fs.existsSync(file))continue;const d=Read(file);if(!d||!d.licenses||typeof d.licenses!=='object')continue;if(!best||Number(d.licenseRevision||0)>Number(best.licenseRevision||0))best=d;}if(!best||Number(best.licenseRevision||0)<=Number(state.licenseRevision||0))return false;const next=new Map();for(const [k,v] of Object.entries(best.licenses)){if(v&&typeof v==='object')next.set(k,v);}state.licenses.clear();for(const [k,v] of next)state.licenses.set(k,v);state.licenseRevision=Number(best.licenseRevision)||0;return true;}
module.exports={SaveLicenseSnapshot,RecoverIfNewer};
