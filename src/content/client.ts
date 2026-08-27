export type CloudContentKey='terms'|'credits'|'licenses';

export interface CloudContentDocument {
  key:CloudContentKey;
  available:boolean;
  revision:number;
  body:unknown;
}

function apiBase(value:string):string{
  const url=new URL(value);
  const localDev=url.hostname==='localhost'||url.hostname==='127.0.0.1'||url.hostname==='[::1]';
  if(url.protocol!=='https:'&&!(localDev&&url.protocol==='http:'))throw new Error('INSECURE_API_URL');
  url.username='';
  url.password='';
  url.hash='';
  url.search='';
  return url.toString().replace(/\/$/,'');
}

export async function fetchCloudContent(base:string,key:CloudContentKey):Promise<CloudContentDocument>{
  const response=await fetch(`${apiBase(base)}/v1/content/${key}`,{
    method:'GET',
    headers:{accept:'application/json'},
    cache:'no-store',
    credentials:'omit',
    redirect:'error',
  });
  if(!response.ok)throw new Error(`CONTENT_HTTP_${response.status}`);
  if(!(response.headers.get('content-type')??'').toLowerCase().includes('application/json'))throw new Error('CONTENT_INVALID_CONTENT_TYPE');
  const value=await response.json() as Record<string,unknown>;
  if(value.key!==key||typeof value.available!=='boolean')throw new Error('CONTENT_INVALID_RESPONSE');
  const revision=Number(value.revision);
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error('CONTENT_INVALID_REVISION');
  return{key,available:value.available,revision,body:value.body};
}
