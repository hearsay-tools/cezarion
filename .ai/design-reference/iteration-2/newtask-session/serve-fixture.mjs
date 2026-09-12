import {existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=resolve(process.argv[2]??'.');
const qa=resolve(source,'.ai/qa/runtime-verified');
const repo=resolve(qa,'fixture-repo');
mkdirSync(repo+'/.ai/cezar/runs',{recursive:true});
const git=(...a)=>execFileSync('git',['-C',repo,...a]);
if(!existsSync(repo+'/.git')){git('init','-q','-b','main');git('config','user.email','fixture@example.test');git('config','user.name','QA Fixture');writeFileSync(repo+'/README.md','# Cezarion fixture\n');git('add','.');git('commit','-qm','Initialize fixture');git('branch','feature/runtime-audit');}
writeFileSync(repo+'/.gitignore','.ai/\n.local/\n');
writeFileSync(repo+'/README.md','# Cezarion fixture\n\nA populated working tree for visual verification.\n');
const record=JSON.parse(readFileSync(source+'/packages/web/e2e/fixtures/thread-run.record.json'));
const runs=['session','worker','review','variant'].map((name,i)=>({...record,id:'fixture-'+name,title:['Improve session navigation','Review keyboard controls','Polish task overview','Compare compact layout'][i],titleSummary:undefined,status:i===2?'review':'done',groupId:i===0||i===3?'fixture-group':undefined,variant:i===0?'A':i===3?'B':undefined,parentRunId:i===1?'fixture-session':undefined,archived:false,worktreePath:repo,branch:'main',createdAt:new Date(Date.now()-i*3600000).toISOString(),startedAt:new Date(Date.now()-i*3600000).toISOString(),inputTokens:42000,outputTokens:6000,costUsd:0.42,peakRssBytes:440401920,diffStat:{adds:12,dels:3,files:1}}));
const prompt='Audit this IaC repo for stale Ansible role references. Report missing roles and unused role directories with file:line references. Make NO code changes — report findings only.';
for (const run of runs) {
  delete run.pullRequestUrl; delete run.groupId; delete run.variant;
  run.task=prompt; run.model='opus'; run.steps=run.steps.slice(0,1);
  run.workflowDef.steps=run.workflowDef.steps.slice(0,1);
}
runs[0].title='Auditing stale Ansible roles';
runs[2].title='Fix finalization retries';
writeFileSync(repo+'/.ai/cezar/runs.json',JSON.stringify(runs));
const report='## Audit done. No code changes.\n\n**Broken / stale role references**\n\nansible/roles/_nginx_add_proxy_entry/meta/main.yml:34 — role: mainca_agent is missing a space after the colon; the role directory has a leading underscore.\n\n**Unused role directories**\n\nnginx, deploy_webapp, npm_service, configure_docker and other directories have no live playbook references.\n\n**Requirements consistency**\n\nansible/requirements.yml:1–16 omits geerlingguy.docker. Lines 2 and 9 both declare cloud.terraform; the unversioned entry overrides the version pin.';
for(const run of runs){
 const events=[
 {type:'session.started',sessionId:'fixture-session',backend:'claude',stepId:'task'},
 {type:'turn.started',turnId:'turn-1',stepId:'task'},
 {type:'item.completed',item:{kind:'tool',id:'read-1',name:'Read',toolKind:'read',title:'Read ansible/requirements.yml',status:'completed',input:{file_path:'ansible/requirements.yml'},output:'- geerlingguy.nginx\n- cloud.terraform\n- cloud.terraform'}},
 {type:'item.completed',item:{kind:'tool',id:'search-1',name:'Grep',toolKind:'search',title:'Search role references',status:'completed',input:{pattern:'roles:',path:'ansible/'},output:'ansible/site.yml:14: roles:\nansible/deploy.yml:8: roles:'}},
 {type:'item.completed',item:{kind:'message',id:'report',role:'assistant',text:report}},
 {type:'turn.completed',turnId:'turn-1',stepId:'task'},
 ];
 writeFileSync(repo+'/.ai/cezar/runs/'+run.id+'.ndjson',events.map((e,i)=>JSON.stringify({...e,seq:i+1,ts:'2026-09-12T08:00:00.000Z'})).join('\n')+'\n');
 writeFileSync(repo+'/.ai/cezar/runs/'+run.id+'.handoff.md','# Summary\nImplemented a retry guard in finalization. Re-running a completed step now returns the existing result.\n\n## Verification\nAll finalization tests pass. Added coverage for a retry following a failed commit.\n\n## Next steps\nReview the diff, then finish the task.');
}
writeFileSync(repo+'/.ai/cezar/todos.json',JSON.stringify([{id:'follow-up',summary:'Validate populated task views on desktop and mobile.',suggestedPrompt:'Check all task views.',runnable:true,taskId:'fixture-session'}]));
mkdirSync(repo+'/.ai/cezar/skills',{recursive:true});
writeFileSync(repo+'/.ai/cezar/skills/audit.md','---\nname: audit\ndescription: Review references and report findings without changing files.\n---\nAudit the repository and report file references.');
writeFileSync(repo+'/.ai/cezar/ui-state.json',JSON.stringify({promptTemplates:[{id:'review',name:'Review checklist',body:'Preserve behavior and report verification results.',skillNames:[]}]}));
const port=process.argv[3]??'44636';
const env={PATH:process.env.PATH,CEZ_HOME:qa+'/cez-home',CEZ_DRY_RUN:'1',CEZ_FOLLOWUPS:'1',CEZ_AUTOMATIONS:'1',CEZ_SKILLS_AUTO_UPDATE:'0',CEZ_SINGLE_PROJECT:'1'};
const entry=source+'/packages/cezar/dist/index.js';
const child=spawn(process.execPath,[entry,'serve','--repo',repo,'--port',port,'--no-open'],{env,stdio:'inherit'});
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync(qa+'/server-proof.json',JSON.stringify({source,sourceCommit:execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),entry,entrySha256:hash(entry),webRoot:source+'/packages/cezar/web/dist',indexSha256:hash(source+'/packages/cezar/web/dist/index.html'),pid:child.pid,repo,cezHome:env.CEZ_HOME,baseUrl:'http://127.0.0.1:'+port,startedAt:new Date().toISOString(),credentials:'Child receives only PATH and explicit CEZ fixture flags; no inherited credentials'},null,2));
child.on('exit',c=>process.exit(c??0));
