'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const native = path.resolve(__dirname, '../../MoaPlayApp_Android64');
const source = fs.readFileSync(path.join(native, 'MoaPlayDirectMessages.pas'), 'utf8');
const bridge = fs.readFileSync(path.join(native, 'MoaPlayApp.Member.DirectMessages.inc'), 'utf8');
function routine(text, name) {
  const starts = [...text.matchAll(/^(?:constructor|destructor|procedure|function)\s+([\w.]+)/gm)];
  const at = starts.findIndex(match => match[1] === name);
  assert.ok(at >= 0, name);
  return text.slice(starts[at].index, starts[at + 1]?.index ?? text.length).replace(/\{[\s\S]*?\}/g, '');
}
// Execute the real small route/paint procedures, not a second implementation of
// the transition. This intentionally rejects any unhandled Pascal syntax.
function compileProcedure(text, name) {
  let body = routine(text, 'TMoaPlayDirectMessages.' + name);
  body = body.slice(body.indexOf('\nbegin') + 1);
  const tokenPattern = /\s+|:=|'(?:''|[^'])*'|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|[();,]/gy;
  const tokens = []; let offset = 0;
  while (offset < body.length) {
    tokenPattern.lastIndex = offset;
    const token = tokenPattern.exec(body);
    assert.ok(token, 'unsupported Pascal at: ' + body.slice(offset, offset + 60));
    offset = tokenPattern.lastIndex;
    if (!/^\s+$/.test(token[0])) tokens.push(token[0]);
  }
  let pos = 0;
  const is = value => tokens[pos]?.toLowerCase() === value;
  function take(value) { assert.equal(tokens[pos]?.toLowerCase(), value); pos++; }
  function get(context, key) { return key.split('.').reduce((obj, part) => obj[part], context); }
  function put(context, key, value) { const parts = key.split('.'); const field = parts.pop(); parts.reduce((obj, part) => obj[part], context)[field] = value; }
  function atom() {
    if (is('not')) { pos++; const operand = atom(); return ctx => !operand(ctx); }
    if (is('assigned')) { pos++; take('('); const operand = expression(); take(')'); return ctx => operand(ctx) != null; }
    const token = tokens[pos++]; assert.ok(token);
    if (token.startsWith("'")) return () => token.slice(1, -1).replace(/''/g, "'");
    if (/^(true|false)$/i.test(token)) return () => token.toLowerCase() === 'true';
    assert.match(token, /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/);
    return ctx => get(ctx, token);
  }
  function conjunction() { let value = atom(); while (is('and')) { pos++; const left = value, right = atom(); value = ctx => left(ctx) && right(ctx); } return value; }
  function expression() { let value = conjunction(); while (is('or')) { pos++; const left = value, right = conjunction(); value = ctx => left(ctx) || right(ctx); } return value; }
  const EXIT = Symbol('exit');
  function statement() {
    if (is('begin')) {
      pos++; const statements = [];
      while (!is('end')) { statements.push(statement()); if (is(';')) pos++; }
      take('end');
      return ctx => { for (const statement of statements) if (statement(ctx) === EXIT) return EXIT; };
    }
    if (is('if')) { pos++; const condition = expression(); take('then'); const yes = statement(); return ctx => condition(ctx) ? yes(ctx) : undefined; }
    if (is('exit')) { pos++; return () => EXIT; }
    const field = tokens[pos++]; assert.match(field, /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/);
    if (is(':=')) { pos++; const value = expression(); return ctx => { put(ctx, field, value(ctx)); }; }
    return ctx => {
      const parts = field.split('.'), name = parts.pop(), owner = parts.reduce((obj, part) => obj[part], ctx);
      assert.equal(typeof owner[name], 'function', field + ' is a procedure');
      owner[name]();
    };
  }
  const execute = statement(); if (is(';')) pos++;
  assert.equal(pos, tokens.length, 'the entire production body must execute');
  return execute;
}
function scenario(text) {
  const prepare = compileProcedure(text, 'PrepareRoute'), paint = compileProcedure(text, 'PaintTick');
  const model = {
    now: 0, Visible: true, FPage: { Visible: true, kind: 'list' }, FMenu: { Visible: true },
    FRoutePending: false, FDirty: false, FSignature: 'old list', FPaintTimer: { Enabled: true },
    acceptedMessages: ['내 메시지', '상대 메시지'], paints: 0,
    FTouch: { Enabled: true, held: true, dispatchUntil: 0,
      Cancel() { this.held = false; this.dispatchUntil = model.now + 33; },
      get Busy() { return this.held || model.now < this.dispatchUntil; }
    },
    FScroll: { AniCalculations: { Down: true, MouseLeave() { this.Down = false; } } },
    Render() { this.FPage = { Visible: true, kind: 'thread', messages: this.acceptedMessages.slice() }; this.FDirty = false; this.paints++; }
  };
  // Reproduce an Android row dispatch with a missing release notification:
  // FIX60 exposed the footer while the list remained visible behind Busy.
  prepare(model);
  assert.equal(model.FPage.Visible, false, 'hide the old list in the same dispatch as the thread composer');
  assert.equal(model.FMenu.Visible, false);
  paint(model);
  assert.equal(model.FTouch.held, false, 'retire only the hidden route gesture after OnClick returns');
  assert.equal(model.paints, 0, 'allow the native dispatch grace period to finish');
  model.now = 34; paint(model);
  assert.equal(model.FPage.kind, 'thread');
  assert.deepEqual(model.FPage.messages, ['내 메시지', '상대 메시지']);
  assert.equal(model.FDirty, false);
  model.acceptedMessages.push('새 수신 메시지'); model.FDirty = true;
  paint(model);
  assert.equal(model.FPage.messages.length, 3, 'incoming messages repaint in the same retained route');
  model.FTouch.held = true; model.FDirty = true; const before = model.paints;
  paint(model); assert.equal(model.paints, before, 'a genuine current-page hold must remain protected');
  model.FTouch.held = false; paint(model); assert.equal(model.paints, before + 1);
  model.FDirty = true; model.FTouch.Enabled = false; paint(model);
  assert.equal(model.paints, before + 1, 'backgrounded UI must not paint');
  assert.equal(model.FPaintTimer.Enabled, false);
}
function contract(text) {
  const thread = routine(text, 'TMoaPlayDirectMessages.SetThread');
  assert.ok(thread.indexOf('PrepareRoute') < thread.indexOf('LayoutWindow'), 'route visibility changes before the composer geometry');
  assert.match(routine(text, 'TMoaPlayDirectMessages.Tick'), /if FDirty then begin QueuePaint;PaintTick\(nil\);end;/, 'normal polling drains paint without depending on one timer callback');
  assert.match(routine(text, 'TMoaPlayDirectMessages.Reply'), /finally[\s\S]*QueuePaint;\s*if Visible and FDirty then PaintTick\(nil\)/, 'accepted replies drain painting without waiting for the dashboard renderer');
  const list = routine(text, 'TMoaPlayDirectMessages.RenderList');
  assert.match(list, /DMLabel\(Row,' · 안읽음',70\+NameW,18,UnreadW,22,12,MemberLink\)/); assert.doesNotMatch(list, /개 안읽음|'trash'|'delete\|'/);
  assert.match(list, /'menu\|'/); assert.match(list, /RotationAngle:=90/);
  assert.match(routine(text, 'TMoaPlayDirectMessages.ShowMenu'), /'delete\|'/);
  assert.match(routine(text, 'TMoaPlayDirectMessages.Click'), /Action='delete' then begin ConfirmDelete\(ID\)/);
  assert.match(routine(text, 'TMoaPlayDirectMessages.ConfirmDelete'), /FMenu\.Visible:=False/, 'opening confirmation does not free its active menu sender');
  const avatar = /DMAvatar\(Row,Peer,([\d.]+),([\d.]+),([\d.]+)\)/.exec(list);
  const name = /DMLabel\(Row,Name,([\d.]+),([\d.]+),[^;]*?,([\d.]+),14,MemberText\)/.exec(list);
  const summary = /DMLabel\(Row,Summary,([\d.]+),([\d.]+),[^;]*?,([\d.]+),12,MemberMuted\)/.exec(list);
  assert.ok(avatar && name && summary, 'use production row coordinates');
  const photoCenter = Number(avatar[2]) + Number(avatar[3]) / 2;
  const blockCenter = (Number(name[2]) + Number(summary[2]) + Number(summary[3])) / 2;
  assert.equal(photoCenter, blockCenter, 'avatar and the two-line name/preview block share a vertical center');
  assert.equal(Number(name[1]), Number(summary[1]));
  // Evaluate the production scalar width assignments over short and very long
  // Korean names. The unread suffix stays adjacent and fully visible at 320px.
  const expressions = [...list.matchAll(/NameW:=([^;]+);/g)].map(match => match[1]);
  assert.equal(expressions.length, 2);
  const evaluate = expression => new Function('Row', 'UnreadW', 'NameW', 'measuredName',
    'return ' + expression.replace(/\bMax\(/g, 'Math.max(').replace(/\bMin\(/g, 'Math.min(')
      .replace('DMCaptionWidth(Name,14,True)', 'measuredName'));
  const reserve = evaluate(expressions[0]), measure = evaluate(expressions[1]);
  for (const width of [320, 360, 412, 600]) for (const measuredName of [14, 42, 112, 280, 600]) {
    const Row = { Width: width - 24 }, UnreadW = 58;
    const NameW = measure(Row, UnreadW, reserve(Row, UnreadW, 0, measuredName), measuredName);
    assert.ok(NameW >= 0);
    assert.ok(70 + NameW + UnreadW <= Row.Width - 50, 'suffix cannot overlap the trailing menu');
    assert.equal(NameW, Math.min(measuredName, Row.Width - 120 - UnreadW));
  }
}
contract(source); scenario(source);
// Demonstrate that both original failure modes are detected by the harness.
assert.throws(() => scenario(source.replace('if Assigned(FPage) then FPage.Visible:=False;', '')));
assert.throws(() => scenario(source.replace('FRoutePending:=False;FTouch.Cancel;FScroll.AniCalculations.MouseLeave;', 'FRoutePending:=False;FScroll.AniCalculations.MouseLeave;')));
assert.throws(() => contract(source.replace('QueuePaint;PaintTick(nil);', 'QueuePaint;')));
assert.match(routine(bridge, 'TMoaPlayForm.HubDirectMessagesAction'), /HubEventGameStop;[\s\S]*FHubDirectMessages\.ShowList/);
for (const text of [source, bridge]) assert.ok(!text.replace(/\r\n/g, '').includes('\n'), 'native CRLF');
console.log('FIX61 direct transitions PASS: executed production route/paint control flow, stale row-release recovery, same-route incoming messages, live hold protection, inactive guard, name·unread, aligned avatar, vertical menu and confirmed delete. Delphi runtime not executed.');
