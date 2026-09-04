'use strict';

const crypto = require('crypto');
const state = require('../core/state');
const { Now, SafeField } = require('../core/utils');

const PROTECTED = [
    /^\/api\/system\/service\/stop$/,
    /^\/api\/backups\/[^/]+\/(restore|delete)$/,
    /^\/api\/(servers|clients|licenses)\/[^/]+$/,
    /^\/api\/deleted-devices\/DEL-[0-9A-Fa-f]{24}\/restore$/,
    /^\/api\/registry\/reset$/,
    /^\/api\/(servers|clients)\/[^/]+\/(kick|disable)$/,
    /^\/api\/licenses\/bulk$/,
    /^\/api\/licenses\/[^/]+\/(reissue|delete)$/,
    /^\/api\/production\/(config\/apply|transport|retention\/apply|update\/rollback)$/,
    /^\/api\/production\/(dual-policy|passkeys\/revoke)$/
];

function Digest(method, path, body) {
    return crypto.createHash('sha256').update(`${String(method).toUpperCase()}|${path}|${JSON.stringify(body || {})}`).digest('hex').toUpperCase();
}
function Required(pathname) {
    return state.production.deploymentManifest.dualApprovalRequired === true && PROTECTED.some(re=>re.test(pathname));
}
function Request(session, method, pathname, body, note='') {
    if (!session || session.role !== 'admin') return {ok:false,reason:'ADMIN_REQUIRED'};
    const ticket={ticketId:`DUAL-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,method:String(method).toUpperCase(),pathname:String(pathname),payloadHash:Digest(method,pathname,body),note:SafeField(note).slice(0,200),status:'PENDING',requestedAt:Now(),requestedBy:session.id,approvedAt:0,approvedBy:'',expiresAt:Now()+10*60000,consumedAt:0};
    state.production.privilegedApprovals.set(ticket.ticketId,ticket);require('../storage/database').SaveDatabase();require('../storage/audit').LogEvent('DUAL_APPROVAL_REQUESTED',`${ticket.ticketId} / ${ticket.pathname}`);return {ok:true,ticket};
}
function Approve(ticketId,session){
    const item=state.production.privilegedApprovals.get(String(ticketId||'').toUpperCase());
    if(!item)return{ok:false,reason:'TICKET_NOT_FOUND'};if(item.expiresAt<=Now())return{ok:false,reason:'TICKET_EXPIRED'};if(item.status!=='PENDING')return{ok:false,reason:`TICKET_${item.status}`};if(!session||session.role!=='admin')return{ok:false,reason:'ADMIN_REQUIRED'};if(item.requestedBy===session.id)return{ok:false,reason:'SECOND_ADMIN_SESSION_REQUIRED'};
    item.status='APPROVED';item.approvedAt=Now();item.approvedBy=session.id;require('../storage/database').SaveDatabase();require('../storage/audit').LogEvent('DUAL_APPROVAL_GRANTED',`${item.ticketId} / ${item.approvedBy}`);return{ok:true,ticket:item};
}
function Consume(ticketId,session,method,pathname,body){
    const hash=Digest(method,pathname,body);
    let item=state.production.privilegedApprovals.get(String(ticketId||'').toUpperCase());
    if(!item&&session)item=Array.from(state.production.privilegedApprovals.values()).find(x=>x.status==='APPROVED'&&x.requestedBy===session.id&&x.payloadHash===hash);
    if(!item)return{ok:false,reason:'DUAL_APPROVAL_REQUIRED'};if(item.status!=='APPROVED')return{ok:false,reason:`TICKET_${item.status}`};if(item.expiresAt<=Now())return{ok:false,reason:'TICKET_EXPIRED'};if(!session||session.role!=='admin')return{ok:false,reason:'ADMIN_REQUIRED'};if(item.payloadHash!==Digest(method,pathname,body))return{ok:false,reason:'TICKET_PAYLOAD_MISMATCH'};
    item.status='CONSUMED';item.consumedAt=Now();item.consumedBy=session.id;require('../storage/database').SaveDatabase();require('../storage/audit').LogEvent('DUAL_APPROVAL_CONSUMED',`${item.ticketId} / ${pathname}`);return{ok:true,ticket:item};
}
function SetRequired(value,actor){state.production.deploymentManifest.dualApprovalRequired=!!value;state.production.deploymentManifest.updatedAt=Now();state.production.deploymentManifest.updatedBy=SafeField(actor).slice(0,64);require('../storage/database').SaveDatabase();return{ok:true,required:!!value};}
function List(){const now=Now();for(const item of state.production.privilegedApprovals.values())if(item.status==='PENDING'&&item.expiresAt<=now)item.status='EXPIRED';return Array.from(state.production.privilegedApprovals.values()).sort((a,b)=>b.requestedAt-a.requestedAt).slice(0,200);}

module.exports={Digest,Required,Request,Approve,Consume,SetRequired,List};
