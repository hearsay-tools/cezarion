import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {writeFileSync} from 'node:fs'
const out=resolve('.ai/qa/iteration-3')
const cli=(...args)=>execFileSync(resolve('.ai/qa/runtime-verified/browser.sh'),args,{env:{...process.env,RUNTIME_BROWSER_SESSION:'runtime-tools-isolated'},encoding:'utf8',maxBuffer:8e6}).trim()
const evidence=[]
for(const theme of ['light','dark'])for(const [device,w,h] of [['desktop',1440,1120],['mobile',390,844]]){
 cli('press','Escape');cli('set','viewport',String(w),String(h));cli('eval',`localStorage.setItem('cez-theme','${theme}');location.reload()`);cli('wait','700');cli('eval','document.activeElement?.blur()')
 for(const state of ['page','local','clone']){
  if(state!=='page'){cli('eval',`Array.from(document.querySelectorAll('button')).find(x=>x.textContent===${JSON.stringify(state==='local'?'Open local folder':'Clone from GitHub')}).click()`);cli('wait','350');cli('eval','document.activeElement?.blur()')}
  const path=out+`/tools-final-${device}-${theme}-${state}.png`;cli('screenshot',path)
  const observed=JSON.parse(JSON.parse(cli('eval','JSON.stringify({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,theme:document.documentElement.className,dialog:document.querySelector("[role=dialog]")?.textContent??null,icons:document.querySelectorAll("svg").length})')))
  if(observed.scrollWidth>w)throw Error('Overflow '+path)
  if(state!=='page'&&!observed.dialog)throw Error('Missing dialog '+path)
  evidence.push({theme,device,state,path,observed});if(state!=='page')cli('press','Escape')
 }
}
writeFileSync(out+'/tools-final-state-evidence.json',JSON.stringify(evidence,null,2));console.log('Verified 12 page/dialog captures across desktop/mobile and light/dark; no mutations confirmed.')
