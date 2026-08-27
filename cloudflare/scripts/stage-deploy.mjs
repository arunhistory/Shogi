import {createHash} from 'node:crypto';
import {copyFile,mkdir,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));
const dist=resolve(here,'../dist');
const output=resolve(here,'../../public/deploy');
const commit=(process.env.GITHUB_SHA??process.env.SHOGI_GITHUB_COMMIT??'').trim().toLowerCase();
if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('GITHUB_COMMIT_REQUIRED');

const files=await readdir(dist,{withFileTypes:true});
const mainName='index-v2.js';
const mainEntry=files.find(entry=>entry.isFile()&&entry.name===mainName);
const wasmEntries=files.filter(entry=>entry.isFile()&&/^[a-f0-9]{40}-shogi_engine\.wasm$/.test(entry.name));
if(!mainEntry)throw new Error('CLOUDFLARE_MAIN_MODULE_MISSING');
if(wasmEntries.length!==1)throw new Error('CLOUDFLARE_WASM_MODULE_COUNT_INVALID');
const wasmName=wasmEntries[0].name;

async function descriptor(name,contentType){
  const path=resolve(dist,name);
  const info=await stat(path);
  if(!info.isFile()||info.size<=0)throw new Error(`DEPLOY_MODULE_EMPTY:${name}`);
  const bytes=await readFile(path);
  return{
    name,
    url:`https://arunhistory.github.io/Shogi/deploy/${encodeURIComponent(name)}`,
    sha256:createHash('sha256').update(bytes).digest('hex'),
    bytes:info.size,
    contentType,
  };
}

const main=await descriptor(mainName,'application/javascript+module');
const wasm=await descriptor(wasmName,'application/wasm');

await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
await copyFile(resolve(dist,main.name),resolve(output,main.name));
await copyFile(resolve(dist,wasm.name),resolve(output,wasm.name));

const manifest={
  version:2,
  service:'shogi-system',
  githubCommit:commit,
  mainModule:main,
  modules:[wasm],
};
await writeFile(resolve(output,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`,'utf8');
console.log(JSON.stringify({ok:true,manifest}));
