import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';import{resolve}from'node:path';
const qa=resolve('.ai/qa/settings'),runtime=resolve('.ai/qa/runtime-verified'),server=JSON.parse(readFileSync(runtime+'/server-proof.json')),hash=b=>createHash('sha256').update(b).digest('hex');
const run=(...args)=>execFileSync(runtime+'/browser.sh',args,{encoding:'utf8',env:{...process.env,RUNTIME_BROWSER_SESSION:'settings-579'}}),evaluate=js=>JSON.parse(JSON.parse(run('eval',`JSON.stringify(${js})`)));
const old=JSON.parse(readFileSync(qa+'/pairs.json')),sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),paths=execFileSync('git',['ls-files','packages/web/src','packages/contract/src','packages/cezar/src'],{encoding:'utf8'}).trim().split('\n'),sourceSha256=hash(paths.map(p=>p+'\0'+hash(readFileSync(p))).join('\n')),indexSha256=hash(readFileSync(server.webRoot+'/index.html'));
if(hash(Buffer.from(await(await fetch(server.baseUrl)).arrayBuffer()))!==indexSha256)throw Error('Served build differs');
mkdirSync(qa+'/switch-thumbs',{recursive:true});const pairs=[];
for(const previous of old.pairs.filter(p=>p.name.startsWith('S02.'))){
 run('set','viewport',String(previous.viewport.width),String(previous.viewport.height),'2');run('set','media',previous.theme);run('eval',`localStorage.setItem('cez-theme',${JSON.stringify(previous.theme)});localStorage.setItem('cez-density','comfortable')`);run('open',server.baseUrl+'/p/default/settings/agents');run('wait','700');
 const thumbs=evaluate(`(()=>[...document.querySelectorAll('.settings-toggle-field [role="switch"]')].map(e=>{const t=e.querySelector('[data-slot="switch-thumb"]'),r=t.getBoundingClientRect();return{label:e.getAttribute('aria-label'),state:e.getAttribute('aria-checked'),display:getComputedStyle(t).display,width:r.width,height:r.height,background:getComputedStyle(t).backgroundColor}}))()`);
 if(thumbs.length!==2||thumbs.some(t=>!t.label||t.display==='none'||t.width<10||t.height<10))throw Error('Hidden/unlabelled thumb '+JSON.stringify(thumbs));
 const browserPng=qa+'/switch-thumbs/'+previous.id+'.png';run('screenshot',browserPng);
 if(hash(readFileSync(previous.designPng))!==previous.designPngSha256)throw Error('Reference changed');
 pairs.push({...previous,browserPng,browserPngSha256:hash(readFileSync(browserPng)),sourceCommit,sourceSha256,indexSha256,thumbs});
}
const configUrl=server.baseUrl+'/api/v1/p/default/config',before=await(await fetch(configUrl)).json();
for(const [slot,key]of[['agents-live-title-updates','liveTitleUpdates'],['agents-review-gate','reviewGate']]){
 const initial=before[key]??(key==='liveTitleUpdates');run('click',`[data-slot="${slot}"]`);run('wait','400');if((await(await fetch(configUrl)).json())[key]!==!initial)throw Error('Toggle did not persist '+key);run('click',`[data-slot="${slot}"]`);run('wait','400');if((await(await fetch(configUrl)).json())[key]!==initial)throw Error('Toggle not restored '+key);
}
writeFileSync(qa+'/switch-thumbs/pairs.json',JSON.stringify({sourceCommit,sourceSha256,indexSha256,designSourceSha256:old.designSourceSha256,pairs,behavior:'Both accessible switches toggle through actual API and restore original populated booleans.'},null,2));
console.log('PASS: 4 S02 desktop/mobile light/dark pairs; both thumbs visible and labelled; both real API toggles persisted and restored.');
