import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const out=resolve('.ai/qa/runtime-verified/independent-review'),web=resolve('packages/cezar/web/dist'),sha=b=>createHash('sha256').update(b).digest('hex');
const index=sha(readFileSync(web+'/index.html')),proof={at:new Date().toISOString(),indexSha256:index,sourceSha256:sha(readFileSync('cezarion.pen')),servers:[],frames:[]};
assert.equal(proof.sourceSha256,'56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8');
for(const [port,serverProof] of [[44863,'.ai/qa/runtime-verified/server-proof.json'],[44864,out+'/shell/server-proof.json']]){
 const original=JSON.parse(readFileSync(serverProof)),cmd=readFileSync('/proc/'+original.pid+'/cmdline','utf8').split('\0').filter(Boolean);assert(cmd.includes(resolve('packages/cezar/dist/index.js')));
 const assets=[];for(const name of ['index.html',...readdirSync(web+'/assets').map(n=>'assets/'+n)]){const disk=sha(readFileSync(web+'/'+name)),served=sha(Buffer.from(await(await fetch('http://127.0.0.1:'+port+'/'+name)).arrayBuffer()));assert.equal(served,disk,name);assets.push({name,sha256:disk});}
 proof.servers.push({port,pid:original.pid,cmd,repo:original.repo,cezHome:original.cezHome,assets});
}
const manifest=JSON.parse(readFileSync('.ai/design-reference/iteration-3/design/manifest.json'));assert.equal(manifest.frameCount,193);
const pairs=JSON.parse(readFileSync(out+'/pairs.json'));assert.equal(pairs.length,74);
for(const p of pairs){assert.equal(p.indexSha256,index,p.name);const ref=readFileSync('.ai/design-reference/iteration-3/design/'+p.reference+'.png');assert.equal(sha(ref),p.referencePngSha256);proof.frames.push({...p,actualSha256:sha(readFileSync(out+'/'+p.actual))});}
assert.equal(JSON.parse(readFileSync(out+'/shell/served-assets.json')).find(a=>a.asset==='index.html').sha256,index);
proof.shellImages=Object.fromEntries(readdirSync(out+'/shell').filter(n=>n.endsWith('.png')).map(n=>[n,sha(readFileSync(out+'/shell/'+n))]));
writeFileSync(out+'/final-proof.json',JSON.stringify(proof,null,2));
console.log('Verified 74 captures and both built servers against '+index);
