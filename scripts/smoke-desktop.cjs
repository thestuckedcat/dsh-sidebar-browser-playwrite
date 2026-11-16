const assert = require('node:assert/strict')
const {spawn, spawnSync} = require('node:child_process')
const {once} = require('node:events')
const {cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync} = require('node:fs')
const {createServer} = require('node:http')
const {join, resolve} = require('node:path')
const {tmpdir} = require('node:os')
const {setTimeout: sleep} = require('node:timers/promises')

const source = resolve(__dirname, '..')
const manifest = JSON.parse(readFileSync(join(source, 'package.json')))
const smoke = 'sidebar-smoke-driver'
const scratch = mkdtempSync(join(tmpdir(), 'dsh-sidebar-package-smoke-'))
const home = join(scratch, 'home')
const profile = join(home, 'profiles', 'desktop')
const modules = join(profile, 'node_modules')
const executable = process.argv[2] ?? 'E:/dsh/DeepSeek Harness.exe'
const tarball = process.argv[4]
const diagnostic = join(scratch, 'fatal.json')
const hits = []
const result = {}
let desktop, stderr = ''
const server = createServer((req, res) => {
  hits.push(req.url)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (req.url === '/hang') {
    res.write('<!doctype html><title>Incomplete fixture</title>')
    return
  }
  res.end(`<!doctype html><title>Native sidebar fixture</title><main>
    <h1>Shared fixture</h1><button onclick="if(event.isTrusted)document.querySelector('h1').textContent='Clicked in the visible guest'">Update heading</button>
    <a href="/popup" target="_blank">Open popup</a>
    <label for="note">Note</label><input id="note" onkeydown="if(event.key==='Enter')this.dataset.entered='true'" oninput="document.querySelector('output').textContent=this.value">
    <output aria-live="polite"></output><label for="secret">Secret</label><input id="secret" type="password" value="synthetic-secret">
  </main>`)
})
function put(path, value) { writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2)) }
const redact = value => String(value).replace(/(https?:\/\/[^\s?#]+)\?[^\s]+/g, '$1?[redacted]')

function prepare() {
  const installed = join(modules, manifest.name)
  const driver = join(modules, smoke)
  mkdirSync(installed, {recursive: true})
  mkdirSync(driver, {recursive: true})
  if (tarball) {
    const unpack = spawnSync('tar.exe', ['-xf', resolve(tarball), '-C', installed, '--strip-components=1'], {windowsHide: true})
    assert.equal(unpack.status, 0, String(unpack.stderr))
    assert.ok(existsSync(join(installed, 'docs', 'mechanisms.md')))
  } else {
    for (const path of ['package.json', 'lib', 'cordis.patch.yml']) cpSync(join(source, path), join(installed, path), {recursive: true})
  }
  for (const dependency of Object.keys(manifest.dependencies)) {
    const real = require('node:fs').realpathSync(join(source, 'node_modules', dependency))
    cpSync(real, join(installed, 'node_modules', dependency), {recursive: true})
  }
  put(join(driver, 'package.json'), {name: smoke, version:'0.0.1', type:'module',
    exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},
    dsh:{bundle:{patch:'./patch.yml'}, client:{platform:'web',inject:['@deepseek-ai/dsh-client-connection','@deepseek-ai/dsh-client-ui-session','@deepseek-ai/dsh-client-ui-sidebar-right']}}})
  cpSync(join(source, 'tests', 'desktop-smoke-driver.mjs'), join(driver, 'index.mjs'))
  put(join(driver, 'patch.yml'), '- insert:\n    - id: '+smoke+'\n      name: '+smoke+'\n')
  put(join(driver, 'client.js'), `window.__ModuleLoader__.load({id:'${smoke}',factory:()=>({
    inject:['connection','uiSession','sidebarRight'],
    apply(ctx) {
      const session=()=>ctx.uiSession.adapter.current.getSnapshot().key;
      globalThis.dshSidebarSmoke={session, split:()=>{
        const pane=ctx.sidebarRight.split();
        if(pane)ctx.sidebarRight.openTab('guide',{paneId:pane});
        return pane;
      }, active:()=>ctx.sidebarRight.active()?.id,
        invoke:async(name,args,timeoutMs)=>{
        const result=await ctx.connection.rpc.call('/sidebar-smoke-driver','invoke',{sessionId:session(), name,args,timeoutMs});
        return result.value ?? result;
      }};
    }
  })});`)
  put(join(profile, 'package.json'), {name:'dsh-profile-desktop',private:true,
    dependencies:{[manifest.name]: manifest.version,[smoke]:'0.0.1'},
    dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',manifest.name,smoke]}}})
  put(join(profile, 'cordis.patch.yml'), '- id: desktop-product-telemetry\n  disabled: true\n')
}

function connect(child) {
  const input = child.stdio[3]
  const output = child.stdio[4]
  const pending = new Map()
  let buffer = '', next = 0
  input.on('error', () => {})
  output.setEncoding('utf8')
  output.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      pending.get(message.id)?.(message)
    }
  })
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')) }, 15000)
    pending.set(id, response => {
      clearTimeout(timeout)
      pending.delete(id)
      if (response.error) reject(new Error(response.error.message))
      else resolve(response.result)
    })
    input.write(JSON.stringify({id, method, params, sessionId}) + '\0')
  })
}

async function client(request) {
  const sessions = new Map()
  let skipped = false
  async function evalIn(sessionId, expression) {
    const reply = await request('Runtime.evaluate',{expression, awaitPromise:true, returnByValue:true},sessionId)
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
    return reply.result.value
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const {type, url, targetId} of (await request('Target.getTargets')).targetInfos) {
      if (type !== 'page' || (!url.includes('welcome.html') && !url.startsWith('dsh-app://app'))) continue
      if (!sessions.has(targetId)) sessions.set(targetId,(await request('Target.attachToTarget',{targetId,flatten:true})).sessionId)
      const session = sessions.get(targetId)
      if (url.includes('welcome.html') && !skipped && await evalIn(session,'typeof globalThis.dshWelcome?.skip === "function"')) {
        skipped = true
        await evalIn(session,'void globalThis.dshWelcome.skip()')
      }
      if (url.startsWith('dsh-app://app') && await evalIn(session,'Boolean(globalThis.dshSidebarSmoke?.session())')) {
        return (fn,...args) => evalIn(session,'('+fn.toString()+')('+args.map(value=>JSON.stringify(value)).join(',')+')')
      }
    }
    await sleep(250)
  }
  throw new Error('The Desktop session did not mount the smoke-test client.')
}

async function main() {
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  prepare()
  const env = {...process.env, DSH_HOME:home, DSH_TELEMETRY_DISABLED:'1',
    APPDATA:join(scratch,'appdata'), LOCALAPPDATA:join(scratch,'localdata'), DSH_DESKTOP_DIAGNOSTIC_FILE:diagnostic}
  delete env.ELECTRON_RUN_AS_NODE
  mkdirSync(env.APPDATA)
  mkdirSync(env.LOCALAPPDATA)
  desktop = spawn(executable,['--remote-debugging-pipe','--user-data-dir='+join(scratch,'userdata'),
    '--disable-background-networking','--proxy-server=http://127.0.0.1:1','--disable-gpu'], {
    env,cwd:scratch,windowsHide:true,stdio:['ignore','pipe','pipe','pipe','pipe'],
  })
  desktop.stdout.resume()
  desktop.stderr.on('data', chunk => stderr=(stderr+chunk).slice(-3000))
  desktop.on('error', error => stderr += String(error))
  const request = connect(desktop)
  result.browser = (await request('Browser.getVersion')).userAgent
  const evaluate = await client(request)
  result.boot = await evaluate(name=>({desktop:!!globalThis.dshDesktop?.browser, release:globalThis.__DSH_BOOT__.release,
    hasPlugin:globalThis.__DSH_BOOT__.entries.some(entry=>entry.id===name)}),manifest.name)
  assert.equal(result.boot.desktop,true)
  assert.equal(result.boot.release.version,'0.2.1-rc.5')
  assert.equal(result.boot.hasPlugin,true)
  result.loadedFrom = tarball ? 'packed plugin tarball' : 'local build'
  async function call(name, args = {}) {
    const tool = await evaluate((name,args)=>globalThis.dshSidebarSmoke.invoke(name,args),name,args)
    if (!tool || tool.isError !== false) throw new Error(name+': '+JSON.stringify(tool))
    return tool.value
  }
  const url='http://127.0.0.1:'+server.address().port+'/same-page'
  const opened=await call('browser_navigate',{url})
  assert.equal(opened.url,url)
  assert.match(opened.tree,/Shared fixture/)
  const originalTab = await evaluate(() => globalThis.dshSidebarSmoke.active())
  const splitPane = await evaluate(() => globalThis.dshSidebarSmoke.split())
  assert.ok(splitPane, 'The Desktop window must support a second sidebar pane.')
  await sleep(100)
  const focusedTab = await evaluate(() => globalThis.dshSidebarSmoke.active())
  assert.ok(focusedTab && focusedTab !== originalTab)
  const ref=(snapshot,label)=>{
    const line=snapshot.tree.split('\n').find(text=>text.includes(label) && /\bref=e\d+/.test(text))
    const match=/\bref=(e\d+)/.exec(line ?? '')
    assert.ok(match,'No ref for '+label+' in '+line)
    return match[1]
  }
  const clicked=await call('browser_click',{ref:ref(opened,'Update heading')})
  assert.match(clicked.tree,/Clicked in the visible guest/)
  const filled=await call('browser_fill',{ref:ref(clicked,'Note'),text:'same guest input'})
  await call('browser_press',{ref:ref(filled,'Note'),key:'Enter'})
  const screenshot=await call('browser_screenshot')
  assert.ok(screenshot.attachmentId && screenshot.width > 0 && screenshot.height > 0)
  assert.equal(screenshot.url, url)
  const guest=await evaluate(async()=>{
    const page=document.querySelector('[data-sidebar-agent-webview]')
    if(!page) return null
    return {webview:page.tagName, count:document.querySelectorAll('[data-sidebar-agent-webview]').length,
      visible:page.getBoundingClientRect().width>0, url:page.getURL(),
      state:await page.executeJavaScript("({heading:document.querySelector('h1').textContent, note:document.querySelector('#note').value, entered:document.querySelector('#note').dataset.entered})")}
  })
  assert.deepEqual(guest,{webview:'WEBVIEW',count:1,visible:true,url,state:{heading:'Clicked in the visible guest',note:'same guest input',entered:'true'}})
  assert.doesNotMatch(filled.tree,/synthetic-secret/)
  assert.equal((await call('browser_tabs')).tabs.length,1)
  const popup = new URL('/popup', url).href
  const afterLink = await call('browser_click',{ref:ref(filled,'Open popup')})
  assert.equal(afterLink.url, url)
  let tabs
  for (let attempt = 0; attempt < 12; attempt++) {
    tabs = (await call('browser_tabs')).tabs
    if (tabs.find(tab => tab.url === popup)) break
    await sleep(100)
  }
  assert.equal(tabs.length, 2)
  assert.equal((await call('browser_switch_tab',{index:1})).url, popup)
  await call('browser_close_tab',{index:1})
  const hang = new URL('/hang', url).href
  const cancelled = await evaluate(hang => globalThis.dshSidebarSmoke.invoke('browser_navigate', {url:hang}, 1600), hang)
  assert.equal(cancelled.isError, true, 'a hung navigation must report cancellation')
  assert.ok(hits.includes('/hang'), 'the cancellation must interrupt a dispatched navigation')
  assert.equal((await call('browser_navigate',{url})).url,url)
  await call('browser_close')
  for(let attempt=0; attempt<25; attempt++){
    if(await evaluate(()=>document.querySelectorAll('[data-sidebar-agent-webview]').length===0))break
    await sleep(40)
  }
  assert.equal(await evaluate(()=>document.querySelectorAll('[data-sidebar-agent-webview]').length),0)
  assert.ok(hits.includes('/same-page'))
  result.guest=guest
  result.split={originalTab, splitPane, focusedTab}
  result.actions=['navigate','click','fill','press','screenshot','tabs','open background popup','switch tab','close tab','cancel hung navigation','navigate again','close']
  result.httpHits=hits
  result.passed=true
}
main().catch(error=>{
  result.error=redact(error.message)
  if(stderr)result.stderr=redact(stderr)
  if(existsSync(diagnostic))result.diagnostic=redact(readFileSync(diagnostic,'utf8')).slice(0,2400)
  process.exitCode=1
}).finally(()=>{
  if(desktop?.exitCode===null && desktop.pid) spawnSync('taskkill.exe',['/PID',String(desktop.pid),'/T','/F'],{windowsHide:true})
  server.closeAllConnections()
  server.close()
  if(result.passed && process.argv[3])put(resolve(process.argv[3]),result)
  console.log(JSON.stringify(result,null,2))
})
