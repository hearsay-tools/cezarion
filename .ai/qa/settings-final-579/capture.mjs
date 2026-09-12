import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=process.cwd(),qa=resolve('.ai/qa/settings'),runtime=resolve('.ai/qa/runtime-verified');
const design=resolve('/home/agent/projects/cezar/.ai/cezar/worktrees/9ae05dcc-cc09-405c-9934-ab364076aa21/.ai/design-reference/iteration-3/design');
const manifest=JSON.parse(readFileSync(design+'/manifest.json'));
if(manifest.penFileSha256!=='56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8'||manifest.frameCount!==193)throw Error('Wrong design');
const frames=manifest.frames.filter(f=>/^S\d\d\./.test(f.name));
if(frames.length!==52)throw Error('Incomplete Settings reference');
const proof=JSON.parse(readFileSync(runtime+'/server-proof.json'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const run=(...args)=>execFileSync(runtime+'/browser.sh',args,{encoding:'utf8',env:{...process.env,RUNTIME_BROWSER_SESSION:'settings-579'}});
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const paths=execFileSync('git',['ls-files','packages/web/src','packages/contract/src','packages/cezar/src'],{encoding:'utf8'}).trim().split('\n');
const sourceSha256=hash(paths.map(p=>p+'\0'+hash(readFileSync(p))).join('\n'));
const indexSha256=hash(readFileSync(proof.webRoot+'/index.html'));
const servedIndexSha256=hash(Buffer.from(await(await fetch(proof.baseUrl)).arrayBuffer()));
if(indexSha256!==servedIndexSha256)throw Error('Wrong built frontend');
const sections={S01:'',S02:'agents',S03:'agent-config',S04:'worktrees',S05:'bookmarklets',S06:'prompt-templates',S07:'',S08:'appearance',S09:'notifications',S10:'resources',S11:'skills',S12:'accounts',S13:'projects'};
const sectionNotes={
S01:'Real fixture project name/path and registry dates; boot-project removal disabled by existing behavior. Shared shell/header differs.',
S02:'Real runner/account choices and per-field saves retained. Scoped violet actions, white switch thumbs and regular control labels follow the reference.',
S03:'Corrected primary three-file row uses only actual selected-agent files: CLAUDE.md, settings.json and MCP config for Claude. Scope/file actions and precedence remain visible below; Save requires a dirty file. No unsupported AGENTS.md shortcut is fabricated for Claude.',
S04:'Real fixture worktrees and sizes, with all existing delete/reclaim confirmation semantics. Row data/count differs from reference.',
S05:'Real scoped bookmarklets and fixture skill names; URL launch key remains scoped and never executes on click. Extra copy/drag help retained.',
S06:'One populated template and existing unsaved list-level save behavior retained. New/delete template changes remain drafts until Save.',
S07:'Global settings directory with real registry routes; shared shell/header differs.',
S08:'Actual single Cezarion accent; legacy Lime/Violet controls absent because current appearance supports one accent. Noninteractive preview reproduces sample treatment.',
S09:'Real browser denied notification permission with persisted enabled preference; no notifications sent.',
S10:'Populated limits, three-state inherited composer defaults, and explicit individual save controls retained. No invented combined Save limits behavior.',
S11:'Contract-validated browser fixture reports six current tracked skills. No skill installation/update executes. Real no-installation and inherited/default behavior remains covered by tests.',
S12:'Corrected compact installation/account readouts and action rows, selected personal account first, direct Rename/Remove with existing confirmation, opt-in identity details, one model editor with an explicit agent chooser. Synthetic login state disclosed; no fabricated authentication-progress event.',
S13:'Real two-project registry and scoped data. Folder saves remain independent and destructive removal remains disabled for boot project.'};
mkdirSync(qa+'/browser',{recursive:true});
const only=process.argv[2];
const previous=only?JSON.parse(readFileSync(qa+'/pairs.json')):null;
if(previous&&(previous.sourceCommit!==sourceCommit||previous.sourceSha256!==sourceSha256||previous.indexSha256!==indexSha256))throw Error('Cannot mix build provenance');
const pairs=previous?previous.pairs.filter(p=>!p.name.startsWith(only+'.')):[];
for(const frame of frames.filter(f=>!only||f.name.startsWith(only+'.'))){
 const key=frame.name.slice(0,3),section=sections[key],global=Number(key.slice(1))>=7,theme=frame.name.endsWith('dark')?'dark':'light';
 const path=(global?'/settings/global':'/p/default/settings')+(section?'/'+section:'');
 run('set','viewport',String(frame.width),String(frame.height),'2');
 run('set','media',theme);
 run('eval',`localStorage.setItem('cez-theme',${JSON.stringify(theme)});localStorage.setItem('cez-density','comfortable')`);
 run('open',proof.baseUrl+path);
 run('wait','800');
 if(key==='S03'){
  run('eval',`(()=>{const b=[...document.querySelectorAll('[data-slot="agent-config-shortcut"]')].find(b=>b.textContent.includes('MCP config'));if(!b)throw Error('MCP file absent');b.click()})()`);
  run('wait','400');
 }
 if(key==='S12') {run('click','[data-slot="accounts-tabs"] [data-provider="codex"]');run('wait','300');}
 const observed=JSON.parse(JSON.parse(run('eval',`JSON.stringify({url:location.href,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.classList.contains('light')?'light':'dark',density:document.documentElement.dataset.density??'comfortable',font:getComputedStyle(document.body).fontFamily,accountProvider:document.querySelector('[data-slot="accounts-tabs"] [data-state="active"]')?.dataset.provider,notificationPermission:document.querySelector('[data-slot="notifications-permission"]')?.textContent,loading:[...document.querySelectorAll('[data-slot$="-loading"]')].filter(e=>e.getClientRects().length).map(e=>e.dataset.slot),overflow:document.documentElement.scrollWidth>innerWidth})`)));
 if(observed.width!==frame.width||observed.height!==frame.height||observed.theme!==theme||observed.loading.length)throw Error(frame.id+' state mismatch '+JSON.stringify(observed));
 if(key==='S12' && observed.accountProvider!=='codex')throw Error('Wrong account tab');
 if(key==='S09' && !observed.notificationPermission?.includes('Blocked'))throw Error('Wrong permission state');
 const dest=qa+'/browser/'+frame.id+'.png';run('screenshot',dest);
 const ref=design+'/'+frame.screenshot;if(hash(readFileSync(ref))!==frame.pngSha256)throw Error('Reference changed');
 pairs.push({id:frame.id,name:frame.name,designPng:ref,browserPng:dest,designPngSha256:frame.pngSha256,browserPngSha256:hash(readFileSync(dest)),sourceCommit,sourceSha256,indexSha256,viewport:{width:frame.width,height:frame.height,dpr:2},theme,density:'comfortable',observed,notes:sectionNotes[key],acceptance:'Layout corrections compared with confirmed reference; behavior and data adaptations documented.'});
 writeFileSync(qa+'/pairs.json',JSON.stringify({designSourceSha256:manifest.penFileSha256,sourceCommit,sourceSha256,indexSha256,servedIndexSha256,pairs},null,2));
 console.log(`${pairs.length}/52 ${frame.id} ${frame.name}`);
}
pairs.sort((a,b)=>frames.findIndex(f=>f.id===a.id)-frames.findIndex(f=>f.id===b.id));
writeFileSync(qa+'/pairs.json',JSON.stringify({designSourceSha256:manifest.penFileSha256,sourceCommit,sourceSha256,indexSha256,servedIndexSha256,pairs},null,2));
if(pairs.length!==52)throw Error('Incomplete capture');
console.log('Captured all 52 matched Settings frame pairs');
