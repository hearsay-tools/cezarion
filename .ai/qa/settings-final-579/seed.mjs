import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const qa=resolve('.ai/qa/runtime-verified');
const proof=JSON.parse(readFileSync(qa+'/server-proof.json'));
const api=async(path,method='GET',body)=>{
 const r=await fetch(proof.baseUrl+'/api/v1'+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await r.json();if(!r.ok&&r.status!==409)throw Error(path+': '+JSON.stringify(data));return data;
};
// Registration intentionally suppresses descendants of cezar task worktrees. The fixture
// seeds its isolated registry file explicitly, like the reusable run-record seed.
const configPath=qa+'/cez-home/config.json';
const workspace=JSON.parse(readFileSync(configPath));
const website=qa+'/website';mkdirSync(website,{recursive:true});writeFileSync(website+'/README.md','# Website visual fixture\n');execFileSync('git',['init','-q','-b','main',website]);
workspace.projects=[{id:'fixture-repo-v2',root:proof.repo,name:'cezar',source:'local',addedAt:new Date().toISOString(),lastOpenedAt:new Date().toISOString(),tags:['backend','tools']},{id:'website',root:website,name:'website',source:'local',addedAt:new Date().toISOString(),lastOpenedAt:new Date().toISOString(),tags:['frontend']}];
writeFileSync(configPath,JSON.stringify(workspace,null,2));
await api('/config','PUT',{baseBranch:'main',defaultRunner:'codex',systemPrompt:'Follow the repository conventions. Add focused tests for changed behavior.\nKeep unrelated files unchanged.',worktreeRetention:5,liveTitleUpdates:true,reviewGate:true});
await api('/workspace/config','PUT',{browseRoot:qa,projectsDir:qa+'/checkouts',resources:{maxParallel:4,maxMonitoringSessions:2,monitoringWakeIntervalMinutes:15,memoryLimitMb:4096},skillsAutoUpdate:true,composerDefaults:{autonomous:true,worktree:true}});
await api('/workspace/ui-state','PUT',{notifications:{enabled:true},appearance:{accent:'cezarion',density:'comfortable',width:'wide'}});
await api('/ui-state','PUT',{promptTemplates:[{id:'add-tests',label:'Add tests',text:'Add focused regression tests for the changed behavior. Reuse existing fixtures and run the relevant test suite.',skills:['test','code']}]});
for(const name of ['code-review','dev-flow','pr-checks','test','code']){
 const dir=proof.repo+'/.ai/cezar/skills/'+name;mkdirSync(dir,{recursive:true});writeFileSync(dir+'/SKILL.md',`---\nname: ${name}\ndescription: Local Settings visual fixture.\n---\nInspect the repository and report findings.\n`);
}
writeFileSync(proof.repo+'/.mcp.json',JSON.stringify({mcpServers:{docs:{command:'npx',args:['-y','docs-mcp-server']}}},null,2));
writeFileSync(proof.repo+'/AGENTS.md','# Fixture instructions\nFollow the repository conventions.\n');
writeFileSync(proof.repo+'/CLAUDE.md','# Fixture instructions\nFollow the repository conventions.\n');
const profileDir=qa+'/vendor/codex-personal';mkdirSync(profileDir,{recursive:true});
const existingProfiles=await api('/workspace/agent-profiles');
let personal=existingProfiles.profiles.find(p=>p.configDir===profileDir);
if(!personal)personal=(await api('/workspace/agent-profiles','POST',{provider:'codex',label:'Personal account',configDir:profileDir})).profile;
await api('/workspace/agent-profiles/selection','PUT',{projectId:null,provider:'codex',profileId:personal.id});
await api('/workspace/config','PUT',{agentDefaults:{runner:'codex'}});
const projects=await api('/projects');
for(const p of projects.projects)await api('/projects/'+p.id,'PATCH',{tags:p.id==='website'?['frontend']:['backend','tools'],...(p.root===proof.repo?{maxParallel:4}:{})});
writeFileSync(resolve('.ai/qa/settings/seed-proof.json'),JSON.stringify({baseUrl:proof.baseUrl,repo:proof.repo,projectConfig:await api('/config'),workspaceConfig:await api('/workspace/config'),projects:await api('/projects'),disclosure:'Real isolated fixture writes only. MCP file is inert editor fixture content; no MCP server launched.'},null,2));
console.log('Seeded Settings through real APIs and isolated fixture files.');
