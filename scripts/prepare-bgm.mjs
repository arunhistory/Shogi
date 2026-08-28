import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SOURCE_URL='https://maou.audio/sound/bgm/maou_bgm_8bit26.ogg';
const SOURCE_PAGE='https://maou.audio/bgm_8bit26/';
const DESTINATION=resolve('public/assets/audio/maou_bgm_8bit26.ogg');
const EXPECTED_BYTES=6_838_254;
const EXPECTED_SHA256='4d9eb71e46b77b58854360bc8d6c46eb5a98a90be0fcd4039dea8934e60d7cb2';
const MAX_DOWNLOAD_BYTES=8_000_000;

function digest(bytes){
  return createHash('sha256').update(bytes).digest('hex');
}

function verifyBytes(bytes,label){
  if(bytes.byteLength!==EXPECTED_BYTES){
    throw new Error(`${label}_BYTE_LENGTH_MISMATCH:${bytes.byteLength}`);
  }
  const actual=digest(bytes);
  if(actual!==EXPECTED_SHA256){
    throw new Error(`${label}_SHA256_MISMATCH:${actual}`);
  }
}

async function validExisting(){
  try{
    const bytes=await readFile(DESTINATION);
    verifyBytes(bytes,'EXISTING_BGM');
    return true;
  }catch{
    return false;
  }
}

function cachedBuildOutput(){
  const result=spawnSync(
    'git',
    ['show','origin/build-output:assets/audio/maou_bgm_8bit26.ogg'],
    {encoding:null,maxBuffer:MAX_DOWNLOAD_BYTES+1_000_000},
  );
  if(result.status!==0||!Buffer.isBuffer(result.stdout))return null;
  try{
    verifyBytes(result.stdout,'BUILD_OUTPUT_BGM');
    return result.stdout;
  }catch{
    return null;
  }
}

async function officialDownload(){
  const response=await fetch(SOURCE_URL,{
    headers:{
      accept:'audio/ogg,audio/*;q=0.9,*/*;q=0.1',
      referer:SOURCE_PAGE,
      'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
    },
    cache:'no-store',
    redirect:'follow',
  });
  const finalUrl=new URL(response.url);
  if(finalUrl.protocol!=='https:'||!(finalUrl.hostname==='maou.audio'||finalUrl.hostname.endsWith('.maou.audio'))){
    throw new Error('BGM_SOURCE_REDIRECT_NOT_ALLOWED');
  }
  if(!response.ok)throw new Error(`BGM_SOURCE_HTTP_${response.status}`);
  const declared=Number(response.headers.get('content-length')??'0');
  if(Number.isFinite(declared)&&declared>MAX_DOWNLOAD_BYTES)throw new Error('BGM_SOURCE_TOO_LARGE');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.byteLength>MAX_DOWNLOAD_BYTES)throw new Error('BGM_SOURCE_TOO_LARGE');
  verifyBytes(bytes,'OFFICIAL_BGM');
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
verifyBytes(written,'WRITTEN_BGM');
console.log(JSON.stringify({ok:true,source,bytes:EXPECTED_BYTES,sha256:EXPECTED_SHA256}));
