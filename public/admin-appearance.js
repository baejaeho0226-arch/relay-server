'use strict';
// Apply before first paint; a blocked preference store still permits switching.
function setAdminTheme(theme){
 const selected=theme==='dark'?'dark':'light';
 document.documentElement.dataset.theme=selected;
 document.documentElement.style.colorScheme=selected;
 try{localStorage.setItem('relay-admin-theme',selected);}catch(_){}
 const button=document.getElementById('theme-toggle');
 if(button){button.textContent=selected==='dark'?'라이트 모드':'다크 모드';button.setAttribute('aria-pressed',String(selected==='dark'));}
}
let initialAdminTheme='light';try{initialAdminTheme=localStorage.getItem('relay-admin-theme')||'light';}catch(_){}
setAdminTheme(initialAdminTheme);
document.addEventListener('DOMContentLoaded',()=>setAdminTheme(document.documentElement.dataset.theme));
document.addEventListener('click',event=>{if(event.target.closest('#theme-toggle'))setAdminTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');});
