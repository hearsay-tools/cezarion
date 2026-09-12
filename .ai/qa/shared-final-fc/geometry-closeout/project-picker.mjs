import {chromium} from '/tmp/cez160-webkit/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const out='.ai/qa/runtime-verified/geometry-closeout';
const browser=await chromium.launch({headless:true,executablePath:'/home/agent/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox']});
const results=[];
for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width:402,height:900},reducedMotion:'reduce'});await context.addInitScript(t=>localStorage.setItem('cez-theme',t),theme);const page=await context.newPage();await page.goto('http://127.0.0.1:44864/p/iac/skills');const picker=page.getByRole('button',{name:'Switch project: iac'});await picker.waitFor();await picker.click();const drawer=page.locator('[data-slot="mobile-nav-drawer"]');await drawer.waitFor();await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});await page.waitForTimeout(50);assert(await picker.evaluate(e=>document.activeElement===e));
 await page.keyboard.press('Enter');await drawer.waitFor();await page.waitForTimeout(250);await page.screenshot({path:out+'/project-picker-'+theme+'.png'});
 await drawer.getByRole('link',{name:'Open website',exact:true}).click();await page.waitForURL('**/p/website/');await drawer.waitFor({state:'hidden'});await page.getByRole('button',{name:'Switch project: website'}).waitFor();
 const menu=page.getByRole('button',{name:'Open menu'});await menu.click();await drawer.waitFor();await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});await page.waitForTimeout(50);assert(await menu.evaluate(e=>document.activeElement===e));
 const rect=await page.getByRole('button',{name:'Switch project: website'}).boundingBox();assert(rect.height>=44);results.push({theme,opensByPointer:true,opensByKeyboard:true,projectLinkNavigates:true,projectFocusRestored:true,menuFocusRestored:true,pickerBounds:rect,url:page.url()});await context.close();
}
writeFileSync(out+'/project-picker.json',JSON.stringify(results,null,2));await browser.close();console.log('Mobile project picker: both themes, real navigation, keyboard and focus pass');
