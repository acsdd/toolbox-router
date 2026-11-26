import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('Qoder setup upgrades only the preview Router credential and is idempotent',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'router-qoder-setup-'))
 const file=join(directory,'settings.json'),script=join(dirname(fileURLToPath(import.meta.url)),'../scripts/configure-qoder.mjs')
 const original={providers:{router:{model:'toolbox-spike',baseUrl:'http://127.0.0.1:18787/v1',apiKey:'toolbox-spike-key'},other:{model:'other',apiKey:'synthetic-upstream-key'}}}
 try{
  await writeFile(file,JSON.stringify(original))
  const env={...process.env,TOOLBOX_ROUTER_QODER_SETTINGS:file}
  const output=execFileSync(process.execPath,[script,'--secure-key','--apply'],{env,encoding:'utf8'})
  const updated=JSON.parse(await readFile(file,'utf8'))
  assert.ok(updated.providers.router.apiKey.length>=32)
  assert.notEqual(updated.providers.router.apiKey,original.providers.router.apiKey)
  assert.equal(updated.providers.other.apiKey,original.providers.other.apiKey)
  assert.ok(!output.includes(updated.providers.router.apiKey))
  const before=await readFile(file,'utf8')
  execFileSync(process.execPath,[script,'--secure-key','--apply'],{env,encoding:'utf8'})
  assert.equal(await readFile(file,'utf8'),before)
  assert.equal((await readdir(directory)).filter(x=>x.startsWith('settings.json.before-toolbox-')).length,1)
 }finally{
  for(const entry of await readdir(directory))await rm(join(directory,entry),{force:true})
  await rmdir(directory)
 }
})

test('Qoder setup replaces a whitespace-only credential',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'router-qoder-whitespace-'))
 const file=join(directory,'settings.json'),script=join(dirname(fileURLToPath(import.meta.url)),'../scripts/configure-qoder.mjs')
 try{
  await writeFile(file,JSON.stringify({providers:{router:{model:'toolbox-spike',baseUrl:'http://127.0.0.1:18787/v1',apiKey:'                '}}}))
  execFileSync(process.execPath,[script,'--secure-key','--apply'],{env:{...process.env,TOOLBOX_ROUTER_QODER_SETTINGS:file},encoding:'utf8'})
  const settings=JSON.parse(await readFile(file,'utf8'))
  assert.ok(settings.providers.router.apiKey.trim().length>=32)
 }finally{
  for(const entry of await readdir(directory))await rm(join(directory,entry),{force:true})
  await rmdir(directory)
 }
})
