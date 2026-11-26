// Update the existing Toolbox Router provider only. Never print credentials.
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const file=join(homedir(),'.qoder','settings.json')
const original=await readFile(file,'utf8')
const settings=JSON.parse(original)
const matches=Object.entries(settings.providers||{}).filter(([,value])=>value && typeof value==='object' && value.model==='toolbox-spike' && ['http://192.168.100.66:18787/v1','http://127.0.0.1:18787/v1'].includes(value.baseUrl))
if(matches.length!==1)throw new Error('Expected exactly one existing Toolbox Router provider; no settings were changed.')
const [id,provider]=matches[0]
if(provider.baseUrl==='http://127.0.0.1:18787/v1'){console.log('Qoder Router provider already uses the local address.');process.exit(0)}
if(!process.argv.includes('--apply')){console.log('Qoder Router provider can be updated to the local address. Run with --apply to save.');process.exit(0)}
const backup=`${file}.before-toolbox-${Date.now()}`
const temp=`${file}.toolbox-${randomUUID()}.tmp`
try {
  settings.providers[id].baseUrl='http://127.0.0.1:18787/v1'
  await writeFile(temp,JSON.stringify(settings,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'})
  if(await readFile(file,'utf8')!==original)throw new Error('Qoder settings changed during the update; no settings were changed.')
  await copyFile(file,backup,1)
  await rename(temp,file)
  console.log('Updated the existing Qoder Router address; a local backup was saved.')
} finally { await rm(temp,{force:true}) }
