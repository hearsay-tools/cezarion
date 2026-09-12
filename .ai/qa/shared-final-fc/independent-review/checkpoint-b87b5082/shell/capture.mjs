import {chromium} from '/tmp/cez160-webkit/node_modules/playwright/index.mjs';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const out=resolve('.ai/qa/runtime-verified/independent-review/shell'),base='http://127.0.0.1:44864';
const browser=await chromium.launch({headless:false,executablePath:'/home/agent/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox']});
const sessionContext=await browser.newContext({deviceScaleFactor:1,reducedMotion:'reduce'}); let page=await sessionContext.newPage();
await page.route('**/github/ref-status*',r=>r.fulfill({json:{available:true,prs:{217:'merged',91:'review-required'},issues:{214:'open',298:'open'},recheckAfterMs:null}}));
const results=[];
const root=resolve('packages/cezar/web/dist'),sha=b=>createHash('sha256').update(b).digest('hex');
for(const file of ['index.html',...readdirSync(root+'/assets').map(f=>'assets/'+f)]){
 const local=sha(readFileSync(root+'/'+file)),served=sha(Buffer.from(await(await fetch(base+'/'+file)).arrayBuffer()));assert.equal(served,local,file);
 results.push({asset:file,sha256:local});
}
writeFileSync(out+'/served-assets.json',JSON.stringify(results,null,2));results.length=0;
async function shot(name,ref=null){await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(700);await page.screenshot({path:out+'/'+name+'.png'});results.push({name,reference:ref,url:page.url(),...await page.evaluate(()=>({viewport:[innerWidth,innerHeight],theme:document.documentElement.className,font:getComputedStyle(document.body).fontFamily,hover:matchMedia('(hover:hover)').matches,sidebar:(document.querySelector('[data-slot="mobile-nav-drawer"]') ?? document.querySelector('[data-slot="sidebar"]'))?.getBoundingClientRect().toJSON(),attention:[...document.querySelectorAll('[data-slot="project-attention"]')].map(e=>({text:e.textContent,width:e.getBoundingClientRect().width})),more:[...document.querySelectorAll('[data-slot="project-group-more"]')].map(e=>({text:e.textContent,height:e.getBoundingClientRect().height})),overflow:document.documentElement.scrollWidth>innerWidth}))});writeFileSync(out+'/pairs.json',JSON.stringify(results,null,2));}
for(const theme of ['light','dark'])for(const width of [264,420]){
 await page.setViewportSize({width:1440,height:1900});await page.addInitScript(({theme,width})=>{localStorage.setItem('cez-theme',theme);localStorage.setItem('cez-sidebar-width',String(width));localStorage.setItem('cez-sidebar-collapsed',JSON.stringify({website:false,earwitness:true}));},{theme,width});
 await page.goto(base+'/p/iac/github');await page.locator('[data-slot="project-attention"]').first().waitFor();await page.locator('[data-slot="sidebar-resize-handle"]').hover();
 await shot('desktop-'+theme+'-'+width,theme==='light'?(width===264?'t5OS8c':'IbsZT'):(width===264?'wDyFh':'IFqhi'));
 const handle=page.getByRole('separator',{name:/sidebar/i});await handle.focus();await page.keyboard.press('Home');assert.equal(await page.locator('[data-slot="sidebar"]').evaluate(e=>e.getBoundingClientRect().width),264);await page.keyboard.press('End');assert.equal(await page.locator('[data-slot="sidebar"]').evaluate(e=>e.getBoundingClientRect().width),420);
}
for(const theme of ['light','dark'])for(const mobile of [false,true]){
 await page.setViewportSize({width:mobile?402:1440,height:mobile?1260:1120});await page.addInitScript(theme=>localStorage.setItem('cez-theme',theme),theme);await page.goto(base+'/p/iac/tasks/10000000-0000-4000-8000-000000000000');await page.waitForTimeout(600);
 if(mobile){await page.getByRole('button',{name:'Open menu',exact:true}).click();await shot('mobile-'+theme+'-drawer',theme==='light'?'h690uO':'L0VfI');}
 for(const [label,key] of [['Tools','tools'],['Add project','add-project'],['Search…','palette']]){
 await page.getByRole('button',{name:label,exact:true}).click();await shot(key+'-'+theme+'-'+(mobile?'mobile':'desktop'));await page.keyboard.press('Escape');await page.waitForTimeout(250);
 }
 if(mobile)await page.keyboard.press('Escape');
}
const context=page.context(); const previous=page; page=await context.newPage(); await previous.close();
// Real navigation distinguishes disclosure from the project link, and persists collapse.
await page.setViewportSize({width:1440,height:1120});await page.goto(base+'/p/iac/skills');
const toggle=page.getByRole('button',{name:'Toggle website',exact:true});await toggle.click({position:{x:10,y:20}});assert.equal(await toggle.getAttribute('aria-expanded'),'false');await page.reload();assert.equal(await toggle.getAttribute('aria-expanded'),'false');await toggle.click({position:{x:10,y:20}});await page.getByRole('link',{name:'Open website',exact:true}).click();assert.match(page.url(),/\/p\/website/);
await shot('project-navigation');
await page.getByRole('button',{name:'Tools',exact:true}).click();await shot('archive-control');
writeFileSync(out+'/behavior.json',JSON.stringify({resizeHomeEnd:true,collapsePersists:true,projectLinkNavigates:true},null,2));
await browser.close();
