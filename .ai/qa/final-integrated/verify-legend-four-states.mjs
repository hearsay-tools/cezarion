import {readFileSync,writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {resolve} from 'node:path';
const out=resolve('.ai/qa/final-integrated'),q=resolve('.ai/qa/runtime-verified'),base='http://127.0.0.1:44786';
const cli=(...args)=>execFileSync(q+'/browser.sh',args,{env:{...process.env,RUNTIME_BROWSER_SESSION:'final-legend-86'},encoding:'utf8',maxBuffer:8e6}).trim();
const get=s=>JSON.parse(JSON.parse(cli('eval','JSON.stringify('+s+')')));
const mocks=JSON.parse(readFileSync(q+'/mock-api.json')).mocks;
for(const mock of mocks.filter(x=>x.path.includes('automation')))for(const scope of ['/api/v1','/api/v1/p/default','/api/v1/p/fixture-repo-v2'])cli('network','route',base+scope+mock.path,'--body',JSON.stringify(mock.body));
const rows=JSON.parse(readFileSync(out+'/coverage-193.json')).filter(r=>['UFERI','Jn0Bt','YVkaw','Itxee'].includes(r.id));const evidence=[];
for(const row of rows){cli('set','viewport',String(row.width),String(row.height));cli('open',base+row.route);cli('eval',`localStorage.setItem('cez-theme','${row.theme}');location.reload()`);cli('wait','700');
 const facts=get(`(()=>{const legend=[...document.querySelectorAll('legend')].find(x=>x.textContent==='Review and enable');if(!legend)throw Error('Missing accessible legend');return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,legendText:legend.textContent,fieldsetPosition:getComputedStyle(legend.parentElement).position,legendPosition:getComputedStyle(legend).position,legendRight:legend.getBoundingClientRect().right,legendHidden:legend.hidden,fieldsetDisplay:getComputedStyle(legend.parentElement).display}})()`);
 if(facts.scrollWidth!==row.width||facts.fieldsetPosition!=='relative'||facts.legendHidden)throw Error(JSON.stringify(facts));
 const before=get(`(()=>{const legend=[...document.querySelectorAll('legend')].find(x=>x.textContent==='Review and enable');legend.parentElement.classList.remove('relative');return {scrollWidth:document.documentElement.scrollWidth,legendRight:legend.getBoundingClientRect().right}})()`);
 cli('eval',`[...document.querySelectorAll('legend')].find(x=>x.textContent==='Review and enable').parentElement.classList.add('relative')`);
 if(before.scrollWidth<=row.width)throw Error('Old positioning did not reproduce overflow: '+JSON.stringify(before));
 const image=out+'/pairs/legend-final-'+row.id+'.png';cli('screenshot',image);evidence.push({id:row.id,theme:row.theme,height:row.height,image,facts,counterfactualWithoutContainment:before,sourceCommit:'c74141b3',fixCommit:'8ec8fdbc',disclosure:'Existing contract fixture response only; no save or enable action.'});console.log(row.id,facts);
}
writeFileSync(out+'/legend-four-state-proof.json',JSON.stringify(evidence,null,2)+'\n');cli('close');
