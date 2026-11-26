// Explicit live check: synthetic Qoder-style request, AstrLink and isolated MCP.
// The model provider receives only the synthetic prompt and a public crypto status.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.mjs";
import { ToolboxMcpBridge } from "../src/mcp-bridge.mjs";
import { createRouterServer } from "../src/server.mjs";
import { createUpstreamClient } from "../src/upstream.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const parent=join(root,"test-mcp");await mkdir(parent,{recursive:true});
const home=await mkdtemp(join(parent,"live-flow-"));
let bridge,server;
const logger={info(){},error(){}};
try {
  const config=parseConfig({ ...process.env, TOOLBOX_ROUTER_API_KEY:"synthetic-live-check-key", TOOLBOX_ROUTER_HOST:"127.0.0.1", TOOLBOX_ROUTER_MODE:"bridge", TOOLBOX_ROUTER_MCP_RUNTIME:"source", TOOLBOX_ROUTER_MCP_COMMAND:process.execPath, TOOLBOX_ROUTER_MCP_ARGS:JSON.stringify([resolve(root,"../toolbox-mcp/dist/index.js")]), TOOLBOX_ROUTER_MCP_CWD:resolve(root,"../toolbox-mcp"), TOOLBOX_ROUTER_MCP_HOME:home });
  bridge=new ToolboxMcpBridge({config,logger});await bridge.start();
  if(!bridge.registry.has("crypto_status"))throw new Error("The test tool was not discovered.");
  const upstream=createUpstreamClient({...config.upstream,logger});
  server=createRouterServer({config,bridge,upstream,logger});
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen)});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{
    method:'POST',headers:{authorization:`Bearer ${config.apiKey}`,'content-type':'application/json'},
    body:JSON.stringify({model:config.models[0].id,messages:[{role:'user',content:'Call crypto_status with an empty object and briefly summarize the result.'}],tool_choice:{type:'function',function:{name:'crypto_status'}},max_tokens:120,stream:false}),signal:AbortSignal.timeout(120000)
  });
  const result=await response.json();
  if(!response.ok || result?.choices?.[0]?.message?.role!=='assistant' || !(result?.toolbox?.rounds>=2))throw new Error(`Live request failed (HTTP ${response.status}; completed tool round trip: ${Boolean(result?.toolbox?.rounds>=2)}).`);
  console.log('Live Qoder-compatible request → Router → AstrLink → Toolbox MCP → response passed.');
} finally {
  if(server){server.closeAllConnections();await new Promise(resolveClose=>server.close(resolveClose));}
  if(bridge)await bridge.close();
  await rm(home,{recursive:true,force:true});
}
