import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));
const deploy=resolve(here,'../../public/deploy');
const commit=(process.env.GITHUB_SHA??process.env.SHOGI_GITHUB_COMMIT??'').trim().toLowerCase();
if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('GITHUB_COMMIT_REQUIRED');

const manifest=JSON.parse(await readFile(resolve(deploy,'manifest.json'),'utf8'));
if(manifest.version!==2||manifest.service!=='shogi-system'||manifest.githubCommit!==commit)throw new Error('MANIFEST_HEADER_INVALID');
if(!manifest.mainModule||manifest.mainModule.name!=='index-v2.js'||manifest.mainModule.contentType!=='application/javascript+module')throw new Error('MANIFEST_MAIN_INVALID');
if(!Array.isArray(manifest.modules)||manifest.modules.length!==1)throw new Error('MANIFEST_MODULE_COUNT_INVALID');
const wasm=manifest.modules[0];
if(!wasm||!/^[a-f0-9]{40}-shogi_engine\.wasm$/.test(wasm.name)||wasm.contentType!=='application/wasm')throw new Error('MANIFEST_WASM_INVALID');

async function verify(entry){
  if(typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error(`MANIFEST_SHA_INVALID:${entry.name}`);
  if(!Number.isSafeInteger(entry.bytes)||entry.bytes<=0)throw new Error(`MANIFEST_SIZE_INVALID:${entry.name}`);
  const expectedUrl=`https://arunhistory.github.io/Shogi/deploy/${encodeURIComponent(entry.name)}`;
  if(entry.url!==expectedUrl)throw new Error(`MANIFEST_URL_INVALID:${entry.name}`);
  const path=resolve(deploy,entry.name);
  const info=await stat(path);
  if(!info.isFile()||info.size!==entry.bytes)throw new Error(`MANIFEST_FILE_SIZE_MISMATCH:${entry.name}`);
  const bytes=await readFile(path);
  const sha=createHash('sha256').update(bytes).digest('hex');
  if(sha!==entry.sha256)throw new Error(`MANIFEST_FILE_SHA_MISMATCH:${entry.name}`);
}

await verify(manifest.mainModule);
await verify(wasm);
const js=await readFile(resolve(deploy,manifest.mainModule.name),'utf8');
if(!js.includes(`./${wasm.name}`))throw new Error('MAIN_MODULE_WASM_IMPORT_MISMATCH');
console.log(JSON.stringify({ok:true,main:manifest.mainModule.name,wasm:wasm.name,githubCommit:commit}));
