import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.CEZ_QA_PLAYWRIGHT);
const out=new URL('.',import.meta.url), proof=JSON.parse(readFileSync('.ai/qa/runtime-verified/server-proof.json'));
const sourceSha256='56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const browser=await chromium.launch({headless:true,executablePath:process.env.CEZ_QA_CHROMIUM,args:['--no-sandbox']});
const context=await browser.newContext();const page=await context.newPage();const captures=[],writes=[];
// No response interception. Every read and write reaches the isolated built service.
page.on('response',response=>{if(response.request().method()!=='GET')writes.push({url:response.url(),method:response.request().method(),status:response.status()})});
const snap=async(name,reference,theme,viewport)=>{
 await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(200);
 assert.equal(hash(proof.webRoot+'/index.html'),proof.indexSha256);
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
 await page.screenshot({path:new URL(name+'.png',out).pathname});
 captures.push({name,reference,theme,viewport,density:'comfortable',sourceSha256,indexSha256:proof.indexSha256,fixture:'reusable fixture-repo-v2, real API, no response mocks',url:page.url(),overflow});
};
for(const theme of ['light','dark'])for(const mobile of [false,true]){
 const viewport={width:mobile?402:1440,height:mobile?1098:1400};await page.setViewportSize(viewport);
 await page.addInitScript(theme=>{localStorage.setItem('cez-theme',theme);localStorage.setItem('cez-density','comfortable')},theme);
 await page.goto(proof.baseUrl+'/p/default/skills?skill=fixture-audit');
 await page.locator('[data-slot="skill-detail"]').waitFor();assert.match(await page.locator('[data-slot="skill-detail"]').innerText(),/Inspect the current task/);
 await snap('skill-'+theme+'-'+(mobile?'mobile':'desktop'),mobile?(theme==='light'?'acXhB':'utoCL'):(theme==='light'?'EKi57':'cvBro'),theme,viewport);
 viewport.height=mobile?1862:1600;await page.setViewportSize(viewport);
 await page.goto(proof.baseUrl+'/p/default/workflows/fixture-review');await page.locator('[data-slot="wb-step"]').first().waitFor();assert.equal(await page.locator('[data-slot="wb-step"]').count(),3);
 await snap('workflow-'+theme+'-'+(mobile?'mobile':'desktop'),mobile?(theme==='light'?'aa0TQ':'Ae0n6'):(theme==='light'?'C2sfEo':'s0JzCL'),theme,viewport);
}
await page.setViewportSize({width:402,height:854});await page.locator('[data-slot="wb-import"]').click();
await page.locator('[data-slot="wb-import-text"]').fill('name: [');await page.locator('[data-slot="wb-import-run"]').click();await page.locator('[data-slot="wb-import-error"]').waitFor();
assert.equal(await page.locator('[data-slot="wb-import-text"]').inputValue(),'name: [');
await snap('real-parser-error','MF4eF','dark',{width:402,height:854});
const yaml='name: fixture-ui-roundtrip\ndescription: Browser persisted fixture\nsteps:\n  - id: custom\n    name: Custom prompt\n    skill: fixture-audit\n    prompt: Preserve this explicit prompt exactly.\n  - id: check\n    name: Verify locally\n    command: git diff --check\n';
await page.locator('[data-slot="wb-import-text"]').fill(yaml);await page.locator('[data-slot="wb-import-run"]').click();await page.locator('[data-slot="wb-import-panel"]').waitFor({state:'hidden'});
assert.equal(await page.locator('[data-slot="wb-name"]').inputValue(),'fixture-ui-roundtrip');
await page.getByRole('button',{name:'Move step 1 down',exact:true}).click();
await page.locator('[data-slot="wb-yaml-toggle"]').click();assert.match(await page.locator('[data-slot="wb-yaml"]').innerText(),/Preserve this explicit prompt exactly/);
const saved=page.waitForResponse(r=>r.url().endsWith('/workflows')&&r.request().method()==='POST');await page.locator('[data-slot="wb-save"]').click();assert.equal((await saved).status(),201);
let disk=readFileSync(proof.repo+'/.ai/cezar/workflows/fixture-ui-roundtrip.yaml','utf8');assert.match(disk,/Preserve this explicit prompt exactly/);assert.ok(disk.indexOf('id: check')<disk.indexOf('id: custom'));
await page.locator('[data-slot="wb-save"]').click();await page.locator('[data-slot="wb-overwrite-dialog"]').waitFor();await snap('real-overwrite','KwkJs','dark',{width:402,height:854});
const overwritten=page.waitForResponse(r=>r.url().endsWith('/workflows')&&r.request().method()==='POST');await page.locator('[data-slot="wb-overwrite-confirm"]').click();assert.equal((await overwritten).status(),201);
await page.reload();await page.locator('[data-slot="wb-step"]').first().waitFor();
// Explicitly load persisted name after reloading the original fixture route.
await page.goto(proof.baseUrl+'/p/default/workflows/fixture-ui-roundtrip');await page.locator('[data-slot="wb-step"]').first().waitFor();assert.equal(await page.locator('[data-slot="wb-step"]').count(),2);assert.match(await page.locator('[data-slot="wb-step"]').first().innerText(),/Verify locally/);
await page.locator('[data-slot="wb-delete"]').click();const deleted=page.waitForResponse(r=>r.request().method()==='DELETE');await page.locator('[data-slot="wb-delete-confirm"]').click();assert.equal((await deleted).status(),200);
writeFileSync(new URL('proof.json',out),JSON.stringify({checkedAt:new Date().toISOString(),captures,writes,checks:['local skill discovery and body','real YAML parser error preserves input','successful import','mobile reorder','explicit prompt survives skill reference','YAML matches persisted file','save, conflict and overwrite','reload persisted steps','delete isolated fixture workflow']},null,2));
await browser.close();console.log('PASS: 10 real-API browser captures and persisted workflow round trip.');
