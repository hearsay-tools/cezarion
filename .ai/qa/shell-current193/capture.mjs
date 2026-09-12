import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { githubRefStatusDataSchema } from '../../../packages/cezar/dist/contract/index.js'
const qa=resolve('.ai/qa/shell-current193'), browser=resolve('.ai/qa/runtime-verified/browser.sh')
const env={...process.env,RUNTIME_BROWSER_SESSION:'shell-a439-headed'}
const run=(...args)=>execFileSync(browser,args,{env,encoding:'utf8'}).trim()
const base='http://127.0.0.1:44740'
const mock=githubRefStatusDataSchema.parse({available:true,prs:{217:'merged',91:'review-required'},issues:{214:'open',298:'open'},recheckAfterMs:null})
writeFileSync(qa+'/reference-status-mocks.json',JSON.stringify(mock,null,2))
for(const prefix of ['/api/v1','/api/v1/p/*'])run('network','route',base+prefix+'/github/ref-status*','--body',JSON.stringify(mock))
const address=new URL(run('get','cdp-url'));const pages=await(await fetch(`http://${address.host}/json/list`)).json();const page=pages.find(p=>p.url.startsWith(base));const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r)
let next=0;const req=(method,params)=>new Promise((res,rej)=>{const id=++next;ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===id)m.error?rej(m.error):res(m.result)};ws.send(JSON.stringify({id,method,params}))})
async function shot(name,width,height) {
 const snap=await req('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false,clip:{x:0,y:0,width,height,scale:1}})
 writeFileSync(qa+'/'+name+'.png',Buffer.from(snap.data,'base64'))
}
const results=[]
async function capture(name,width,height,theme,sidebarWidth,mobile=false) {
 run('set','viewport',String(width),String(height))
 await req('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
 await req('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:2,mobile:false})
 run('eval',`localStorage.setItem('cez-theme',${JSON.stringify(theme)});localStorage.setItem('cez-sidebar-width',${JSON.stringify(String(sidebarWidth))});localStorage.setItem('cez-sidebar-collapsed',JSON.stringify({website:false,earwitness:true}));`)
 run('open',base+(mobile?'/p/iac/tasks/10000000-0000-4000-8000-000000000000':'/p/iac/github'))
 run('reload');run('wait','1500')
 for(let attempt=0;attempt<3;attempt++) {
   const pref=JSON.parse(run('eval',"document.querySelector('[data-slot=theme-toggle]').dataset.themePref"))
   if(pref===theme)break
   run('eval',"document.querySelector('[data-slot=theme-toggle]').click()");run('wait','150')
 }
 if(mobile) {run('find','role','button','click','--name','Open menu');run('wait','500')}
 const state=JSON.parse(run('eval',`JSON.stringify({theme:document.documentElement.className,density:document.documentElement.dataset.density??'comfortable',font:getComputedStyle(document.body).fontFamily,hover:matchMedia('(hover:hover)').matches,viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,sidebar:document.querySelector(${JSON.stringify(mobile?'[data-slot="mobile-nav-drawer"]':'[data-slot="sidebar"]')})?.getBoundingClientRect().toJSON(),rows:document.querySelectorAll('[data-slot="task-row"]').length,overflow:document.documentElement.scrollWidth>innerWidth})`))
 if(!mobile)run('hover','[data-slot=sidebar-resize-handle]');
 const details=JSON.parse(state);if((details.theme==='light')!==(theme==='light'))throw new Error('Theme mismatch '+name);await shot(name,width,height);results.push({name,...details})
 if(mobile)run('press','Escape');run('wait','250')
}
await capture('desktop-light-264',1440,1900,'light',264)
await capture('desktop-dark-264',1440,1900,'dark',264)
await capture('desktop-light-420',1440,1900,'light',420)
await capture('desktop-dark-420',1440,1900,'dark',420)
await capture('mobile-light-drawer',402,1260,'light',264,true)
await capture('mobile-dark-drawer',402,1260,'dark',264,true)
await capture('desktop-light-base',1440,1161,'light',264)
writeFileSync(qa+'/browser-environment.json',JSON.stringify(results,null,2));
run('find','role','button','click','--name','Tools');run('wait','200');await shot('tools-light',1440,1161);run('press','Escape');run('wait','250')
run('find','role','button','click','--name','Search…');run('wait','200');await shot('palette-light',1440,1161);run('press','Escape');run('wait','250')
writeFileSync(qa+'/browser-environment.json',JSON.stringify(results,null,2));ws.close()
console.log('Saved '+results.length+' paired-state captures and Tools/palette evidence')
