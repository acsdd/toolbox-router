// Start the bundled Node and MCP with synthetic credentials and an isolated home.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveUpstreamCredential } from '../src/upstream-credential.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const bundleIndex=process.argv.indexOf('--bundle')
if(bundleIndex>=0 && !process.argv[bundleIndex+1])throw new Error('--bundle needs a directory path.')
const bundle=bundleIndex>=0?resolve(process.argv[bundleIndex+1]):join(root,'dist','portable-preview'),parent=join(root,'test-mcp')
await mkdir(parent,{recursive:true});const home=await mkdtemp(join(parent,'portable-check-'))
const listener=createServer();await new Promise((ok,fail)=>{listener.once('error',fail);listener.listen(0,'127.0.0.1',ok)})
const port=listener.address().port;await new Promise(ok=>listener.close(ok))
const exe=join(bundle,'node.exe'),mcp=join(bundle,'mcp'),live=process.argv.includes('--live')
const upstreamKey=live?resolveUpstreamCredential(process.env).apiKey:'synthetic-only'
if(!upstreamKey)throw new Error('The live check needs a configured AstrLink provider credential.')
const child=spawn(exe,[join(bundle,'router','src','server.mjs')],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,TOOLBOX_ROUTER_HOST:'127.0.0.1',TOOLBOX_ROUTER_PORT:String(port),TOOLBOX_ROUTER_MODE:'bridge',TOOLBOX_ROUTER_API_KEY:'portable-check-key',TOOLBOX_ROUTER_UPSTREAM_API_KEY:upstreamKey,TOOLBOX_ROUTER_MCP_COMMAND:exe,TOOLBOX_ROUTER_MCP_ARGS:JSON.stringify([join(mcp,'dist','index.js')]),TOOLBOX_ROUTER_MCP_CWD:mcp,TOOLBOX_ROUTER_MCP_HOME:home}})
let diagnostics='';child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-4000)})
try{
 let ready=false;for(let i=0;i<220;i++){if(child.exitCode!==null)throw new Error('Bundled Router exited before readiness.');try{const r=await fetch(`http://127.0.0.1:${port}/health`);const h=await r.json();if(h.mode==='bridge'&&h.mcp?.ready===true){ready=true;break}}catch{}await delay(100)}
 if(!ready)throw new Error(`Bundled Router did not become ready. ${diagnostics.replaceAll(upstreamKey,'[redacted]')}`)
 const r=await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{authorization:'Bearer portable-check-key'}})
 if(!r.ok)throw new Error('Bundled Router model endpoint failed.')
 if(live){
  const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer portable-check-key','content-type':'application/json'},body:JSON.stringify({model:'toolbox-spike',messages:[{role:'user',content:'Call crypto_status with an empty object and briefly summarize the result.'}],tool_choice:{type:'function',function:{name:'crypto_status'}},max_tokens:120,stream:false}),signal:AbortSignal.timeout(120000)})
  const body=await response.json();if(!response.ok || !(body?.toolbox?.rounds>=2))throw new Error(`Portable live tool check failed (HTTP ${response.status}).`)
 }
 console.log(live?'Portable Router → AstrLink → bundled MCP live tool check passed.':'Portable Router and bundled Toolbox MCP passed the isolated startup check.')
} finally {
 if(child.exitCode===null){child.send({type:'shutdown'});await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(5000)]);if(child.exitCode===null)child.kill()}
 await rm(home,{recursive:true,force:true})
}
