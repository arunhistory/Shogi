import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SOURCE_URL='https://maou.audio/sound/se/maou_se_system44.wav';
const SOURCE_PAGE='https://maou.audio/se_system44/';
const DESTINATION=resolve('public/assets/audio/maou_se_system44.wav');
const EXPECTED_BYTES=102_504;
const EXPECTED_SHA256='200eaa568284943b3e324020bbff21b20134407dcad10a68bff9b519731fda2b';
const MAX_DOWNLOAD_BYTES=1_000_000;

function digest(bytes){
  return createHash('sha256').update(bytes).digest('hex');
}

function verifyBytes(bytes,label){
  if(bytes.byteLength!==EXPECTED_BYTES)throw new Error(`${label}_BYTE_LENGTH_MISMATCH:${bytes.byteLength}`);
  const actual=digest(bytes);
  if(actual!==EXPECTED_SHA256)throw new Error(`${label}_SHA256_MISMATCH:${actual}`);
}

async function validExisting(){
  try{
    const bytes=await readFile(DESTINATION);
    verifyBytes(bytes,'EXISTING_SE');
    return true;
  }catch{return false;}
}

function cachedBuildOutput(){
  const result=spawnSync(
    'git',
    ['show','origin/build-output:assets/audio/maou_se_system44.wav'],
    {encoding:null,maxBuffer:MAX_DOWNLOAD_BYTES+100_000},
  );
  if(result.status!==0||!Buffer.isBuffer(result.stdout))return null;
  try{
    verifyBytes(result.stdout,'BUILD_OUTPUT_SE');
    return result.stdout;
  }catch{return null;}
}

async function officialDownload(){
  const response=await fetch(SOURCE_URL,{
    headers:{
      accept:'audio/wav,audio/*;q=0.9,*/*;q=0.1',
      referer:SOURCE_PAGE,
      'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
    },
    cache:'no-store',
    redirect:'follow',
  });
  const finalUrl=new URL(response.url);
  if(finalUrl.protocol!=='https:'||!(finalUrl.hostname==='maou.audio'||finalUrl.hostname.endsWith('.maou.audio'))){
    throw new Error('SE_SOURCE_REDIRECT_NOT_ALLOWED');
  }
  if(!response.ok)throw new Error(`SE_SOURCE_HTTP_${response.status}`);
  const declared=Number(response.headers.get('content-length')??'0');
  if(Number.isFinite(declared)&&declared>MAX_DOWNLOAD_BYTES)throw new Error('SE_SOURCE_TOO_LARGE');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.byteLength>MAX_DOWNLOAD_BYTES)throw new Error('SE_SOURCE_TOO_LARGE');
  verifyBytes(bytes,'OFFICIAL_SE');
  return bytes;
}

await mkdir(dirname(DESTINATION),{recursive:true});
if(await validExisting()){
  console.log(JSON.stringify({ok:true,source:'existing',bytes:EXPECTED_BYTES,sha256:EXPECTED_SHA256}));
  process.exit(0);
}

let source='build-output';
let bytes=cachedBuildOutput();
if(!bytes){
  source='official';
  bytes=await officialDownload();
}

const temporary=`${DESTINATION}.tmp-${process.pid}`;
try{
  await writeFile(temporary,bytes,{flag:'wx'});
  await rename(temporary,DESTINATION);
}finally{
  await rm(temporary,{force:true}).catch(()=>{});
}
const written=await readFile(DESTINATION);
verifyBytes(written,'WRITTEN_SE');
console.log(JSON.stringify({ok:true,source,bytes:EXPECTED_BYTES,sha256:EXPECTED_SHA256}));
