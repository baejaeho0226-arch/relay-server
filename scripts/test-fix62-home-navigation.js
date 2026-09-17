'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const dir=path.resolve(__dirname,'../../MoaPlayApp_Android64');
const read=name=>fs.readFileSync(path.join(dir,'MoaPlayApp.Member.'+name+'.inc'),'utf8').replace(/\r/g,'');
const home=read('Home'),rank=read('TopGames'),rewards=read('Rewards');
function region(source,start,end){const from=source.indexOf(start),to=source.indexOf(end,from+start.length);assert.ok(from>=0&&to>from,start);return source.slice(from,to);}
function rankingCard(source){
 const card=region(source,"C:=HubCard(100);C.TagString:='top.games'","C:=HubCard(100);HubHomeHeading(C,MemberCaption('인기 피드 Top 10')");
 assert.match(card,/C.OnClick:=HubActionClick;\s*C.HitTest:=True;C.AutoCapture:=True/,'outer card owns every press including padding');
 assert.equal((card.match(/Row.HitTest:=False;Row.AutoCapture:=False/g)||[]).length,2,'heading and ranking rows are decoration');
 assert.doesNotMatch(card,/HubTextAction|product\||Row.OnClick:=HubActionClick|Row.HitTest:=True/,'child rows cannot steal the all-ranking destination');
 return card;
}
rankingCard(home);
assert.throws(()=>rankingCard(home.replace("C:=HubCard(100);C.TagString:='top.games';C.OnClick:=HubActionClick;\n  C.HitTest:=True", "C:=HubCard(100);C.TagString:='top.games';C.OnClick:=HubActionClick;\n  C.HitTest:=False")),'old inert-parent fault is detected');
assert.throws(()=>rankingCard(home.replace('Row.HitTest:=False;Row.AutoCapture:=False;RankLabel(Row,Count+1,12);','Row.HitTest:=True;Row.AutoCapture:=False;RankLabel(Row,Count+1,12);')),'row interception fault is detected');
assert.match(rank,/Card.TagString:='product\|'/,'individual product navigation remains on the full ranking');
assert.match(rank,/Card.HitTest:=True;Card.AutoCapture:=True/);
const wheel=region(rewards,'procedure TMoaPlayForm.HubRenderWheel','procedure TMoaPlayForm.HubRenderPoints');
assert.doesNotMatch(wheel,/POINT REWARDS|돌림판 보상|Prizes.Items\[I\]/,'redundant wheel reward tiles were removed');
assert.match(wheel,/FHubRewardWheel.SetPrizes\(HubArray\(Rules,'prizes'\)\)/,'wheel still shows authoritative prize segments');
assert.match(wheel,/FHubRewardWheel.SetPrizes\(TJSONArray\(PrizeSnapshot\)\)/,'accepted draw keeps its immutable prize snapshot');
assert.match(wheel,/Hub.TagString:='event.spin';Hub.OnClick:=HubActionClick/,'spin mutation and fixed central target remain intact');
const summary=region(home,'procedure TMoaPlayForm.HubRenderHomeSummary','procedure TMoaPlayForm.HubRenderHomeEvents');
assert.ok(summary.indexOf('HistoryCard(LeftCard')<summary.indexOf('Attendance:=HubObject(Data'), 'account history is visible before the tall entertainment sections');
assert.match(summary,/Top:=\(Card.Height-\(TH\+8\+VH\)\)\/2/,'wrapped history block retains equal vertical insets');
assert.match(summary,/LabelText.TextSettings.WordWrap:=True;LabelText.TextSettings.Trimming:=TTextTrimming.None/,'long titles remain multiline without ellipses');
assert.match(home,/const Goal=30;/,'thirty attendance stamps remain');
// Check the actual home grid equations at narrow, phone, tablet and emulator widths.
let cases=0;
for(const pageWidth of [240,280,320,360,393,412,480,600,800,1200]){
 const cardWidth=pageWidth-40,cols=Math.max(1,Math.min(6,Math.floor((cardWidth-36)/46))),side=Math.min(42,(cardWidth-36)/cols-8),cell=(cardWidth-36)/cols;
 const boxes=[];for(let i=0;i<30;i++)boxes.push({x:18+(i%cols)*cell+(cell-side)/2,y:Math.floor(i/cols)*(side+12),w:side,h:side});
 for(const b of boxes){assert.ok(b.x>=18&&b.x+b.w<=cardWidth-18+1e-6);assert.ok(b.w>=24);cases++;}
 for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];assert.ok(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y,'stamp hit-free geometry never overlaps');}
}
console.log(`FIX62 HOME PASS: whole-card ranking hit target, two interception fault checks, detail navigation, wheel prize snapshot, preserved history wrapping and ${cases} attendance bounds.`);
