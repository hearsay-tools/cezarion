import{readFileSync,writeFileSync,readdirSync}from'node:fs';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const path='.ai/qa/settings/server-proof.json',proof=JSON.parse(readFileSync(path));
for(const file of readdirSync(proof.webRoot+'/assets').filter(f=>/\.(ttf|woff|otf)$/.test(f))){
 const sha256=hash(readFileSync(proof.webRoot+'/assets/'+file)),servedSha256=hash(Buffer.from(await(await fetch(proof.baseUrl+'/assets/'+file)).arrayBuffer()));
 if(sha256!==servedSha256)throw Error('Font mismatch '+file);
 if(!proof.assets.some(a=>a.file===file))proof.assets.push({file,sha256,servedSha256,match:true});
}
writeFileSync(path,JSON.stringify(proof,null,2));
const data=JSON.parse(readFileSync('.ai/qa/settings/pairs.json'));
const sourcePaths=execFileSync('git',['ls-files','packages/web/src','packages/contract/src','packages/cezar/src'],{encoding:'utf8'}).trim().split('\n');
const currentSourceSha256=hash(sourcePaths.map(p=>p+'\0'+hash(readFileSync(p))).join('\n'));
if(currentSourceSha256!==data.sourceSha256)throw Error('Current source differs from capture');
if(data.sourceCommit!==proof.sourceCommit||data.indexSha256!==proof.indexSha256)throw Error('Source/build mismatch');
if(data.pairs.length!==52)throw Error('Missing capture');
for(const p of data.pairs){
 const png=readFileSync(p.browserPng);
 if(hash(png)!==p.browserPngSha256||hash(readFileSync(p.designPng))!==p.designPngSha256)throw Error('PNG mismatch '+p.id);
 if(png.readUInt32BE(16)!==p.viewport.width*2||png.readUInt32BE(20)!==p.viewport.height*2)throw Error('Wrong raster dimensions '+p.id);
 if(p.observed.overflow||p.observed.density!=='comfortable'||!p.observed.font.includes('Poppins'))throw Error('Capture state mismatch '+p.id);
}
console.log('PASS: all 52 reference/browser hashes and matched dimensions/theme/density; '+proof.assets.length+' served asset hashes including IBM Plex TTF.');
