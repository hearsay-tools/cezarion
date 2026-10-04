/**
 * #795 native semantic regression for the observed visible-before-stable phase.
 * The fixture owns its document. It returns native boxes unchanged and schedules
 * the measured 60px shift between center sampling and trusted input dispatch.
 * This is controlled ordering proof, not an original failing pointer recording.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { AgentBrowser } from '../agent-browser'
import { clickAppearanceControl, type AppearanceControl } from '../appearance-control'

const chosen = process.argv[2] ?? 'desktop-theme'
const [size, kind] = chosen.split('-')
assert.ok(size === 'desktop' || size === 'phone')
assert.ok(kind === 'theme' || kind === 'width')
const control: AppearanceControl = kind
const value = control === 'theme' ? 'dark' : 'wide'
const previous = control === 'theme' ? 'light' : 'narrow'
const lateCompletion = process.argv.includes('--late-completion')
const server = spawn(process.execPath, ['--input-type=module', '-e', `
  import {createServer} from 'node:http';
  const server=createServer((req,res)=>{
    if(req.url==='/completion') {
      // Delayed response fixture, not an observation sleep or an action timeout.
      setTimeout(()=>{res.setHeader('Content-Type','application/json');res.end('{}')},400);
      return;
    }
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body></body></html>');
  });
  server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
`], { stdio: ['ignore', 'pipe', 'inherit'] })
if (!server.stdout) throw new Error('fixture server has no stdout')
const [data] = await once(server.stdout, 'data')
const browser = AgentBrowser.open(`e2e-appearance-action-${process.pid}`)
try {
  browser.goto(`http://127.0.0.1:${Number(String(data).trim())}`)
  browser.setViewport(size === 'desktop' ? 1440 : 360, size === 'desktop' ? 900 : 640)
  browser.evaluate(`(() => {
    const group=document.createElement('div');
    group.dataset.slot='appearance-${control}';
    group.style.cssText='position:absolute;left:${size === 'desktop' ? 408.921875 : 40}px;top:286px;display:flex;gap:10px';
    for (const [value,width] of [['${previous}',64.65625],['${value}',63.53125]]) {
      const button=document.createElement('button');button.dataset.value=value;button.textContent=value;
      button.style.cssText='box-sizing:border-box;width:'+width+'px;height:45.5px';
      button.setAttribute('role','radio');button.setAttribute('aria-checked',String(value==='${previous}'));group.append(button);
    }
    document.body.append(group);window.__events=[];window.__rects=[];window.__cezIdle=${!lateCompletion};
    window.__completionStarted=performance.now();window.__completedAt=null;
    if (${lateCompletion}) fetch('/completion').then(response=>response.json()).then(()=>{
      group.style.transform='translateX(60px)';window.__completedAt=performance.now();window.__cezIdle=true;
    });
    localStorage.setItem('cez-${control}','${previous}');
    document.documentElement.classList.add('light');
    group.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      for (const child of group.children)child.setAttribute('aria-checked',String(child===button));
      localStorage.setItem('cez-${control}',button.dataset.value);
      if('${control}'==='theme')document.documentElement.classList.toggle('light',button.dataset.value==='light');
    });
    for(const type of ['pointermove','pointerdown','pointerup','click'])document.addEventListener(type,event=>window.__events.push({type,value:event.target.closest('button')?.dataset.value,trusted:event.isTrusted,x:event.clientX,y:event.clientY,completed:window.__cezIdle,elapsed:performance.now()-window.__completionStarted}),true);
    const target=group.lastElementChild, nativeRect=target.getBoundingClientRect.bind(target);
    target.getBoundingClientRect=()=>{
      const rect=nativeRect();window.__rects.push({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
      // The selector wait observes the first native box. A late layout commit is
      // deliberately interleaved after the next box read, before pointer dispatch.
      // No fabricated box, DOM click, action retry, delay or altered assertion.
      if(!${lateCompletion} && window.__rects.length===2)queueMicrotask(()=>{group.style.transform='translateX(60px)'});
      return rect;
    };
  })()`)
  let actionError: unknown
  try { clickAppearanceControl(browser, control, value) } catch (error) { actionError = error }
  const result = browser.evaluate(`({events:window.__events,rects:window.__rects,stored:localStorage.getItem('cez-${control}'),selected:document.querySelector('[aria-checked="true"]')?.dataset.value,light:document.documentElement.classList.contains('light')})`) as {
    events: Array<{ type: string; value: string; trusted: boolean; completed: boolean; elapsed: number }>; stored: string; selected: string; light: boolean
  }
  console.log(JSON.stringify({ chosen, lateCompletion, actionError: actionError instanceof Error ? actionError.message : actionError, result }, null, 2))
  if (actionError) throw actionError
  assert.equal(result.events.find(event => event.type === 'click' && event.trusted)?.value, value)
  if (lateCompletion) {
    const click = result.events.find(event => event.type === 'click' && event.trusted)
    assert.equal(click?.completed, true, 'native input must follow the named delayed completion')
    assert.ok(click && click.elapsed >= 400, 'fixture completion exceeded the unchanged 200ms geometry hold')
  }
  assert.equal(result.selected, value)
  assert.equal(result.stored, value)
  if (control === 'theme') assert.equal(result.light, false)
} finally {
  browser.close()
  server.kill('SIGTERM')
  await once(server, 'exit')
}
