'use strict';
const s=require('./store'),commerce=require('./commerce'),social=require('./social'),coins=require('./coins');
const KIND={products:'product',news:'news',posts:'post',comments:'comment',profiles:'profile'};
function Filter(rows,body){
    const query=String(body.q||'').trim().toLocaleLowerCase('ko-KR'),status=body.status||'';
    return rows.filter(row=>{
        if(body.id&&row.id!==body.id)return false;
        if(query&&!JSON.stringify(row).toLocaleLowerCase('ko-KR').includes(query))return false;
        if(body.category&&row.category!==body.category&&row.accessType!==body.category&&row.symbol!==body.category)return false;
        if(status==='deleted')return !!row.deleted;
        if(status==='active')return !row.deleted&&!row.hidden&&row.enabled!==false&&(row.published===undefined||row.published);
        if(status==='draft')return !row.deleted&&(row.published===false||row.enabled===false);
        if(status==='hidden')return !row.deleted&&!!row.hidden;
        return !status||row.status===status;
    });
}
function Counter(row){
    const db=s.DB(),tables={product:'products',news:'news',post:'posts',comment:'comments'};
    const content=tables[row.kind]?db[tables[row.kind]][row.id]:row.kind==='profile'?s.ProfileById(row.id):null;
    return {...row,title:content?.title||content?.nickname||content?.body?.slice(0,60)||row.id};
}
function Read(body={}){
    const db=s.DB(),view=body.view||'overview';
    const table={products:()=>Object.values(db.products),coins:()=>Object.values(db.coins),news:()=>Object.values(db.news),orders:()=>Object.values(db.orders).map(commerce.PublicOrder),topups:()=>Object.values(db.topups),ledger:()=>Object.values(db.ledger),profiles:()=>Object.values(db.profiles).map(p=>({...s.PublicProfile(p,true),blocked:p.blocked})),posts:()=>Object.values(db.posts).map(post=>({...post,author:social.Author(post.accountId)})),comments:()=>Object.values(db.comments).map(c=>({...c,author:social.Author(c.accountId)})),reports:()=>Object.values(db.reports),analytics:()=>Object.values(db.viewCounters).map(Counter)};
    const settings={...db.settings,coins:coins.List()};
    if(table[view]){
        const rows=Filter(table[view](),body).map(row=>({...row,...(KIND[view]?{views:s.ViewCount(KIND[view],row.id)}:{})}));
        rows.sort(body.sort==='views'?(a,b)=>(b.views||b.count||0)-(a.views||a.count||0):(a,b)=>(b.updatedAt||b.at||b.createdAt||0)-(a.updatedAt||a.at||a.createdAt||0));
        return {...s.Page(rows,body,50),settings};
    }
    const ledger=Object.values(db.ledger),top=Object.values(db.viewCounters).sort((a,b)=>b.count-a.count);
    return {settings,products:Object.values(db.products).filter(p=>!p.deleted&&p.published).length,members:Object.values(db.profiles).length,
        pendingTopups:Object.values(db.topups).filter(x=>x.status==='PENDING').length,pendingAmount:Object.values(db.topups).filter(x=>x.status==='PENDING').reduce((a,x)=>a+x.amount,0),
        orders:Object.values(db.orders).length,openReports:Object.values(db.reports).filter(x=>x.status==='OPEN').length,
        totalTopup:ledger.filter(x=>x.kind==='TOPUP').reduce((a,x)=>a+x.amount,0),netSales:-ledger.filter(x=>x.kind==='PURCHASE'||x.kind==='REFUND').reduce((a,x)=>a+x.amount,0),
        pageViews:top.filter(x=>x.kind==='screen').reduce((a,x)=>a+x.count,0),topContent:top.filter(x=>x.kind!=='screen').slice(0,5).map(Counter),coins:coins.List().length};
}
function Content(body,actor){
    const table=body.table,action=body.operation;
    if(!['products','news','posts','comments','coins'].includes(table)||!['delete','restore','publish','unpublish','hide','show'].includes(action))s.Fail('CONTENT_ACTION_INVALID');
    const ids=[...new Set(Array.isArray(body.ids)?body.ids:[body.id])];
    if(!ids.length||ids.length>100||ids.some(id=>typeof id!=='string'||!s.DB()[table][id]))s.Fail('CONTENT_NOT_FOUND');
    return s.Atomic(()=>{
        for(const id of ids){
            const row=s.DB()[table][id];
            if(action==='restore'&&(row.deletedByMember||(['posts','comments'].includes(table)&&!row.body)))s.Fail('CONTENT_RESTORE_UNAVAILABLE');
            if(action==='delete'){row.deleted=true;if('published'in row)row.published=false;if('enabled'in row)row.enabled=false;}
            else if(action==='restore'){row.deleted=false;}
            else if(action==='publish'||action==='unpublish'){if(!['products','news'].includes(table)||row.deleted)s.Fail('CONTENT_ACTION_INVALID');row.published=action==='publish';}
            else {if(!['posts','comments'].includes(table)||row.deleted)s.Fail('CONTENT_ACTION_INVALID');row.hidden=action==='hide';}
            row.updatedAt=Date.now();row.updatedBy=actor;row.revision=(row.revision||0)+1;
        }
        return {count:ids.length,ids};
    });
}
function Write(action,body,actor){
    if(action==='product.save')return commerce.SaveProduct(body);
    if(action==='news.save')return social.SaveNews(body);
    if(action==='coin.save')return coins.Save(body);
    if(action==='content.action')return Content(body,actor);
    if(action==='topup.decide')return commerce.DecideTopup(body,actor);
    if(action==='order.refund')return commerce.Refund(body,actor);
    return s.Atomic(()=>{
        const db=s.DB();
        if(action==='settings.save'){db.settings={...db.settings,topupEnabled:body.topupEnabled===true,topupInstructions:s.Text(body.topupInstructions,1000,true)};return db.settings;}
        if(action==='profile.block'||action==='profile.save'){
            const p=s.ProfileById(body.id);if(!p)s.Fail('ACCOUNT_REQUIRED');
            if(action==='profile.block')p.blocked=body.blocked===true;else social.SaveProfile(p,body);
            return {...s.PublicProfile(p,true),blocked:p.blocked};
        }
        if(action==='post.moderate'||action==='comment.moderate'||action==='post.save'||action==='comment.save'){
            const row=db[action.startsWith('post.')?'posts':'comments'][body.id];if(!row||row.deleted)s.Fail('POST_NOT_FOUND');
            if(body.revision!==undefined&&body.revision!==(row.revision||0))s.Fail('CONTENT_CHANGED');
            if(action.endsWith('.save'))row.body=s.Text(body.body,action.startsWith('post.')?2000:600,true);else row.hidden=body.hidden===true;
            row.moderatedBy=actor;row.updatedAt=Date.now();row.revision=(row.revision||0)+1;return row;
        }
        if(action==='report.resolve'||action==='report.reopen'){
            const row=Object.values(db.reports).find(x=>x.id===body.id);if(!row)s.Fail('POST_NOT_FOUND');row.status=action==='report.resolve'?'RESOLVED':'OPEN';row.resolvedBy=actor;row.resolution=s.Text(body.resolution,500);return row;
        }
        if(action==='topup.reopen'){
            const row=db.topups[body.id];if(!row||!['REJECTED','CANCELED'].includes(row.status))s.Fail('TOPUP_ALREADY_PROCESSED');
            row.previousDecisions=[...(row.previousDecisions||[]),{status:row.status,reason:row.reason,processedAt:row.processedAt}];
            row.status='PENDING';row.reason='';row.processedAt=0;row.processedBy='';return row;
        }
        s.Fail('UNKNOWN_ACTION');
    });
}
module.exports={Read,Write};
