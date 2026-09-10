'use strict';
// Verify the actual palette and source coverage. This is not FMX/device rendering.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
function Check(apk=path.resolve(__dirname,'../../ApkWinSock_Android64')){
 const read=n=>fs.readFileSync(path.join(apk,n),'utf8');
 const theme=read('ApkMemberTheme.pas').split(/\bimplementation\b/i)[1];
 function color(name,dark){
  const body=new RegExp('function '+name+':TAlphaColor;\\s*begin ([^\\n]+)end;','i').exec(theme)?.[1];
  assert.ok(body,'Missing palette role '+name);
  const pair=/if DarkValue then Result:=\$([\da-f]{8}) else Result:=\$([\da-f]{8});/i.exec(body);
  if(pair)return parseInt(pair[dark?1:2],16);
  const alias=/Result:=(Member\w+);/.exec(body);if(alias)return color(alias[1],dark);
  const literal=/Result:=\$([\da-f]{8});/i.exec(body);assert.ok(literal,'Unsupported palette expression '+name);
  return parseInt(literal[1],16);
 }
 const rgb=c=>[16,8,0].map(s=>(c>>>s)&255);
 const luma=c=>rgb(c).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const contrast=(a,b)=>(Math.max(luma(a),luma(b))+.05)/(Math.min(luma(a),luma(b))+.05);
 const blend=(fg,bg)=>{const alpha=(fg>>>24)/255;return rgb(fg).map((v,i)=>Math.round(v*alpha+rgb(bg)[i]*(1-alpha))).reduce((r,v)=>r*256+v,0);};
 for(const dark of [false,true]){
  for(const surface of ['MemberBackground','MemberSurface','MemberSoft'])
   for(const text of ['MemberText','MemberMuted','MemberLink'])
    assert.ok(contrast(color(text,dark),color(surface,dark))>=4.5,`${dark?'dark':'light'} ${text} on ${surface}`);
  assert.ok(contrast(color('MemberPrimary',dark),color('MemberOnPrimary',dark))>=7,'Primary labels/icons');
  for(const role of ['MemberSuccessOnPrimary','MemberErrorOnPrimary'])
   assert.ok(contrast(color(role,dark),color('MemberPrimary',dark))>=4.5,role);
  assert.ok(contrast(color('MemberText',dark),blend(color('MemberSelection',dark),color('MemberSoft',dark)))>=4.5,'Selected input text');
  // Category badges share one foreground, but every category has a paired fill.
  const category=theme.split('function MemberCategoryColor')[1].split('function MemberTextColor')[0];
  for(const m of category.matchAll(/if MemberDark then (?:Exit\(|Result:=)\$([\da-f]{8})\)?;? else (?:Exit\(|Result:=)\$([\da-f]{8})/gi))
   assert.ok(contrast(color('MemberText',dark),parseInt(m[dark?1:2],16))>=4.5,'Category badge text');
 }
 const files=fs.readdirSync(apk).filter(n=>/^ApkWinSock.*\.(inc|pas)$/.test(n));
 for(const name of files){
  const code=read(name);
  assert.doesNotMatch(code,/COLOR_(?:QR_BG|QR_TEXT|USER_BG)|SetAndroidBarsDark\(False\)/,name+' bypasses theme');
  for(const line of code.split(/\r?\n/))
   if(/(?:Fill\.Color|FontColor|UiLabel\(|UiRect\(|HubLabel\()/.test(line))
    assert.doesNotMatch(line,/\$[\da-f]{8}|TAlphaColorRec\./i,name+' fixed UI color');
 }
 assert.match(read('ApkMemberSvg.pas'),/MemberOnPrimary/);assert.match(read('ApkSmoothGlyphs.pas'),/MemberText/);
 assert.match(read('ApkMemberMemo.pas'),/MemberSoft/);assert.match(read('ApkMemberMemo.pas'),/MemberSelection/);
 assert.doesNotMatch(read('ApkWinSock.Theme.inc'),/for \w+ in \w+\.Children\b/,'No unsafe recursive style enumeration');
 assert.match(read('AndroidManifest.full.xml'),/configChanges="[^"]*\buiMode\b/,'Theme changes must not recreate the authenticated activity');
 assert.doesNotMatch(read('ApkSystemBars.pas'),/\.setNightMode\(/,'Use app-local mode only');
 const night=read('AndroidResources/res/values-night/relay_colors.xml'),day=read('AndroidResources/res/values/relay_colors.xml');
 assert.notEqual(night,day);assert.match(night,/relay_light_bars">false/);assert.match(day,/relay_light_bars">true/);
 for(const n of ['values/relay_launch_theme.xml','values-v31/relay_launch_theme.xml','drawable/relay_splash.xml','drawable/relay_launch_icon.xml'])
  assert.doesNotMatch(read('AndroidResources/res/'+n),/#[\da-f]{6}/i,'Launch color must follow day/night resource: '+n);
 for(const n of ['values','values-v31'])assert.match(read('AndroidResources/res/'+n+'/relay_launch_theme.xml'),/forceDarkAllowed">false/,'Do not auto-invert a theme drawn by FMX');
 return files.length;
}
if(require.main===module)console.log(`Native theme source check passed: ${Check()} form files, light/dark text contrast, primary icons and Android night resources (device rendering not run).`);
module.exports={Check};
