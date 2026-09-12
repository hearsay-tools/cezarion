import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const qa=resolve('.ai/qa/runtime-verified'),p=JSON.parse(readFileSync(qa+'/server-proof.json'));const hash=b=>createHash('sha256').update(b).digest('hex');
process.kill(p.pid,0);
p.processCommand=readFileSync('/proc/'+p.pid+'/cmdline','utf8').split('\0').filter(Boolean);
if(!p.processCommand.includes(p.entry)||!p.processCommand.includes(p.repo))throw Error('Process provenance mismatch');
p.servedIndexSha256=hash(Buffer.from(await(await fetch(p.baseUrl)).arrayBuffer()));
p.servedIndexMatchesDisk=p.servedIndexSha256===p.indexSha256;
p.assets=[];
for(const file of readdirSync(p.webRoot+'/assets').filter(x=>/\.(js|css|woff2)$/.test(x))){const local=hash(readFileSync(p.webRoot+'/assets/'+file)),served=hash(Buffer.from(await(await fetch(p.baseUrl+'/assets/'+file)).arrayBuffer()));p.assets.push({file,sha256:local,servedSha256:served,match:local===served})}
p.health=await(await fetch(p.baseUrl+'/api/v1/health')).json();p.fixtureRepoMatchesHealth=p.repo===p.health.repoRoot;
if(!p.servedIndexMatchesDisk||!p.fixtureRepoMatchesHealth||p.assets.some(x=>!x.match))throw Error('Build provenance mismatch');
writeFileSync(qa+'/server-proof.json',JSON.stringify(p,null,2));
const result=execFileSync(qa+'/browser.sh',['eval','JSON.stringify({url:location.href,font:getComputedStyle(document.body).fontFamily,fonts:[...document.fonts].filter(f=>f.status==="loaded").map(f=>f.family),theme:document.documentElement.className,density:document.documentElement.dataset.density??"comfortable",width:innerWidth,height:innerHeight})'],{encoding:'utf8'});writeFileSync(qa+'/browser-proof.json',JSON.stringify(JSON.parse(JSON.parse(result)),null,2));
console.log('PASS: fixture repo, served index and '+p.assets.length+' JS/CSS/font hashes match.');
