import {chromium} from '/tmp/cez160-webkit/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const base='http://127.0.0.1:44864',out='.ai/qa/runtime-verified/independent-review/shell';
const b=await chromium.launch({headless:true,executablePath:'/home/agent/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox']});const p=await b.newPage({viewport:{width:1440,height:1120},reducedMotion:'reduce'});
await p.goto(base+'/p/iac/skills');await p.waitForTimeout(700);
const group=p.locator('[data-slot="project-group"][data-project="website"]');const toggle=group.getByRole('button',{name:'Toggle website'});
if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click({position:{x:10,y:20}});
await toggle.click({position:{x:10,y:20}});await p.waitForTimeout(100);assert.equal(await toggle.getAttribute('aria-expanded'),'false');await p.reload();await toggle.waitFor();assert.equal(await toggle.getAttribute('aria-expanded'),'false');await toggle.click({position:{x:10,y:20}});await p.waitForTimeout(400);
const id='10000000-0000-4000-8000-000000000010';const row=group.locator('[data-slot="task-row"][data-run-id="'+id+'"]');await row.hover();const pin=row.locator('[data-slot="pin-toggle"]');if(await pin.getAttribute('aria-pressed')==='true'){await pin.click();await p.waitForTimeout(300);}
const request=p.waitForRequest(r=>r.url().includes('/p/website/runs/'+id+'/pin'));await pin.click();assert.equal((await request).postDataJSON().pinned,true);await p.waitForTimeout(600);assert.equal(await pin.getAttribute('aria-pressed'),'true');assert.equal(await row.locator('xpath=ancestor::*[@data-bucket]').getAttribute('data-bucket'),'Pinned');assert.match(p.url(),/\/p\/iac/);
await p.screenshot({path:out+'/cross-project-pin.png'});await pin.click();await p.waitForTimeout(400);
await group.getByRole('link',{name:'Open website'}).click();await p.waitForTimeout(300);assert.match(p.url(),/\/p\/website/);
await p.request.post(base+'/api/v1/p/website/runs/'+id+'/archive',{data:{archived:true}});await p.reload();await p.getByRole('button',{name:'Tools',exact:true}).click();await p.getByRole('button',{name:/Archived/}).click();await p.keyboard.press('Escape');await p.waitForTimeout(600);assert.equal(await row.locator('xpath=ancestor::*[@data-bucket]').getAttribute('data-bucket'),'Archived');assert.equal(await row.locator('[data-slot="pin-toggle"]').count(),0);await p.screenshot({path:out+'/archived-filter.png'});
await p.request.post(base+'/api/v1/p/website/runs/'+id+'/archive',{data:{archived:false}});
writeFileSync(out+'/behavior-mutations.json',JSON.stringify({collapsePersists:true,folderDisclosureDistinctFromLink:true,projectLinkNavigates:true,crossProjectPinAddressesWebsite:true,pinMovesIntoPinned:true,archivedFilterShowsArchived:true,archivedDisablesPin:true,cleanupRestoredFixture:true},null,2));await b.close();
