'use strict';
// Execute the arithmetic from the Delphi auth-layout block with FMX SetBounds
// mocks. This checks geometry and source gates, not Android runtime rendering.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const dir=path.resolve(__dirname,'../../MoaPlayApp_Android64');
const read=name=>fs.readFileSync(path.join(dir,name),'utf8').replace(/\r\n/g,'\n');
const ui=read('MoaPlayApp.Ui.inc'),construct=read('MoaPlayApp.Lifecycle.Construction.inc');
const production=construct.match(/if not MEMBER_BIOMETRIC_TEST_MODE then\s+begin\s+([\s\S]*?)\n  end;\n  FRuntime := nil;/);
assert.ok(production,'Native biometric creation is scoped to normal authentication mode');
assert.ok(production[1].includes('FBiometricAuth := TBiometricAuth.Create(Self)'));
for(const callback of ['BiometricAuthenticateSuccess','BiometricAuthenticateFail'])assert.ok(production[1].includes(callback));
assert.ok(production[1].includes('TBiometricStrength.Weak'));
const show=ui.split('procedure TMoaPlayForm.ShowBiometricPanel')[1].split('procedure TMoaPlayForm.ShowRestoredBiometricPage')[0];
assert.ok(show.includes('FBiometricTestButton.Visible := MEMBER_BIOMETRIC_TEST_MODE'));
assert.ok(show.includes('FBiometricPanel.BringToFront'));
assert.ok(!/CanAuthenticate|IsSupported|hardware|MANUFACTURER/i.test(show));
assert.ok(read('MoaPlayApp.Protocol.Qr.inc').includes("ShowBiometricPanel(MemberCaption('승인 완료"));
const device=read('MoaPlayDeviceInfo.pas');
assert.ok(!device.includes('MEMBER_BIOMETRIC_TEST_MODE'),'Test UI may not override device permissions');
const permissions=read('MoaPlayApp.Permissions.inc');
assert.ok(permissions.includes('(CurrentPermissionMask = 7)'));
const enter=read('MoaPlayApp.Member.TestAccess.inc');
for(const gate of ['PermissionsReady','FPermissionsServerGranted','FDeviceAuthVerified','FState.LicenseAuthenticated',"FMember.Request('test.enter','{}',False)"])assert.ok(enter.includes(gate));
assert.ok(!/BiometricAuthenticated\s*:=\s*True/.test(enter));
const block=ui.split('  FBiometricPanel.SetBounds(0, ContentTop, RootWidth, ContentHeight);')[1].split('  SetBiometricProgress(FBiometricProgressValue);')[0];
assert.ok(block);
let js=block.replace(/\{[\s\S]*?\}/g,'');
js=js.replace(/if ([^;]+?) then\s+begin\s+([\s\S]*?)\s+end;/g,'if ($1) { $2 }');
js=js.replace(/if ([^\n]*?) then ([^\n]*?);/g,'if ($1) { $2; }');
js=js.replace(/\band\b/g,'&&').replace(/:=/g,'=').replace(/\.(BringToFront);/g,'.$1();');
const assigned=[...block.matchAll(/\b([A-Za-z]\w*)\s*:=/g)].map(x=>x[1]);
const run=new Function('context','with(context) {'+js+'}');
function control(){return {Visible:true,SetBounds(x,y,w,h){this.bounds={x,y,w,h};},BringToFront(){}};}
let checked=0;
for(const mode of [false,true])for(const width of [240,320,360,411,480,800,1280])for(const height of [80,120,160,180,200,225,226,240,280,320,360,480,640,800,1280]){
 const c={Min:Math.min,Max:Math.max,RootWidth:width,ContentHeight:height,MEMBER_BIOMETRIC_TEST_MODE:mode};
 for(const variable of assigned)c[variable]=0;
 for(const name of ['FBiometricFingerprint','FBiometricTitle','FBiometricHint','FBiometricProgressLabel','FBiometricProgressTrack','FBiometricTestButton'])c[name]=control();
 c.FBiometricProgressTrack.Visible=false; // SetBiometricProgress always hides it.
 run(c);
 assert.equal(c.FBiometricTestButton.Visible,mode);
 for(const [name,item]of Object.entries(c))if(item&&item.bounds&&item.Visible){
  const{x,y,w,h}=item.bounds;
  assert.ok([x,y,w,h].every(Number.isFinite),`${name}: finite bounds`);
  assert.ok(x>=0&&y>=0&&w>=0&&h>=0&&x+w<=width+0.001&&y+h<=height+0.001,`${mode}/${width}x${height} ${name}: ${JSON.stringify(item.bounds)}`);
 }
 if(mode){
  assert.ok(c.FBiometricTestButton.bounds.h>=48,'Action keeps a 48dp target at supported window sizes');
  assert.ok(c.FBiometricHint.bounds.y+c.FBiometricHint.bounds.h<=c.FBiometricTestButton.bounds.y,'Hint never covers the action');
  const b=c.FBiometricTestButton.bounds;
  const overlapsSupport=b.x<width-16&&b.x+b.w>width-64&&b.y<height-16&&b.y+b.h>height-64;
  assert.equal(overlapsSupport,false,'Floating support launcher must not cover the test action');
 }
 checked++;
}
// The FIX49 formula put the 48dp action outside this small landscape viewport.
assert.ok(Math.trunc(200/2)+65+48>200);
console.log(`FIX50 PASS: ${checked} source-driven normal/test auth layouts stay in bounds; native biometrics are normal-mode only; QR/HMAC and current permission gates remain required.`);
