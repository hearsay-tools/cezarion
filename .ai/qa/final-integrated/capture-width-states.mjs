import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const out=resolve('.ai/qa/final-integrated'),q=resolve('.ai/qa/runtime-verified'),base='http://127.0.0.1:44786';
const cli=(...a)=>execFileSync(q+'/browser.sh',a,{env:{...process.env,RUNTIME_BROWSER_SESSION:'final-ready-86'},encoding:'utf8',maxBuffer:8e6}).trim();
const js=(s)=>cli('eval',s),get=(s)=>JSON.parse(JSON.parse(js('JSON.stringify('+s+')')));
const rows=JSON.parse(readFileSync(out+'/coverage-193.json')),records=[];
for(const [id,width] of [['pg6Nc',280],['ZhYVg',280],['Gg8yJ',360],['gW5PQ',360],['CEQfL',520],['vETJh',520]]){
 const r=rows.find(r=>r.id===id);cli('set','viewport','1440','1900');cli('open',base+'/p/default/github/issues/219');cli('wait','500');
 js(`localStorage.setItem('cez-github-list-width','${width}');localStorage.setItem('cez-theme','${r.theme}');location.reload()`);cli('wait','1000');js('document.fonts.ready');
 const facts=get(`({url:location.href,width:document.querySelector('[data-slot="gh-list"]')?.getBoundingClientRect().width,separator:document.querySelector('[data-slot="gh-list-resize-handle"]')?.getAttribute('aria-valuenow'),selected:document.querySelector('[data-slot="gh-detail-inner"]')?.innerText,overflow:document.documentElement.scrollWidth>innerWidth,theme:document.documentElement.className})`);
 if(facts.width!==width||!facts.selected||facts.overflow)throw Error(JSON.stringify(facts));
 const file=out+'/browser/'+id+'.png';cli('screenshot',file);r.currentBrowser=file;r.currentBrowserSha256=createHash('sha256').update(readFileSync(file)).digest('hex');r.auditStatus='current width specimen captured; independent pair review pending';r.sourceQualification='e730bd7f plus NewTask thumb/ViewYAML corrections; real app with contract-valid GitHub browser fixture. Browser local width preference, no GitHub mutation.';
 records.push({id,width,observed:facts,image:file});console.log(id,JSON.stringify(facts));
}
writeFileSync(out+'/github-width-current.json',JSON.stringify(records,null,2));writeFileSync(out+'/coverage-193.json',JSON.stringify(rows,null,2));
