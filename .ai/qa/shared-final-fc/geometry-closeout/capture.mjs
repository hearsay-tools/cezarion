const {chromium}=await import(process.env.CEZ_QA_PLAYWRIGHT ?? 'playwright');
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
const root=process.cwd(),out=resolve(root,'.ai/qa/runtime-verified/geometry-closeout');
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const frozenBuild=sha(root+'/packages/cezar/web/dist/index.html');
const browser=await chromium.launch({headless:true,executablePath:process.env.CEZ_QA_CHROMIUM,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1440,height:1400},deviceScaleFactor:1});
const page=await context.newPage();
const skills=[['award-level-visual-design','Landing pages, marketing surfaces and app shell visuals.'],['backlog','Shape a PM workspace backlog into GitHub drafts.'],['build-poc','Build a proof of concept or demo.'],['cezar-cockpit','Open the Cezar cockpit for the configured repo.'],['code-review','Review a changeset methodically.'],['complete-ui-states','Complete loading, empty, error and success states.'],['dev-flow','Work a ticket through to a verified change.']].map(([name,description])=>({name,description,source:'team',path:'apptension/toolkit · apptension-frontend-craft',body:'# Award-level visual design\n\nProduce interfaces that could sit next to work from leading studios and award winners. Copy patterns, never surfaces.\n\n### Default path: existing system first\n\n- Preserve established patterns, structure, tokens and visual language.\n- Extend shared components before introducing parallel chrome.\n- For greenfield work, establish the starting design contract.'}));
const workflows={workflows:[{name:'apptension-dev-flow',source:'file',description:'Take an issue to a draft PR, then verify the change.',steps:[{id:'issue',name:'Issue to draft PR',skill:'dev-flow',prompt:'Invoke the apptension-sdlc:dev-flow skill and follow it to completion for {{task}}.'},{id:'verify',name:'Verify',command:'npm run typecheck && npm test && npm run check:pack',onFail:{retry:'issue',max:2}}]},{name:'fix-and-verify',source:'file',path:'.ai/cezar/workflows/fix-and-verify.yaml',steps:[{id:'test',skill:'test-conventions'},{id:'commit',skill:'commit-style'}]}],issues:[]};
const imported=[{name:'om-fix',description:'Fix an issue with a focused implementation.'},{name:'om-review',description:'Review a change for correctness and regressions.'},{name:'om-apply-upgrade-notes',description:'Apply descriptor migrations after updating skill files.'}];
let screen='skills',workspaceState={importedSkills:imported.map(s=>s.name)},updateStatus='current';
const mock={skills,workflows,imported};writeFileSync(out+'/fixture.json',JSON.stringify(mock,null,2));
await context.addInitScript(()=>localStorage.setItem('cez-theme','light'));
await page.route('**/api/v1/**',async route=>{
 let path=new URL(route.request().url()).pathname.replace(/^\/api\/v1(?:\/p\/[^/]+)?/,'');
 const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 if(path==='/skills'&&screen==='skills-error')return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Fixture catalog unavailable'})});
 if(path==='/skills/importable'&&screen==='manage-error')return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Fixture import catalog unavailable'})});
 if(path==='/skills' && screen==='workflow-editing')return json([['test-conventions','Add tests using the repository’s conventions.'],['commit-style','Prepare a focused commit with the expected format.'],['code-review','Review the diff for correctness and regressions.']].map(([name,description])=>({name,description,source:'team',path:'.ai/skills/'+name+'/SKILL.md',body:'# '+name})));
 if(path==='/skills')return json(screen.startsWith('workflow') ? skills.filter(s=>['dev-flow','code-review','complete-ui-states'].includes(s.name)).sort((a,b)=>['dev-flow','code-review','complete-ui-states'].indexOf(a.name)-['dev-flow','code-review','complete-ui-states'].indexOf(b.name)) : skills);
 if(path==='/workflows'&&route.request().method()==='POST')return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'workflow file already exists',exists:true})});
 if(path==='/workflows')return json(workflows);
 if(path==='/skills/importable')return json(imported);
 if(path.includes('skills-update'))return json({status:updateStatus,available:updateStatus==='available',scopes:updateStatus==='current'?[]:[{scope:'project',status:updateStatus,skills:['om-fix']}],checkedAt:null,updatedAt:null,needsUpgradeNotes:false});
 if(path==='/workspace/ui-state'){if(route.request().method()==='PUT')workspaceState={...workspaceState,...route.request().postDataJSON()};return json(workspaceState);}
 if(path==='/launch-key')return json({key:'local-visual-fixture'});
 if(path==='/workflows/parse')return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Invalid YAML: expected a workflow mapping.'})});
 return route.continue();
});
const designRoot=process.env.CEZ_QA_DESIGN;
const manifest=JSON.parse(readFileSync(designRoot+'/manifest.json'));
const ids=['EKi57','kmHeY','cvBro','XdHUd','acXhB','utoCL','f2LGv','suUEJ','MB5Yx','IbcKi','C2sfEo','aa0TQ','s0JzCL','Ae0n6','VDDSI','MmQCH','Zsg4w','e7UWy','gqaUM','EsGpp','YS15Y','wLVhd'];
const pairs=process.env.CEZ_QA_IMPORT_ONLY?JSON.parse(readFileSync(out+'/pairs.json')).filter(p=>!p.name.startsWith('import-')):process.env.CEZ_QA_DIALOGS_ONLY?JSON.parse(readFileSync(out+'/pairs.json')).filter(p=>ids.includes(p.name)||p.name.startsWith('selector-')):[];
async function snap(name,ref,viewport,theme,selector){
 if(sha(root+'/packages/cezar/web/dist/index.html')!==frozenBuild)throw new Error('Build changed during capture');
 await page.waitForTimeout(200);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur()});
 await page.waitForTimeout(250);
 await page.screenshot({path:out+'/'+name+'.png',fullPage:false});
 if(selector){const bounds=await page.locator(selector).boundingBox();console.log(name,bounds);if(name.startsWith('import') && (bounds.x<0 || bounds.y<0 || bounds.x+bounds.width>viewport.width+1))throw new Error('Import dialog leaves viewport');}
 if(selector)await page.locator(selector).screenshot({path:out+'/'+name+'-content.png'});
 const metrics=await page.locator('[data-slot=skills-list], [data-slot=skill-row], [data-slot=skills-detail], [data-slot=skill-body] .thread-markdown > *, [data-slot=wb-main], [data-slot=wb-aside], [data-slot=wb-step], [data-slot=wb-step-grip] span, [data-slot=wb-new], [data-slot=wb-actions] button, [data-slot=wb-auto-panel], [data-slot=mobile-project-picker]').evaluateAll(es=>es.map(e=>({slot:e.getAttribute('data-slot'),text:e.textContent.slice(0,90),rect:e.getBoundingClientRect().toJSON(),font:getComputedStyle(e).fontSize,lineHeight:getComputedStyle(e).lineHeight,radius:getComputedStyle(e).borderRadius,padding:getComputedStyle(e).padding,gap:getComputedStyle(e).gap})));
 pairs.push({metrics,name,reference:ref,viewport,theme,density:'comfortable',actual:name+'.png',content:selector?name+'-content.png':null,fixture:'fixture.json',indexSha256:frozenBuild,referencePngSha256:manifest.frames.find(f=>f.id===ref)?.pngSha256,sourceSha256:manifest.penFileSha256,url:page.url(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
 writeFileSync(out+'/pairs.json',JSON.stringify(pairs,null,2));
}
for(const id of ((process.env.CEZ_QA_DIALOGS_ONLY || process.env.CEZ_QA_IMPORT_ONLY) ? [] : ids)){
 const f=manifest.frames.find(f=>f.id===id),theme=f.name.toLowerCase().includes('dark')?'dark':'light';
 screen=f.name.includes('Run from GitHub')?'bookmarklets':f.name.includes('Workflow')?'workflows':f.name.includes('Manage')?'manage':f.name.includes('detail')?'detail':'skills';
 const viewport={width:f.width,height:Math.round(f.pngHeight/f.scaleX)};await page.setViewportSize(viewport);
 await page.addInitScript(theme=>{localStorage.setItem('cez-theme',theme);localStorage.setItem('cez-density','comfortable');},theme);
 await page.goto('http://127.0.0.1:44863/p/fixture-repo/'+(screen==='workflows'?'workflows':'skills'+(screen==='bookmarklets'?'?skill=__bm':screen==='manage'?'?skill=__import':screen==='detail'?'?skill=award-level-visual-design':'')));
 await page.locator(screen==='workflows'?'[data-slot="wb-step"]':'[data-slot="skills-detail"] [data-slot="skill-detail"], [data-slot="skills-import-panel"], [data-slot="skill-row"]').first().waitFor({state:'attached'});
 if(f.name.includes('Auto')){await page.locator('[data-slot="wb-auto"]').click();await page.locator('[data-slot="wb-auto-text"]').fill('Fix the issue, run the tests, then review the diff for regressions.');}
 await snap(id,id,viewport,theme);
 if(['C2sfEo','aa0TQ','s0JzCL','Ae0n6'].includes(id)){await page.locator('#workflow-load').click();await snap('selector-'+id,id,viewport,theme);await page.keyboard.press('Escape');}
}
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync(out+'/build-proof.json',JSON.stringify({generatedAt:new Date().toISOString(),indexSha256:hash(root+'/packages/cezar/web/dist/index.html'),assets:Object.fromEntries(readdirSync(root+'/packages/cezar/web/dist/assets').filter(n=>/\.(css|js)$/.test(n)).map(n=>[n,hash(root+'/packages/cezar/web/dist/assets/'+n)])),sourceSha256:manifest.penFileSha256,fixtureSha256:hash(out+'/fixture.json'),pairs:pairs.length,viewportScale:1,designExportsScale:manifest.requestedScale},null,2));
await browser.close();
