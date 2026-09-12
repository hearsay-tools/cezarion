import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { runRecordSchema } from '../../../packages/cezar/dist/contract/index.js'
const qa=resolve('.ai/qa/shell-current193'), p=JSON.parse(readFileSync(qa+'/server-proof.json'))
const hash=x=>createHash('sha256').update(x).digest('hex')
process.kill(p.pid,0)
p.processCommand=readFileSync('/proc/'+p.pid+'/cmdline','utf8').split('\0').filter(Boolean)
if(!p.processCommand.includes(p.entry)||!p.processCommand.includes(p.repo))throw Error('Wrong runtime')
p.verifiedAt=new Date().toISOString();p.entrySha256=hash(readFileSync(p.entry));p.indexSha256=hash(readFileSync(p.webRoot+'/index.html'));p.servedIndexSha256=hash(Buffer.from(await(await fetch(p.baseUrl)).arrayBuffer()))
if(p.servedIndexSha256!==p.indexSha256)throw Error('Served index mismatch')
p.assets=[]
for(const file of readdirSync(p.webRoot+'/assets').filter(x=>/\.(js|css|woff2|ttf)$/.test(x))){const local=hash(readFileSync(p.webRoot+'/assets/'+file)),served=hash(Buffer.from(await(await fetch(p.baseUrl+'/assets/'+file)).arrayBuffer()));if(local!==served)throw Error('Asset mismatch '+file);p.assets.push({file,sha256:local,servedSha256:served})}
p.health=await(await fetch(p.baseUrl+'/api/v1/health')).json();if(p.health.repoRoot!==p.repo)throw Error('Wrong repo')
p.sourceDiffSha256=hash(execFileSync('git',['diff','--','packages/web']))
const runs=[];for(let i=0;i<4;i++)runs.push(runRecordSchema.parse(await(await fetch(p.baseUrl+'/api/v1/runs/10000000-0000-4000-8000-00000000000'+i)).json()))
if(runs[1].delegation.parentRunId!==runs[0].id||runs[3].delegation.parentRunId!==runs[2].id)throw Error('Lost worker hierarchy')
p.validatedRuns=runs.length;p.workerFamilies=2
writeFileSync(qa+'/server-proof.json',JSON.stringify(p,null,2));console.log('Verified built runtime, '+p.assets.length+' served assets, 4 contract-valid runs and 2 worker families')
