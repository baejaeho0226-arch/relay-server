'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const apk=path.resolve(__dirname,'../../MoaPlayApp_Android64');
const read=name=>fs.readFileSync(path.join(apk,name),'utf8').replace(/^\uFEFF/,'').replace(/\r/g,'');
const flow=read('MoaPlayApp.Member.Flow.inc'),actions=read('MoaPlayApp.Member.Actions.inc');
const source=flow.match(/function TMoaPlayForm\.HubReadAction:string;\s*begin([\s\S]*?)\nend;/)[1];
// Execute the production route decisions rather than duplicating their table.
function compileRead(body){
 let js=body.replace(/Result\s*:=\s*'';/,"let Result='';");
 js=js.replace(/\b(else\s+)?if\s+(.+?)\s+then\s+Result\s*:=\s*([^\n;]+);?/g,(_,otherwise,condition,value)=>{
  const expression=condition.replace(/\.StartsWith\(/g,'.startsWith(').replace(/<>/g,'!==').replace(/(?<!!)=/g,'===').replace(/\bor\b/g,'||').replace(/\band\b/g,'&&');
  return `${otherwise?'else ':''}if (${expression}) Result=${value};`;
 });
 return new Function('FHubView','HubCasinoView',js+'\nreturn Result;');
}
const originalGames=new Set(['crash','dice','mines','plinko','limbo','hilo','tower']);
function verify(fn){
 const expected={news:'news',catalog:'catalog',feed:'feed',me:'me',all:'menu',
  playground:'',casino:'',original:'',attendance:'rewards',events:'rewards',wheel:'rewards',
  points:'rewards',notifications:'notifications',services:'history',activity:'activity','top.games':'topgames',
  orders:'me',payments:'me',profile:'me',charge:'charge',withdraw:'withdraw',
  baccarat:'arcade',roulette:'arcade',slots:'arcade',blackjack:'casino',
  settings:'preferences','settings.notifications':'preferences','settings.currency':'',
  policies:'policies',member:'member',follows:'follows',comments:'thread',
  badges:'badges',shop:'shop',bookmarks:'bookmarks',blocks:'blocks',popular:'popular',
  game:'product',article:'article',home:'',menu:''};
 for(const game of originalGames)expected[game]='casino';
 for(const game of ['dino','flappy','whack','dodge','rhythm'])expected['event.'+game]='rewards';
 for(const [view,action] of Object.entries(expected))assert.equal(fn(view,v=>originalGames.has(v)),action,view);
}
verify(compileRead(source));
assert.throws(()=>verify(compileRead(source.replace("FHubView='all' then Result:='menu'","FHubView='all' then Result:='home'"))),'removed Home API dependency is detected');
assert.throws(()=>verify(compileRead(source.replace("FHubView='attendance'","FHubView='removed-attendance'"))),'attendance access cannot disappear with Home');
assert.ok(!fs.existsSync(path.join(apk,'MoaPlayApp.Member.Home.inc')),'Home implementation must be deleted');
const app=read('MoaPlayApp.pas');
assert.doesNotMatch(app,/Member\.Home\.inc/);
for(const include of ['Playground','Activity','Rewards'])assert.match(app,new RegExp('Member\\.'+include+'\\.inc'));
const members=fs.readdirSync(apk).filter(name=>/^MoaPlayApp\.Member\..*\.inc$/.test(name)).map(read).join('\n');
assert.doesNotMatch(members,/HubRenderHome|HubHomeHeading|HubHomeTile|HubCached\('home'\)|FHubView\s*[=<>]+\s*'menu'|FHubMenuCategory|home\.event/);
assert.match(read('MoaPlayApp.Service.inc'),/FHubView := 'news'/,'service restart must not enter removed Home');
assert.match(flow,/else if FHubView='all' then HubRenderMenu\s+else if \(Action<>''\)/,'menu shell is available before its counter response');
for(const [view,index] of [['news',0],['catalog',1],['feed',2],['me',3]])
 assert.match(actions,new RegExp("ReturnView='"+view+"' then FDashboardActiveTab:="+index),'menu tab navigation '+view);
assert.match(actions,/FDashboardActiveTab:=2;HubNavigate\('feed'\)/,'popular shortcut activates feed');
assert.match(flow,/FDashboardActiveTab:=2;HubNavigate\('feed'\)/,'repost returns to feed');
assert.match(read('MoaPlayApp.Member.Settings.inc'),/FDashboardActiveTab:=0;HubNavigate\('news'/,'news settings use first tab');
assert.match(read('MoaPlayApp.Member.Media.inc'),/FDashboardActiveTab=3/,'avatar selection uses fourth tab');
const menu=read('MoaPlayApp.Member.Menu.inc');
for(const route of ['attendance','notifications','events','playground','charge','points','orders','payments'])assert.ok(menu.includes("'"+route+"'"),route+' remains directly accessible');
console.log('FIX63 NATIVE ROUTES PASS: production read decisions, no Home code/API, independent feature access, menu shell, four-tab links and service reset.');
