'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const dir=path.resolve(__dirname,'../../MoaPlayApp_Android64');
const read=name=>fs.readFileSync(path.join(dir,'MoaPlayApp.Member.'+name+'.inc'),'utf8').replace(/\r/g,'');
const rank=read('TopGames'),rewards=read('Rewards');
function region(source,start,end){const from=source.indexOf(start),to=source.indexOf(end,from+start.length);assert.ok(from>=0&&to>from,start);return source.slice(from,to);}
assert.match(rank,/Card.TagString:='product\|'/,'individual product navigation remains on the full ranking');
assert.match(rank,/Card.HitTest:=True;Card.AutoCapture:=True/);
const wheel=region(rewards,'procedure TMoaPlayForm.HubRenderWheel','procedure TMoaPlayForm.HubRenderPoints');
assert.doesNotMatch(wheel,/POINT REWARDS|돌림판 보상|Prizes.Items\[I\]/,'redundant wheel reward tiles were removed');
assert.match(wheel,/FHubRewardWheel.SetPrizes\(HubArray\(Rules,'prizes'\)\)/,'wheel still shows authoritative prize segments');
assert.match(wheel,/FHubRewardWheel.SetPrizes\(TJSONArray\(PrizeSnapshot\)\)/,'accepted draw keeps its immutable prize snapshot');
assert.match(wheel,/Hub.TagString:='event.spin';Hub.OnClick:=HubActionClick/,'spin mutation and fixed central target remain intact');
console.log('FIX62 DESTINATIONS PASS: independent product ranking navigation, wheel prize snapshot and fixed spin target.');
