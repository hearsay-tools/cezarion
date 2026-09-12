import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const qa=resolve('.ai/qa/shell-current193'), browser=resolve('.ai/qa/runtime-verified/browser.sh')
const env={...process.env,RUNTIME_BROWSER_SESSION:'shell-clipping'}
const run=(...args)=>execFileSync(browser,args,{env,encoding:'utf8'}).trim()
const evaluate=js=>JSON.parse(run('eval',js))
const address=new URL(run('get','cdp-url'))
const pages=await(await fetch(`http://${address.host}/json/list`)).json()
const ws=new WebSocket(pages.find(p=>p.url.startsWith('http://127.0.0.1:44740')).webSocketDebuggerUrl)
await new Promise(r=>ws.onopen=r)
let id=0
const request=(method,params)=>new Promise((resolve,reject)=>{const next=++id;ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===next)m.error?reject(m.error):resolve(m.result)};ws.send(JSON.stringify({id:next,method,params}))})
const rows=[]
async function capture(name,selector) {
 const state=evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing open state');return {viewport:{width:innerWidth,height:innerHeight},theme:document.documentElement.className,rect:e.getBoundingClientRect().toJSON(),text:e.innerText,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}})()`)
 if(state.rect.left<0||state.rect.right>state.viewport.width)throw Error('Clipped '+name)
 const image=await request('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
 writeFileSync(qa+'/'+name+'.png',Buffer.from(image.data,'base64'))
 rows.push({name,...state})
}
await request('Emulation.setDeviceMetricsOverride',{width:402,height:1260,deviceScaleFactor:2,mobile:false})
run('open','http://127.0.0.1:44740/p/iac/new');run('wait','700');run('find','role','button','click','--name','Base branch');run('wait','250')
await capture('mobile-base-branch-after','[data-testid=base-pill-menu]')
run('press','Escape');run('wait','250')
for(const theme of ['light','dark']) {
 run('set','viewport','1440','1161')
 await request('Emulation.setDeviceMetricsOverride',{width:1440,height:1161,deviceScaleFactor:2,mobile:false})
 run('open','http://127.0.0.1:44740/p/iac/github');run('wait','700')
 for(let n=0;n<3;n++) {
  if(evaluate("document.querySelector('[data-slot=theme-toggle]').dataset.themePref")===theme)break
  run('eval',"document.querySelector('[data-slot=theme-toggle]').click()");run('wait','150')
 }
 run('find','role','button','click','--name','Tools');run('wait','250')
 await capture('tools-'+theme+'-open','[data-slot=tools-menu-content]')
 run('press','Escape');run('wait','250')
 run('find','role','button','click','--name','Search…');run('wait','250')
 await capture('palette-'+theme+'-open','[data-slot=dialog-content]')
 run('press','Escape');run('wait','250')
 for(const [key,width] of [['End',420],['Home',264]]) {
  run('focus','[data-slot=sidebar-resize-handle]');run('press',key);run('wait','250')
  const actual=evaluate("document.querySelector('[data-slot=sidebar]').getBoundingClientRect().width")
  if(actual!==width)throw Error('Resize failed '+actual)
  await capture('resize-'+width+'-'+theme,'[data-slot=sidebar]')
  rows.at(-1).trigger='Focused separator then '+key
  rows.at(-1).persisted=evaluate("localStorage.getItem('cez-sidebar-width')")
 }
 for(const mobile of [false,true]) {
  if(mobile) {
   run('set','viewport','402','1260')
   await request('Emulation.setDeviceMetricsOverride',{width:402,height:1260,deviceScaleFactor:2,mobile:false})
   run('find','role','button','click','--name','Open menu');run('wait','250')
  }
  run('find','role','button','click','--name','Add project');run('wait','250')
  await capture('add-project-'+theme+(mobile?'-mobile':'-desktop'),'[data-slot=dropdown-menu-content]')
  run('press','Escape');run('wait','250')
  if(mobile) {
   run('find','role','button','click','--name','Tools');run('wait','250')
   await capture('tools-'+theme+'-mobile','[data-slot=tools-menu-content]')
   run('press','Escape');run('wait','250')
   run('find','role','button','click','--name','Search…');run('wait','250')
   await capture('palette-'+theme+'-mobile','[data-slot=dialog-content]')
   run('press','Escape');run('wait','250')
   run('press','Escape');run('wait','250')
  }
 }
}
writeFileSync(qa+'/shared-states.json',JSON.stringify(rows,null,2));ws.close()
