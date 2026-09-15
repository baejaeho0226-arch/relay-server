'use strict';
// Static invariants for native card interactions and the resting glass brush.
// This reads the shipped Delphi source; it does not simulate FMX input delivery.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
function Check(apk = path.resolve(__dirname, '../../MoaPlayApp_Android64')) {
  const read = name => fs.readFileSync(path.join(apk, name), 'utf8');
  const touch = read('MoaPlayMemberTouch.pas');
  const widgets = read('MoaPlayApp.Member.Widgets.inc');
  const method = name => {
    const start = touch.search(new RegExp('procedure TMoaPlayTapRectangle\\.' + name + '[;(]'));
    assert.ok(start >= 0, 'Missing touch procedure ' + name);
    const rest = touch.slice(start);
    return rest.slice(0, rest.slice(1).search(/\n(?:procedure|function|constructor|destructor) /) + 1 || undefined);
  };
  // Press feedback must not add a hit-test child, resize the target or mutate
  // its opacity. A held press has no duration limit; only release fades.
  assert.doesNotMatch(touch, /FPressOverlay|TFloatAnimation|Self\.Opacity\s*:=/);
  assert.match(touch, /procedure Paint; override;/);
  assert.match(touch, /Canvas\.SaveState[\s\S]*finally Canvas\.RestoreState\(Saved\)/);
  const tick = method('PressTick');
  assert.ok(tick.indexOf('if FTouchDown and not FCanceled') < tick.indexOf('Elapsed:='), 'Hold checked before elapsed release fade');
  assert.match(tick, /if FTouchDown and not FCanceled then begin\s*FPressTimer\.Enabled:=False;[\s\S]*?Exit;\s*end;/);
  assert.match(method('ShowPress'), /if FTouchDown and not FCanceled then Exit;/);
  assert.match(method('ShowPress'), /if Assigned\(FPressTimer\) then FPressTimer\.Enabled:=False;/, 'New press cancels old fade');
  assert.match(touch, /destructor TMoaPlayTapRectangle\.Destroy;\s*begin\s*if Assigned\(FPressTimer\) then begin FPressTimer\.Enabled:=False;FPressTimer\.OnTimer:=nil;end;/);
  assert.match(method('CancelTouch'), /FPressLevel:=0;FReleasing:=False;FRepeatDoublePending:=False;/);
  assert.match(method('MouseUp'), /if not PointInObjectLocal\(X,Y\) then CancelTouch;/);
  assert.match(method('CheckMovement'), /if Assigned\(FScope\) and FScope\.FGestureMoved and/);
  assert.match(touch, /FGestureMoved:=False;FMovingUntil:=0;/, 'A fresh down does not inherit an old scroll');
  assert.match(touch, /Result:=\(X>=0\) and \(Y>=0\) and \(X<=Width\) and \(Y<=Height\);/);
  assert.match(touch, /FDownAt:=TStopwatch\.GetTimeStamp;FTouchDown:=True;FHadDown:=True;FCanceled:=False/);
  assert.match(touch, /if FRepeatClicks and FRepeatDoublePending then Click;/);
  assert.match(touch, /FRepeatClickDownAt=FDownAt/, 'Repeated chip clicks retain gesture-specific deduplication');
  assert.match(touch, /Rejected:=\(FCanceled and FHadDown\)/);
  assert.match(touch, /if not Rejected then inherited Click;/, 'A canceled gesture never reaches the application handler');
  // Card decoration uses the existing native rounded brush. It does not turn
  // passive wrappers into input targets or affect text-input/action chrome.
  const glass = widgets.split('procedure HubGlassCardStyle')[1].split('function TMoaPlayForm.HubCard')[0];
  assert.match(glass, /Fill\.Kind:=TBrushKind\.Gradient/);
  assert.equal((glass.match(/Point\.Offset:=/g) || []).length, 3);
  assert.doesNotMatch(glass, /\.Create\(|HitTest|AutoCapture|OnClick|\.Opacity\s*:=/);
  for (const name of ['HubActionPanelStyle', 'HubInputPanelStyle']) {
    const part = widgets.split('procedure ' + name)[1].split(/\n(?:procedure|function) /)[0];
    assert.match(part, /Fill\.Kind:=TBrushKind\.None/);
    assert.doesNotMatch(part, /HubGlassCardStyle/);
  }
  assert.match(read('MoaPlayApp.Member.NewsShop.inc'), /procedure HubContentReadStyle[\s\S]*?HubGlassCardStyle\(Card\)/);
  const theme = read('MoaPlayMemberTheme.pas').split(/\bimplementation\b/i)[1];
  const role = (name, dark) => {
    const body = new RegExp('function ' + name + ':TAlphaColor;\\s*begin ([^\\n]+)end;', 'i').exec(theme)?.[1];
    assert.ok(body, 'Missing palette role ' + name);
    const pair = /if DarkValue then Result:=\$([\da-f]{8}) else Result:=\$([\da-f]{8});/i.exec(body);
    assert.ok(pair, 'Expected theme pair for ' + name);
    return parseInt(pair[dark ? 1 : 2], 16);
  };
  const rgb = c => [16, 8, 0].map(s => (c >>> s) & 255);
  const luma = c => rgb(c).map(v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => (Math.max(luma(a), luma(b)) + .05) / (Math.min(luma(a), luma(b)) + .05);
  const composite = (fg, bg) => rgb(fg).map((v, i) => Math.round(v * (fg >>> 24) / 255 + rgb(bg)[i] * (1 - (fg >>> 24) / 255))).reduce((out, v) => out * 256 + v, 0);
  let samples = 0;
  for (const dark of [false, true]) {
    for (const bg of ['MemberBackground', 'MemberSoft']) {
      for (const color of ['MemberGlassTop', 'MemberGlassMiddle', 'MemberGlassBottom']) {
        const fill = role(color, dark);
        assert.ok((fill >>> 24) < 255, 'Glass remains translucent');
        const surface = composite(fill, role(bg, dark));
        for (const ink of ['MemberText', 'MemberMuted', 'MemberLink']) {
          assert.ok(contrast(role(ink, dark), surface) >= 4.5, `${dark ? 'dark' : 'light'} ${ink} on ${color}/${bg}`);
          samples++;
        }
      }
    }
  }
  return samples;
}
if (require.main === module) console.log(`Native touch/glass source guard passed (${Check()} palette contrast samples; Delphi/device input not executed).`);
module.exports = { Check };
