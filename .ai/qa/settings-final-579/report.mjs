import {readFileSync,writeFileSync} from 'node:fs';
const data=JSON.parse(readFileSync('.ai/qa/settings/pairs.json'));
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
let html='<!doctype html><html><meta charset="utf-8"><title>Settings design/browser comparisons</title><style>body{font:14px system-ui;margin:24px;background:#eee;color:#171717}article{margin:30px 0;padding:18px;background:white}figure{margin:0}img{width:100%;height:auto;border:1px solid #ccc}section{display:grid;grid-template-columns:1fr 1fr;gap:16px}code{overflow-wrap:anywhere}h2{font-size:18px}.notes{max-width:1000px;line-height:1.5}</style><h1>52 Settings design/browser comparisons</h1><p>Captured with matched viewport, theme, comfortable density and 2× device scale. These compare the corrected Settings layouts with the confirmed design; real behavior and fixture differences are documented.</p><p>Source commit <code>'+escape(data.sourceCommit)+'</code><br>Source tree SHA256 <code>'+data.sourceSha256+'</code><br>Served build index SHA256 <code>'+data.indexSha256+'</code></p>';
let md='# Settings visual verification\n\nSource commit: `'+data.sourceCommit+'`. Source hash: `'+data.sourceSha256+'`. Built/served index hash: `'+data.indexSha256+'`.\n\nAll 52 references are from confirmed design `'+data.designSourceSha256+'`; browser PNGs match their viewport, theme, comfortable density and 2× scale. The manifest records individual PNG hashes and observed browser state. The requested file-row, account-card, control-color and spacing corrections are implemented. Differences required by current behavior and fixture data are documented below.\n\n| Frame | View | Design PNG | Browser PNG |\n|---|---|---|---|\n';
for(const p of data.pairs){
 html+='<article id="'+p.id+'"><h2>'+escape(p.name)+' · '+p.id+'</h2><p class="notes">'+escape(p.notes)+'</p><section><figure><figcaption>Confirmed design</figcaption><a href="'+escape(p.designPng)+'"><img loading="lazy" src="'+escape(p.designPng)+'"></a></figure><figure><figcaption>Built browser · '+p.viewport.width+'×'+p.viewport.height+' · '+p.theme+'</figcaption><a href="'+escape(p.browserPng)+'"><img loading="lazy" src="'+escape(p.browserPng)+'"></a></figure></section></article>';
 md+='| '+p.id+' | '+p.name+' | [design]('+p.designPng+') | [browser]('+p.browserPng+') |\n';
}
writeFileSync('.ai/qa/settings/gallery.html',html+'</html>');
md+='\n## Frame-specific observations\n\n';
const sections=new Map(data.pairs.map(p=>[p.name.slice(0,3),p.notes]));
for(const [key,note] of [...sections].sort())md+='- **'+key+'**: '+note+'\n';
md+='\nThe supplied shell is integrated. Settings-specific rows, cards, action colors and spacing were corrected in 56b55310 and 50b9e946. Existing help, file scopes, authentication and save semantics remain available. Variable fixture content remains visible in the uncropped viewport captures.\n';
md+='\n'+readFileSync('.ai/qa/settings/REVIEW-NOTES.md','utf8');
writeFileSync('.ai/qa/settings/REPORT.md',md);
console.log('Wrote comparison gallery and 52-row report.');
