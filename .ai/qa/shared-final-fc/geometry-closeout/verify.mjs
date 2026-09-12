import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const out=resolve('.ai/qa/runtime-verified/geometry-closeout'), web=resolve('packages/cezar/web/dist');
const hash=b=>createHash('sha256').update(b).digest('hex');const index=hash(readFileSync(web+'/index.html'));
const pairs=JSON.parse(readFileSync(out+'/pairs.json'));assert.equal(pairs.length,26);
const table=[];
const expectations={MB5Yx:{'skills-detail':[214,984]},IbcKi:{'skills-detail':[214,984]},f2LGv:{'skills-detail':[253,761]},suUEJ:{'skills-detail':[253,761]},EKi57:{'skills-list':[253,788],'skills-detail':[253,465]},cvBro:{'skills-list':[253,788],'skills-detail':[253,465]},acXhB:{'skills-detail':[214,614]},utoCL:{'skills-detail':[214,614]},aa0TQ:{'wb-main':[658,695],'wb-aside':[1375,455]},Ae0n6:{'wb-main':[658,695],'wb-aside':[1375,455]},C2sfEo:{'wb-main':[526,493],'wb-aside':[526,455]},s0JzCL:{'wb-main':[526,493],'wb-aside':[526,455]},VDDSI:{'wb-auto-panel':[526,324]},MmQCH:{'wb-auto-panel':[526,324]},Zsg4w:{'wb-auto-panel':[658,384]},e7UWy:{'wb-auto-panel':[658,384]}};
for(const p of pairs){assert.equal(p.indexSha256,index,p.name);assert.equal(hash(readFileSync('.ai/design-reference/iteration-3/design/'+p.reference+'.png')),p.referencePngSha256);for(const [slot,[y,height]] of Object.entries(expectations[p.name]??{})){const m=p.metrics.find(m=>m.slot===slot);assert(m);assert.equal(m.rect.height,height,p.name+' '+slot+' height');assert(Math.abs(m.rect.y-y)<.25,p.name+' '+slot+' y');table.push({frame:p.name,slot,source:{y,height},browser:{y:m.rect.y,height:m.rect.height},yDelta:m.rect.y-y});}for(const m of p.metrics){if(m.text==='01'&&m.slot===null)assert.equal(m.radius,'5px');if(m.slot==='wb-import')assert(Math.abs(m.rect.width-88.5)<.05);}}
const proof={at:new Date().toISOString(),parentCheckpoint:'b87b5082',scopedBaseFix:'5ab8ba8d',capturedBaseCommit:'cc7f104b',sourcePatch:'capture-source.patch',indexSha256:index,penSha256:hash(readFileSync('cezarion.pen')),servers:[],geometry:table,sourceFiles:{},frames:pairs.map(p=>({...p,actualSha256:hash(readFileSync(out+'/'+p.actual))}))};
assert.equal(proof.penSha256,'56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8');
for(const file of ['components/app-shell.tsx','routes/skills.tsx','routes/skills-workflows.css','styles/index.css'])proof.sourceFiles['packages/web/src/'+file]=hash(readFileSync('packages/web/src/'+file));
for(const [port,name] of [[44863,'.ai/qa/runtime-verified/server-proof.json'],[44864,'.ai/qa/runtime-verified/independent-review/shell/server-proof.json']]){
 const original=JSON.parse(readFileSync(name)),cmd=readFileSync('/proc/'+original.pid+'/cmdline','utf8').split('\0').filter(Boolean);assert(cmd.includes(resolve('packages/cezar/dist/index.js')));const assets=[];for(const name of ['index.html',...readdirSync(web+'/assets').map(n=>'assets/'+n)]){const disk=hash(readFileSync(web+'/'+name));assert.equal(hash(Buffer.from(await(await fetch('http://127.0.0.1:'+port+'/'+name)).arrayBuffer())),disk,name);assets.push({name,sha256:disk});}proof.servers.push({port,pid:original.pid,cmd,assets});
}
writeFileSync(out+'/final-proof.json',JSON.stringify(proof,null,2));console.log('26 frozen-build captures; exact measured heights and badge radii; 2 served CLI asset sets verified.');
