import {readFileSync,writeFileSync} from 'node:fs';
const root='/home/agent/projects/cezar/.ai/cezar/worktrees/9ae05dcc-cc09-405c-9934-ab364076aa21/.ai/design-reference/iteration-3/design';
const manifest=JSON.parse(readFileSync(root+'/manifest.json'));
const captured=JSON.parse(readFileSync('.ai/qa/settings/pairs.json'));
if(manifest.frameCount!==193||manifest.frames.length!==193||manifest.penFileSha256!==captured.designSourceSha256)throw Error('Design inventory mismatch');
const byId=new Map(captured.pairs.map(p=>[p.id,p]));
const frames=manifest.frames.map(f=>{
 const owned=/^S\d\d\./.test(f.name),pair=byId.get(f.id);
 if(owned&&!pair)throw Error('Assigned state not captured: '+f.name);
 if(pair&&(pair.name!==f.name||pair.designPngSha256!==f.pngSha256||pair.viewport.width!==f.width||pair.viewport.height!==f.height))throw Error('Wrong frame mapping: '+f.id);
 return {id:f.id,name:f.name,width:f.width,height:f.height,designPngSha256:f.pngSha256,ownership:owned?'Settings worker':'Other worker / parent integration',status:owned?'Captured against integrated build; visual discrepancies documented':'Outside Settings assignment; no coverage claimed',...(pair?{sourceCommit:pair.sourceCommit,sourceSha256:pair.sourceSha256,browserPng:pair.browserPng,browserPngSha256:pair.browserPngSha256,theme:pair.theme,density:pair.density,observed:pair.observed,remainingDiscrepancies:pair.notes}:{})};
});
const owned=frames.filter(f=>f.ownership==='Settings worker');
if(owned.length!==52||byId.size!==52)throw Error('Wrong Settings inventory size');
for(let section=1;section<=13;section++){
 const key='S'+String(section).padStart(2,'0');
 const group=owned.filter(f=>f.name.startsWith(key+'.'));
 if(group.length!==4||new Set(group.map(f=>(f.name.includes('Mobile')?'mobile':'desktop')+'/'+f.theme)).size!==4)throw Error('Missing variant for '+key);
}
writeFileSync('.ai/qa/settings/inventory-193.json',JSON.stringify({designSourceSha256:manifest.penFileSha256,sourceCommit:captured.sourceCommit,frameCount:193,assignedFrameCount:52,capturedAssignedFrames:52,outsideAssignment:141,acceptance:'Inventory coverage only; no pixel-parity approval',frames},null,2));
console.log('PASS: each of 193 inventory frames accounted for; all 13 Settings states have desktop/mobile × light/dark captures (52), 141 outside assignment.');
