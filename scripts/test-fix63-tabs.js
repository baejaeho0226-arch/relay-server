'use strict';
// Execute the dashboard's layout expressions: this checks native navigation
// bounds and hit areas, not Android rendering or Delphi compilation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const apk=path.resolve(__dirname,'../../MoaPlayApp_Android64');
const read=name=>fs.readFileSync(path.join(apk,name),'utf8').replace(/^\uFEFF/,'');
function between(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
function expression(text,scope){
 assert.match(text,/^[\w\s.+*/(),-]+$/);
 const js=text.replace(/\bMin\(/g,'Math.min(').replace(/\bMax\(/g,'Math.max(');
 return Function(...Object.keys(scope),'return '+js)(...Object.values(scope));
}
function assignment(source,name,scope){const m=source.match(new RegExp('\\b'+name+':=([^;]+);'));assert.ok(m,name);return expression(m[1],scope);}
function bounds(source,name,scope){
 const m=source.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\.SetBounds\\(([^;]+)\\);'));assert.ok(m,name);
 let level=0,start=0;const args=[];
 for(let i=0;i<m[1].length;i++){const c=m[1][i];if(c==='(')level++;if(c===')')level--;if(c===','&&level===0){args.push(m[1].slice(start,i));start=i+1;}}
 args.push(m[1].slice(start));assert.equal(args.length,4,name);
 return args.map(arg=>expression(arg,scope));
}
function checkNavigation(dashboard,theme){
 const root=between(dashboard,'function HubRootView','procedure TMoaPlayForm.BuildDashboardUI');
 const routes=[...root.matchAll(/(?:\d+:|else)\s*Result:='([^']+)'/g)].map(m=>m[1]);
 assert.deepEqual(routes,['news','catalog','feed','me']);
 assert.doesNotMatch(dashboard+theme,/nav-selection/,'no selected enclosure is constructed or recolored');
 assert.doesNotMatch(dashboard,/'home'|'menu'|\[4\]|to 4 do|I<>4|FDashboardActiveTab=4/,'no deleted tab or fifth index');
 assert.match(dashboard,/FDashboardTabs\[I\]\.Fill\.Kind:=TBrushKind.None/);
 assert.match(theme,/Tab.Fill.Kind:=TBrushKind.None;Tab.Stroke.Kind:=TBrushKind.None/);
 assert.match(dashboard,/NewTab:=EnsureRange\(Integer\(TControl\(Sender\)\.Tag\),0,3\)/);
 assert.match(dashboard,/FDashboardActiveTab:=EnsureRange\(FDashboardActiveTab,0,3\)/);
 assert.match(dashboard,/FHubTabAvatar.Parent:=FDashboardTabs\[3\]/);
 assert.match(dashboard,/FDashboardActiveTab:=0;HubNavigate\('news'\)/,'hardware back returns to the surviving first tab');
 assert.match(dashboard,/Pulse:=1\+Sin\(Progress\*Pi\)\*0.07/,'existing icon pulse is preserved');
 assert.match(dashboard,/FHubView := 'news'/,'first authorized frame is news');
 assert.match(dashboard,/FDashboardTabsCard.XRadius:=32;FDashboardTabsCard.YRadius:=32/);
 assert.match(dashboard,/if \(FSupportKeyboardTop>0\) and \(\(FHubView='comments'\) or \(FHubView='compose'\) or \(FHubView='editpost'\)\) then BottomHeight:=0/,'keyboard keeps native composers unobstructed');
}
function Check(){
 const dashboard=read('MoaPlayApp.Dashboard.inc'),theme=read('MoaPlayApp.Theme.inc');checkNavigation(dashboard,theme);
 const layout=between(dashboard,'procedure TMoaPlayForm.ResizeDashboardUI;','procedure TMoaPlayForm.HubUpdateHeader;');
 const cardSource=layout.slice(layout.indexOf('FDashboardTabsCard.SetBounds'));
 let count=0;
 for(const W of [240,280,320,360,393,412,480,600,800,1024,1440])for(const H of [320,480,640,800,1280])for(const ComposerHeight of [0,92,124]){
  const scope={W,H,ComposerHeight};
  for(const key of ['BarH','BarBottom','BarW','BottomHeight'])scope[key]=assignment(layout,key,scope);
  scope.TabW=assignment(cardSource,'TabW',scope);
  const bar=bounds(cardSource,'FDashboardTabsCard',scope),scroll=bounds(layout,'FDashboardScroll',scope),composer=bounds(layout,'FHubCommentBar',scope);
  assert.ok(bar[0]>=16&&bar[0]+bar[2]<=W-16,'bar floats inside both client edges');
  assert.ok(bar[1]+bar[3]<=H-12,'bar clears the system-safe client bottom');
  assert.ok(scroll[1]+scroll[3]<=composer[1],'content cannot underlap a composer');
  assert.ok(composer[1]+composer[3]<=bar[1]-10,'content/composer reserves the capsule gap');
  for(let I=0;I<4;I++){
   const values={...scope,I},tab=bounds(cardSource,'FDashboardTabs[I]',values),icon=bounds(cardSource,'FDashboardIcons[I]',values),label=bounds(cardSource,'FDashboardTabLabels[I]',values);
   assert.ok(tab[2]>=48&&tab[3]>=48,'full-size touch targets survive narrow screens');
   assert.ok(tab[0]>=0&&tab[0]+tab[2]<=bar[2]+0.001,'all four tabs remain inside the bar');
   assert.ok(icon[0]>=0&&icon[0]+icon[2]<=tab[2],'icon is inside its hit target');
   assert.ok(icon[1]+icon[3]<=label[1]&&label[1]+label[3]<=tab[3],'icon and label do not overlap or spill');
  }
  // Keyboard mode consumes the original client area, without the hidden bar.
  scope.BottomHeight=0;const input=bounds(layout,'FHubCommentBar',scope);
  assert.equal(input[1]+input[3],H);count++;
 }
 const dock=read('MoaPlayApp.Member.GameWindow.inc');
 assert.match(dock,/FDashboardTabsCard.Visible then Bottom:=FDashboardTabsCard.Position.Y/,'floating tools track the actual new bar top');
 assert.match(layout,/SetMoaPlayMessageBottom\(FDashboardTabsCard.Position.Y\)/,'toasts remain above the bar');
 assert.throws(()=>checkNavigation(dashboard.replace("0: Result:='news'","0: Result:='menu'"),theme),'detect stale home navigation');
 assert.throws(()=>checkNavigation(dashboard+'\nnav-selection',theme),'detect selected enclosure regression');
 return count;
}
module.exports={Check};
if(require.main===module)console.log('FIX63 TABS PASS: four routes, no selection enclosure, preserved icon pulse, '+Check()+' floating/composer layouts, shared dock/toast bounds.');
