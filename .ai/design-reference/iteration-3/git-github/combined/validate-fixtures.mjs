import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const proof=JSON.parse(readFileSync(new URL('../combined-source-proof.json',import.meta.url)));
const contract=await import(pathToFileURL(proof.snapshotPath+'/packages/cezar/dist/contract/index.js'));
const here=new URL('./',import.meta.url);
const mocks=JSON.parse(readFileSync(new URL('populated-mocks.json',here))).mocks;
for(const mock of mocks){
 let schema;
 if(mock.path==='/github?*')schema=contract.githubDataSchema;
 else if(mock.path==='/github/checks*')schema=contract.githubChecksDataSchema;
 else if(mock.path==='/github/ref-status*')schema=contract.githubRefStatusDataSchema;
 else if(mock.path==='/github/comments/*')schema=contract.githubCommentsDataSchema;
 else if(mock.path==='/repo')schema=contract.repoResponseSchema;
 else if(mock.path==='/repo/pull')schema=contract.repoPullBranchesResponseSchema;
 else if(mock.path.includes('files?'))schema=contract.worktreeEntrySchema;
 else if(mock.path==='/runs/10000000-0000-4000-8000-000000000000/commits')schema=contract.runCommitsResponseSchema;
 else if(mock.path.includes('/repo/changes')||mock.path.includes('/runs/10000000-0000-4000-8000-000000000000/changes'))schema=contract.changesPayloadSchema;
 else if(mock.path.includes('/github/prs/')&&mock.path.endsWith('/merge-state'))schema=contract.githubPrMergeStateResponseSchema;
 else if(mock.path.includes('/github/prs/')&&mock.path.endsWith('/changes'))schema=contract.githubPrChangesDataSchema;
 if(schema)schema.parse(mock.body);
}
for(const state of ['27A','27B','27C'])contract.githubPrMergeStateResponseSchema.parse(JSON.parse(readFileSync(new URL(state+'-merge-state.json',here))));
console.log('Populated Git payloads and all three PR readiness fixtures validate against the built contract.');
