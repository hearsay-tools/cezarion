import {readFileSync,writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';import{resolve}from'node:path';
const qa=resolve('.ai/qa/runtime-verified'),out=resolve('.ai/qa/settings'),proof=JSON.parse(readFileSync(qa+'/server-proof.json'));
const run=(...args)=>execFileSync(qa+'/browser.sh',args,{encoding:'utf8',env:{...process.env,RUNTIME_BROWSER_SESSION:'settings-579'}});
const observed=[];
for(const dark of [false,true]){
 run('set','viewport','320','844','2');run('set','media',dark?'dark':'light');run('eval',`localStorage.setItem('cez-theme','${dark?'dark':'light'}')`);
 for(const kind of ['template','tags']){
  run('open',proof.baseUrl+(kind==='template'?'/p/default/settings/prompt-templates':'/settings/global/projects'));run('wait','650');
  run('click',kind==='template'?'[data-slot="prompt-template-row"] [data-slot="prompt-template-skills-trigger"]':'[data-project="website"] [data-slot="project-tag-input"]');run('wait','400');
  const selector=kind==='template'?'[data-slot="popover-content"]':'[data-slot="project-tag-suggestions"]';
  const state=JSON.parse(JSON.parse(run('eval',`JSON.stringify((()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Popover absent');const r=e.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,viewport:innerWidth,documentWidth:document.documentElement.scrollWidth}})())`)));
  if(state.left<0||state.right>state.viewport+1||state.documentWidth>state.viewport)throw Error('Popover overflow '+JSON.stringify(state));
  run('screenshot',out+`/controls-${kind}-${dark?'dark':'light'}.png`);observed.push({kind,theme:dark?'dark':'light',...state});run('press','Escape');
 }
}
writeFileSync(out+'/controls-smoke-proof.json',JSON.stringify({sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),observed,disclosure:'Actual narrow-viewport browser interactions; opens and dismisses existing popovers without selecting skills or changing tags. Supplementary checks, not replacements for the 52 design pairs.'},null,2));console.log('PASS: template skill and project tag popovers fit320px in both themes.');
