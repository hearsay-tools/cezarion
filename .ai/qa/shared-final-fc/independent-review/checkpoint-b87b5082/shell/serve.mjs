import {existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=resolve(process.argv[2]??'.');
const qa=resolve(source,'.ai/qa/runtime-verified/independent-review/shell');
const repo=resolve(qa,'repos/iac');
mkdirSync(repo+'/.ai/cezar/runs',{recursive:true});
const git=(...a)=>execFileSync('git',['-C',repo,...a],{env:{PATH:process.env.PATH}});
if(!existsSync(repo+'/.git')){git('init','-q','-b','main');git('config','user.email','fixture@example.test');git('config','user.name','QA Fixture');writeFileSync(repo+'/README.md','# Cezarion fixture\n');writeFileSync(repo+'/.gitignore','.ai/\n.local/\n');git('add','README.md','.gitignore');git('commit','-qm','Initialize fixture');git('branch','feature/runtime-audit');}
if(!existsSync(repo+'/src/session.ts')){mkdirSync(repo+'/src',{recursive:true});writeFileSync(repo+'/src/session.ts','export const title = "Task";\n');git('add','src/session.ts');git('commit','-qm','Add session module');git('checkout','-qb','task-fixture');writeFileSync(repo+'/src/session.ts','export const title = "Session";\nexport const keyboard = true;\n');git('add','src/session.ts');git('commit','-qm','Improve session controls');}
writeFileSync(repo+'/README.md','# Cezarion fixture\n\nA populated working tree for visual verification.\n');
const record=JSON.parse(readFileSync(source+'/packages/web/e2e/fixtures/thread-run.record.json'));
const runs=['session','worker','review','variant'].map((name,i)=>({...record,id:'10000000-0000-4000-8000-00000000000'+i,title:['Improve session navigation','Review keyboard controls','Polish task overview','Compare compact layout'][i],titleSummary:undefined,status:i===2?'review':'done',groupId:i===2||i===3?'fixture-group':undefined,variant:i===2?'A':i===3?'B':undefined,parentRunId:i===1?'10000000-0000-4000-8000-000000000000':undefined,archived:false,worktreePath:repo,branch:'task-fixture',finishedAt:new Date(Date.now()-i*3600000).toISOString(),createdAt:new Date(Date.now()-i*3600000).toISOString(),startedAt:new Date(Date.now()-i*3600000).toISOString(),inputTokens:42000,outputTokens:6000,costUsd:0.42,peakRssBytes:440401920,diffStat:{adds:12,dels:3,files:1}}));
runs[0].delegation={role:'root',permissions:[],receipts:[{workerId:runs[1].id,requestId:'20000000-0000-4000-8000-000000000001',requestHash:'a'.repeat(64)}]};
runs[1].delegation={role:'worker',parentRunId:runs[0].id,permissions:[],workspace:{ownerRunId:runs[1].id,resourceId:'30000000-0000-4000-8000-000000000001',kind:'owned-isolated',path:repo,branch:'main',baselineSha:git('rev-parse','HEAD').toString().trim()}};
try { git('remote','remove','origin') } catch {}
git('remote','add','origin','https://github.com/hearsay-tools/cezarion.git');
const titles=['Fixing finalization failure','Implementation worker','Planning CI follow-up','CI regression checks'];
for (let i=0;i<runs.length;i++) { Object.assign(runs[i],{title:titles[i], groupId:undefined,variant:undefined,pinned:i===0,status:i===0?'waiting':i===1?'done':i===2?'review':'cancelled', seenAt:new Date(Date.now()+10000).toISOString(),pullRequestUrl:i<3?'https://github.com/hearsay-tools/cezarion/pull/217':undefined,referencedIssueUrl:i===0||i===3?'https://github.com/hearsay-tools/cezarion/issues/214':undefined}); }
runs[2].pullRequestUrl=undefined;
runs[2].delegation={role:'root',permissions:[],receipts:[]};
runs[3].delegation={...runs[1].delegation,parentRunId:runs[2].id};
try { git('checkout','main') } catch {}
for(const name of ['website','earwitness']) {
 const root=resolve(qa,'repos',name); mkdirSync(root+'/.ai/cezar',{recursive:true});
 const g=(...args)=>execFileSync('git',['-C',root,...args],{env:{PATH:process.env.PATH}});
 if(!existsSync(root+'/.git')) {g('init','-q','-b','main');g('config','user.email','fixture@example.test');g('config','user.name','QA Fixture');writeFileSync(root+'/README.md','# '+name);g('add','.');g('commit','-qm','Initialize fixture');}
 if(name==='website') writeFileSync(root+'/.ai/cezar/runs.json',JSON.stringify([ {...runs[2],id:'10000000-0000-4000-8000-000000000010',title:'Watch preview deployment',pullRequestUrl:'https://github.com/hearsay-tools/cezarion/pull/91',delegation:undefined}, {...runs[3],id:'10000000-0000-4000-8000-000000000011',title:'Replace legacy carousel',referencedIssueUrl:'https://github.com/hearsay-tools/cezarion/issues/298',delegation:undefined} ]));
}
mkdirSync(qa+'/cez-home',{recursive:true});writeFileSync(qa+'/cez-home/config.json',JSON.stringify({projects:['iac','website','earwitness'].map((name,i)=>({id:name,name,root:resolve(qa,'repos',name),source:'local',addedAt:'2026-09-01T00:00:00.000Z',lastOpenedAt:`2026-09-${12-i}T00:00:00.000Z`}))}));
writeFileSync(repo+'/.ai/cezar/runs.json',JSON.stringify(runs));
for(const run of runs){writeFileSync(repo+'/.ai/cezar/runs/'+run.id+'.ndjson',readFileSync(source+'/packages/web/e2e/fixtures/thread-run.ndjson','utf8').replaceAll(record.id,run.id));mkdirSync(repo+'/.ai/cezar/runs/'+run.id+'-images',{recursive:true});copyFileSync(source+'/packages/web/e2e/fixtures/thread-run-images/screenshot-1.png',repo+'/.ai/cezar/runs/'+run.id+'-images/screenshot-1.png')}
// A short populated transcript keeps the session header and continuation controls visible together.
const transcript=[{type:'step-start',stepId:'task',name:'Do the task',kind:'agent',iteration:1},{type:'tool-call',id:'fixture-tool',tool:'Bash',input:{command:'git status --short'}},{type:'tool-result',toolCallId:'fixture-tool',result:' M README.md',isError:false},{type:'text',stepId:'task',text:'## Audit done. No code changes.\n\n### Broken / stale role references\nOne stale role reference needs a corrected directory name.\n\n### Unused role directories\nThree directories have no live playbook references.\n\n### Requirements consistency\nThe requirements file repeats a declared dependency. Review the full report before changing references.'},{type:'step-end',stepId:'task',status:'done'},{type:'lifecycle',message:'review accepted — finished without a PR'}];
writeFileSync(repo+'/.ai/cezar/runs/'+runs[0].id+'.ndjson',transcript.map((e,i)=>JSON.stringify({...e,seq:i+1,ts:new Date().toISOString()})).join('\n')+'\n');
mkdirSync(repo+'/.ai/cezar/skills/fixture-audit',{recursive:true});writeFileSync(repo+'/.ai/cezar/skills/fixture-audit/SKILL.md','---\nname: fixture-audit\ndescription: Review task navigation and report actionable findings.\n---\nInspect the current task and summarize findings.');
writeFileSync(repo+'/.ai/cezar/todos.json',JSON.stringify([{id:'follow-up',summary:'Validate populated task views on desktop and mobile.',suggestedPrompt:'Check all task views.',runnable:true,taskId:'10000000-0000-4000-8000-000000000000'}]));
mkdirSync(repo+'/.ai/cezar/workflows',{recursive:true});writeFileSync(repo+'/.ai/cezar/workflows/fixture-review.yaml',"name: fixture-review\ndescription: Review a change and verify the result.\nsteps:\n  - id: inspect\n    name: Inspect current changes\n    prompt: Read the task and inspect the changed files.\n  - id: review\n    name: Review implementation\n    prompt: Check correctness and keyboard accessibility.\n  - id: verify\n    name: Verify result\n    command: git diff --check\n");
const port=process.argv[3]??'44629';
const env={PATH:process.env.PATH,CLAUDE_CONFIG_DIR:qa+'/vendor/claude',CODEX_HOME:qa+'/vendor/codex',OPENCODE_CONFIG_DIR:qa+'/vendor/opencode',XDG_CONFIG_HOME:qa+'/vendor/config',XDG_DATA_HOME:qa+'/vendor/data',XDG_STATE_HOME:qa+'/vendor/state',CEZ_HOME:qa+'/cez-home',CEZ_DRY_RUN:'1',CEZ_FOLLOWUPS:'0',CEZ_AUTOMATIONS:'0',CEZ_SKILLS_AUTO_UPDATE:'0',CEZ_SINGLE_PROJECT:'0',CEZ_AUTONAME:'0',CEZ_DELEGATION:'0'};
const entry=source+'/packages/cezar/dist/index.js';
const child=spawn(process.execPath,[entry,'serve','--repo',repo,'--port',port,'--no-open'],{env,stdio:'inherit'});
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync(qa+'/server-proof.json',JSON.stringify({source,sourceCommit:execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8',env:{PATH:process.env.PATH}}).trim(),entry,entrySha256:hash(entry),webRoot:source+'/packages/cezar/web/dist',indexSha256:hash(source+'/packages/cezar/web/dist/index.html'),pid:child.pid,repo,cezHome:env.CEZ_HOME,baseUrl:'http://127.0.0.1:'+port,startedAt:new Date().toISOString(),credentials:'Child receives only PATH and explicit CEZ fixture flags; no inherited credentials'},null,2));
child.on('exit',c=>process.exit(c??0));
