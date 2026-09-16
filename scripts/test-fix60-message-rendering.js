'use strict';
// Native lifecycle and geometry regressions. This is not a Delphi runtime test.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const apk=path.resolve(__dirname,'../../MoaPlayApp_Android64');
const dm=fs.readFileSync(path.join(apk,'MoaPlayDirectMessages.pas'),'utf8');
const support=fs.readFileSync(path.join(apk,'MoaPlayApp.Support.Messages.inc'),'utf8');
function routine(source,name){
 const starts=[...source.matchAll(/^(?:constructor|destructor|procedure|function)\s+([\w.]+)/gm)];
 const i=starts.findIndex(row=>row[1]===name);assert.ok(i>=0,name);
 return source.slice(starts[i].index,starts[i+1]?.index??source.length).replace(/\{[\s\S]*?\}/g,'');
}
function paintCheck(source){
 const paint=routine(source,'TMoaPlayDirectMessages.PaintTick');
 assert.doesNotMatch(paint,/AniCalculations\.Down/,'a stale native Down flag cannot freeze delivery/deletion');
 assert.match(paint,/if\s+FTouch\.Busy\s+then\s+Exit/i,'a genuinely held row must remain alive until release');
 assert.match(paint,/if\s+FDirty\s+then\s+Render/i,'the dirty retained transcript must be painted');
 const reply=routine(source,'TMoaPlayDirectMessages.Reply');
 assert.match(reply,/finally[\s\S]*Obj\.Free;InputChanged\(nil\);QueuePaint;/i,'every accepted snapshot or error schedules independent painting');
 const invalidate=routine(source,'TMoaPlayDirectMessages.Invalidate');
 assert.match(invalidate,/FReadInvalidated:=True;FNextPoll:=0/,'pushes retain a dirty signal until a new snapshot is requested');
 assert.match(invalidate,/if\s+Visible\s+and\s+not\s+FReadBusy\s+then\s+Fetch/i,'bursts cannot restart an in-flight snapshot');
 assert.doesNotMatch(invalidate,/FReadBusy\s*:=\s*False/i,'invalidation must not cancel the live read wait');
 assert.match(reply,/finally[\s\S]*DMBool\(Obj,'ok'\)\s+and\s+FReadInvalidated[\s\S]*not\s+FReadBusy\s+then\s+Fetch/i,'a successful snapshot drains one pending follow-up');
 const request=routine(source,'TMoaPlayDirectMessages.SendRequest');
 assert.match(request,/if\s+Mutation\s+then\s+begin[\s\S]*FPendingAction:=Action;FReadBusy:=False;FReadAction:=''/i,'persisted mutations cancel transport reads and must clear the corresponding wait');
 assert.match(request,/else\s+begin[\s\S]*FReadBusy:=True;FReadAction:=Action;FReadAt:=DMTick;FReadInvalidated:=False/i,'an accepted read consumes prior invalidations, later pushes remain dirty');
 const generation=routine(source,'TMoaPlayDirectMessages.TransportChanged');
 assert.match(generation,/if\s+FTransportGeneration=Generation\s+then\s+Exit/i,'unchanged shared generation retains the in-flight read');
 assert.match(generation,/FReadBusy:=False;FReadAction:='';FReadAt:=0;FReadInvalidated:=True;FNextPoll:=0/i,'another feature canceling reads must not leave a 12-second wait');
 assert.doesNotMatch(generation,/FPendingAction\s*:=/i,'shared read cancellation preserves durable chat mutations');
 assert.doesNotMatch(routine(source,'TMoaPlayDirectMessages.Tick'),/AniCalculations\.Down/);
 assert.doesNotMatch(routine(source,'TMoaPlayDirectMessages.RequestRead'),/AniCalculations\.Down/);
 assert.match(routine(source,'TMoaPlayDirectMessages.RequestRead'),/FDirty[\s\S]*FConfirm\.Visible/,'do not acknowledge unpainted or covered incoming messages');
 const render=routine(source,'TMoaPlayDirectMessages.Render');
 assert.doesNotMatch(render,/FreeAndNil\(FInput\)|FInput\s*:=/i,'new messages preserve the native composer and IME');
 assert.match(reply,/FInput\.Text=SubmittedText/,'send acknowledgement cannot erase a new draft');
 assert.match(reply,/Action='dm.delete'[\s\S]*FreeAndNil\(FList\);FList:=DMCopy\(Data\)/,'deletion acknowledgement replaces the list from the committed projection');
 const layout=routine(source,'TMoaPlayDirectMessages.LayoutWindow');
 assert.match(layout,/W:=FHost\.Width;H:=Available;FCard\.SetBounds\(0,0,W,H\)/,'the conversation uses the full app content area');
 assert.doesNotMatch(source,/FExpand|FClose|DMTime\s*\(/,'no expand, X or clock labels in private conversations');
 assert.match(routine(source,'TMoaPlayDirectMessages.Back'),/if\s+FListMode\s+then\s+Hide\s+else\s+ShowList/i,'back returns thread to list, then closes the list');
}
function geometry(source,className){
 const configure=routine(source,className+'.Configure');
 assert.match(configure,/WordWrap:=False[\s\S]*ContentWidth:=[\s\S]*WordWrap:=True/,'measure the intrinsic line before wrapping');
 const content=/ContentWidth:=([^;]+);/.exec(configure)[1],body=/BodyWidth:=([^;]+);/.exec(configure)[1];
 // Evaluate the production scalar assignments against paragraph metrics that
 // reproduce Android's full-width TextRect for a one-glyph string.
 const make=(expression)=>new Function('MaxWidth','FLayout','ContentWidth',
  'return '+expression.replace(/\bMax\(/g,'Math.max(').replace(/\bMin\(/g,'Math.min(').replace(/\bCeil\(/g,'Math.ceil('));
 const width=make(content),padded=make(body);
 for(const [textWidth,maxWidth,expected] of [[7,300,12],[14,300,18],[28,300,32],[1400,280,284],[88.2,180,93]]){
  const native={TextWidth:textWidth,TextRect:{Right:maxWidth,Left:0}},actual=padded(maxWidth,native,width(maxWidth,native));
  assert.equal(actual,expected,className+' compact bubble width');
  assert.ok(actual+24<=maxWidth+28,'long wrapped bubble remains inside horizontal margins');
 }
 assert.doesNotMatch(content+body,/Bounds\.Right|TextRect\.Right/,'paragraph allocation is not glyph width');
}
paintCheck(dm);
const bridge=fs.readFileSync(path.join(apk,'MoaPlayApp.Member.DirectMessages.inc'),'utf8');
for(const name of ['HubDirectMessagesRequest','HubDirectMessagesReply','HubDirectMessagesTick'])
 assert.match(routine(bridge,'TMoaPlayForm.'+name),/TransportChanged\(FMember\.MutationGeneration\)/,name+' observes shared transport cancellation');
geometry(dm,'TDirectMessageText');geometry(support,'TSupportMessageText');
// Verify the guards detect the original render-starvation and right-padding
// regressions, rather than merely checking that the fixture can execute.
assert.throws(()=>paintCheck(dm.replace('if FTouch.Busy then Exit;', 'if FTouch.Busy or FScroll.AniCalculations.Down then Exit;')));
assert.throws(()=>paintCheck(dm.replace('Obj.Free;InputChanged(nil);QueuePaint;', 'Obj.Free;InputChanged(nil);')));
assert.throws(()=>paintCheck(dm.replace('if Visible and not FReadBusy then Fetch;', 'FReadBusy:=False;if Visible then Fetch;')));
assert.throws(()=>geometry(dm.replace('BodyWidth:=ContentWidth+4;', 'BodyWidth:=MaxWidth+4;'),'TDirectMessageText'));
for(const source of [dm,support])assert.ok(!source.replace(/\r\n/g,'').includes('\n'),'native edits preserve CRLF');
console.log('FIX60 message rendering PASS: stale-scroll recovery, coalesced private updates, shared mutation cancellation, shared-deletion repaint, retained IME drafts, fullscreen back flow, compact Latin/Korean/emoji/wrapped bubbles. Native runtime not executed.');
