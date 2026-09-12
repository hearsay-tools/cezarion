import {readFileSync,writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {resolve} from 'node:path';
const out=resolve('.ai/qa/final-integrated'),qa=resolve('.ai/qa/runtime-verified');const cli=(...a)=>execFileSync(qa+'/browser.sh',a,{env:{...process.env,RUNTIME_BROWSER_SESSION:'final-plan-86'},encoding:'utf8',maxBuffer:8e6}).trim();
const get=s=>JSON.parse(JSON.parse(cli('eval','JSON.stringify('+s+')'))),records=[];
cli('set','viewport','1440','1100');cli('wait','500');
cli('eval',`window.confirmationOriginalFetch ??= window.fetch; window.fetch = async (...args) => String(args[0]).endsWith('/workflows') && args[1]?.method === 'POST' ? new Response(JSON.stringify({error:'A workflow with this name already exists',exists:true}),{status:409,headers:{'content-type':'application/json'}}) : window.confirmationOriginalFetch(...args)`);
for(const theme of ['light','dark']){
 cli('eval',`document.documentElement.classList.toggle('light',${theme==='light'});document.documentElement.classList.toggle('dark',${theme==='dark'})`);
 cli('click','[data-slot="plan-save"]');cli('wait','400');cli('fill','#plan-chain-name','fix-and-verify-v2');cli('wait','200');
 for(const state of ['save-as-chain','overwrite-chain']){
  if(state==='overwrite-chain'){cli('eval',`document.querySelector('[data-slot="plan-save-dialog"] form').requestSubmit()`);cli('wait','400');}
  const selector=state==='overwrite-chain'?'[data-slot="plan-overwrite-dialog"]':'[data-slot="plan-save-dialog"]';const observed=get(`({text:document.querySelector('${selector}')?.innerText,url:location.href})`);if(!observed.text)throw Error('Missing '+state);
  const image=out+'/pairs/confirm-'+state+'-'+theme+'.png';cli('screenshot',image);records.push({state,theme,image,observed,fixture:'Real Plan UI; schema-valid generated plan fixture; POST workflows intercepted with409; no workflow saved or overwritten'});console.log(state,theme);
 }
 cli('press','Escape');cli('wait','200');cli('press','Escape');cli('wait','200');
}
cli('eval','window.fetch=window.confirmationOriginalFetch');writeFileSync(out+'/plan-confirmation-evidence.json',JSON.stringify(records,null,2));
