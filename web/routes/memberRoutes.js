'use strict';
const member=require('../../services/member/service');
const {RequireAdmin,Json,ApiError}=require('../apiContext');
async function Handle({method,pathname,url,body,res,session}){
 if(pathname!=='/api/member'&&pathname!=='/api/member/action')return false;
 if(!RequireAdmin(res,session))return true;
 try{
  if(method==='GET'&&pathname==='/api/member'){Json(res,200,{ok:true,...member.AdminRead(Object.fromEntries(url.searchParams))});return true;}
  if(method==='POST'&&pathname==='/api/member/action'){
   const result=member.AdminWrite(body.action,body,String(session.role||'ADMIN')+':'+String(session.id||''));
   require('../../storage/audit').LogEvent('MEMBER_ADMIN_ACTION',String(body.action)+' '+String(result?.id||''));
   Json(res,200,{ok:true,result});return true;
  }
  ApiError(res,405,'METHOD_NOT_ALLOWED');
 }catch(e){const reason=e.memberError?e.message:'INPUT_INVALID';Json(res,reason==='STORAGE_SAVE_FAILED'?503:400,{ok:false,error:reason,message:member.messages[reason]||'입력 내용을 확인해주세요.'});}
 return true;
}
module.exports={Handle};
