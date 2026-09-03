'use strict';

const center=require('../../services/productionCenter');
const privileged=require('../../services/privilegedApproval');
const passkeys=require('../../services/passkeyAuth');
const audit=require('../../storage/audit');

async function Handle(c){
    const {method,pathname,body,req,res,session,RequireAdmin,Json,ApiError}=c;
    if(method==='GET'&&pathname==='/api/production'){if(!RequireAdmin(res,session))return true;Json(res,200,{ok:true,...center.Overview(),passkeys:passkeys.List(),approvals:privileged.List(),dualApprovalRequired:require('../../core/state').production.deploymentManifest.dualApprovalRequired===true});return true;}
    if(method==='POST'&&pathname==='/api/production/config/dry-run'){if(!RequireAdmin(res,session))return true;const r=center.ConfigDryRun(body,session.id);if(!r.ok)ApiError(res,400,r.reason);else Json(res,200,r);return true;}
    if(method==='POST'&&pathname==='/api/production/config/apply'){if(!RequireAdmin(res,session))return true;const r=center.ApplyPlan(body.planId,session.id);if(!r.ok)ApiError(res,409,r.reason);else Json(res,200,r);return true;}
    if(method==='POST'&&pathname==='/api/production/transport'){if(!RequireAdmin(res,session))return true;const r=require('../../services/transportSecurity').SetPolicy(body,session.id);if(!r.ok)ApiError(res,409,r.reason);else Json(res,200,r);return true;}
    if(method==='POST'&&pathname==='/api/production/update/policy'){if(!RequireAdmin(res,session))return true;Json(res,200,require('../../services/updateSupervisor').SetPolicy(body,session.id));return true;}
    if(method==='POST'&&pathname==='/api/production/update/rollback'){if(!RequireAdmin(res,session))return true;const r=require('../../services/updateSupervisor').Rollback(body.type,body.channel,body.reason||'ADMIN_ROLLBACK');if(!r.ok)ApiError(res,409,r.reason);else Json(res,200,r);return true;}
    if(method==='POST'&&pathname==='/api/production/slo'){if(!RequireAdmin(res,session))return true;Json(res,200,center.SetSloPolicy(body,session.id));return true;}
    if(method==='POST'&&pathname==='/api/production/diagnostics'){if(!RequireAdmin(res,session))return true;const r=center.Diagnostics(body.type,body.id,session.id);if(!r.ok)ApiError(res,404,r.reason);else Json(res,200,r);return true;}
    if(method==='POST'&&pathname==='/api/production/recovery-drill'){if(!RequireAdmin(res,session))return true;Json(res,200,center.RecoveryDrill(session.id));return true;}
    if(method==='POST'&&pathname==='/api/production/retention'){if(!RequireAdmin(res,session))return true;Json(res,200,center.SetRetention(body,session.id));return true;}
    if(method==='POST'&&pathname==='/api/production/retention/apply'){if(!RequireAdmin(res,session))return true;Json(res,200,center.RetentionApply(session.id));return true;}
    if(method==='POST'&&pathname==='/api/production/supply-chain'){if(!RequireAdmin(res,session))return true;Json(res,200,center.SupplyChainManifest());return true;}
    if(method==='POST'&&pathname==='/api/production/chaos'){if(!RequireAdmin(res,session))return true;const r=center.ChaosRun(body.scenario,session.id);if(!r.ok)ApiError(res,400,r.reason);else Json(res,200,r);return true;}
    if(method==='POST'&&pathname==='/api/production/audit/verify'){if(!RequireAdmin(res,session))return true;Json(res,200,{ok:true,verification:audit.VerifyAuditChain()});return true;}
    if(method==='POST'&&pathname==='/api/production/incidents/resolve'){if(!RequireAdmin(res,session))return true;const r=require('../../services/incidentCenter').Resolve(body.id,session.id);if(!r.ok)ApiError(res,404,r.reason);else Json(res,200,r);return true;}
    if(method==='POST'&&pathname==='/api/production/dual-policy'){if(!RequireAdmin(res,session))return true;Json(res,200,privileged.SetRequired(body.required,session.id));return true;}
    if(method==='POST'&&pathname==='/api/production/approvals/request'){if(!RequireAdmin(res,session))return true;const r=privileged.Request(session,body.method,body.pathname,body.payload,body.note);if(!r.ok)ApiError(res,400,r.reason);else Json(res,200,r);return true;}
    if(method==='POST'&&pathname==='/api/production/approvals/approve'){if(!RequireAdmin(res,session))return true;const r=privileged.Approve(body.ticketId,session);if(!r.ok)ApiError(res,409,r.reason);else Json(res,200,r);return true;}
    if(method==='POST'&&pathname==='/api/production/passkeys/register/begin'){if(!RequireAdmin(res,session))return true;const r=passkeys.RegistrationBegin(session,req);if(!r.ok)ApiError(res,400,r.reason);else Json(res,200,r);return true;}
    if(method==='POST'&&pathname==='/api/production/passkeys/register/finish'){if(!RequireAdmin(res,session))return true;const r=passkeys.RegistrationFinish(session,req,body);if(!r.ok)ApiError(res,400,r.reason);else Json(res,200,r);return true;}
    if(method==='POST'&&pathname==='/api/production/passkeys/revoke'){if(!RequireAdmin(res,session))return true;const r=passkeys.Revoke(body.id,session.id);if(!r.ok)ApiError(res,404,r.reason);else Json(res,200,r);return true;}
    return false;
}
module.exports={Handle};
