import {readFileSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';import {execFileSync} from 'node:child_process';
import {runRecordSchema} from '../../../packages/cezar/dist/contract/index.js';
const qa=resolve('.ai/qa/runtime-verified'),proof=JSON.parse(readFileSync(qa+'/server-proof.json'));
const rows=[];for(let i=0;i<4;i++){const id='10000000-0000-4000-8000-00000000000'+i;const response=await fetch(proof.baseUrl+'/api/v1/runs/'+id);if(!response.ok)throw Error('Run missing '+id);const run=runRecordSchema.parse(await response.json());rows.push(run)}
if(rows[0].delegation?.role!=='root'||rows[1].delegation?.role!=='worker'||rows[1].delegation.parentRunId!==rows[0].id)throw Error('Parent/worker relationship absent');
const diff=execFileSync('git',['-C',proof.repo,'diff','--name-only'],{encoding:'utf8'}).trim().split('\n');if(diff.join()!=='README.md')throw Error('Unexpected dirty fixture paths: '+diff);
const tracked=execFileSync('git',['-C',proof.repo,'ls-files'],{encoding:'utf8'});if(tracked.includes('.ai/'))throw Error('Generated state tracked in fixture');
const source=execFileSync('git',['diff','--name-only','--','packages'],{encoding:'utf8'});if(source.trim())throw Error('Unexpected app source changes');
const result={checkedAt:new Date().toISOString(),runsValidated:rows.length,parentWorkerRelationship:true,dirtyPaths:diff,generatedStateTracked:false,appSourceUnchanged:true};writeFileSync(qa+'/fixture-proof.json',JSON.stringify(result,null,2));console.log(result);
