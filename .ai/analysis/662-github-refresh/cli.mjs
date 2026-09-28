// Read-only control: local startup versus light/rich live GraphQL, five interleaved rounds.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
const exec=promisify(execFile);
const {fetchRefStatuses}=await import(resolve('packages/cezar/src/server/forge/github.ts'));
let rich;
await fetchRefStatuses(async q=>{rich=q;return '{"data":{"repository":{}}}';},'hearsay-tools','cezarion',[670,662]);
const lite='query ($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { r0: issueOrPullRequest(number:670) { __typename ... on PullRequest { state } } r1: issueOrPullRequest(number:662) { __typename ... on Issue { state stateReason } } } }';
const results=[];
for(let i=0;i<5;i++) for(const [name,args] of [
 ['startup',['--version']],
 ['repo',['repo','view','--json','nameWithOwner','--jq','.nameWithOwner']],
 ['light',['api','graphql','-f',`query=${lite}`,'-f','owner=hearsay-tools','-f','name=cezarion']],
 ['rich',['api','graphql','-f',`query=${rich}`,'-f','owner=hearsay-tools','-f','name=cezarion']]]) {
 const start=performance.now();const {stdout}=await exec('gh',args);results.push({name,ms:+(performance.now()-start).toFixed(2),bytes:Buffer.byteLength(stdout)});
}
console.log(JSON.stringify(results,null,2));
