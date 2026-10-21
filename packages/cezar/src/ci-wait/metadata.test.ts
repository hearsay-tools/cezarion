import { expect, it } from 'vitest';
import { GithubCiClient } from './github.ts';
const pr = {prUrl:'https://github.com/org/repo/pull/12',repository:'org/repo',prNumber:12,headSha:'a'.repeat(40)};
function client(fields: Record<string, unknown>) {
 const body = {url:pr.prUrl,number:12,headRefOid:pr.headSha,...fields};
 return new GithubCiClient({command:{file:process.execPath,args:['-e',`process.stdout.write(${JSON.stringify(JSON.stringify(body))})`]}});
}
it.each([
 [{mergeable:'CONFLICTING',mergeStateStatus:'DIRTY'},'CONFLICTING','DIRTY'],
 [{mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'},'MERGEABLE','CLEAN'],
 [{mergeable:'UNKNOWN',mergeStateStatus:'BLOCKED'},'UNKNOWN','BLOCKED'],
 [{},'UNKNOWN','UNKNOWN'],
 [{mergeable:null,mergeStateStatus:null},'UNKNOWN','UNKNOWN'],
 [{mergeable:'FUTURE',mergeStateStatus:'NEW_STATE'},'UNKNOWN','NEW_STATE'],
 [{mergeable:'MERGEABLE',mergeStateStatus:'\x1b[31mDIRTY\x1b[0m\u0000'},'MERGEABLE','DIRTY'],
] as const)('normalizes external mergeability %j', async (fields,mergeable,mergeStateStatus) => {
 expect(await client(fields).metadata(pr,new AbortController().signal)).toEqual({headSha:pr.headSha,mergeable,mergeStateStatus});
});
it.each([{mergeable:12},{mergeStateStatus:[]},{mergeStateStatus:{}},{mergeable:{}}])('rejects malformed metadata %j', async fields => {
 await expect(client(fields).metadata(pr,new AbortController().signal)).rejects.toMatchObject({code:'malformed_data'});
});
it('bounds external advisory state', async () => {
 expect((await client({mergeStateStatus:'x'.repeat(100)}).metadata(pr,new AbortController().signal)).mergeStateStatus).toHaveLength(64);
});

it('requests mergeability in the same bounded metadata query as head identity', async () => {
 const body = {url:pr.prUrl,number:12,headRefOid:pr.headSha,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'};
 const source = `const args=process.argv.slice(1); if(args.join(' ') !== 'pr view ${pr.prUrl} --json url,number,headRefOid,mergeable,mergeStateStatus')process.exit(2); process.stdout.write(${JSON.stringify(JSON.stringify(body))});`;
 const github = new GithubCiClient({command:{file:process.execPath,args:['-e',source]}});
 expect(await github.metadata(pr,new AbortController().signal)).toEqual({headSha:pr.headSha,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'});
});
