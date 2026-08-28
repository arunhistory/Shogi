import { DurableObject } from 'cloudflare:workers';
import type { ContentKey, Env } from './common';
import { contentKeys, errorJson, responseJson } from './common';

const MAX_MANAGED_CONTENT_BYTES=131_072;

function requireContentKey(value:unknown):ContentKey{
  if(typeof value!=='string'||!contentKeys.has(value as ContentKey))throw new Error('INVALID_CONTENT_KEY');
  return value as ContentKey;
}

function requireRevision(value:unknown):number{
  if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error('INVALID_REVISION');
  return Number(value);
}

function requireManagedBody(value:unknown):unknown{
  let encoded:string|undefined;
  try{encoded=JSON.stringify(value);}catch{throw new Error('CONTENT_NOT_SERIALIZABLE');}
  if(encoded===undefined)throw new Error('CONTENT_NOT_SERIALIZABLE');
  if(new TextEncoder().encode(encoded).byteLength>MAX_MANAGED_CONTENT_BYTES)throw new Error('CONTENT_TOO_LARGE');
  return value;
}

export class ShogiContent extends DurableObject<Env>{
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);}

  private async current(key:ContentKey):Promise<{body:unknown;revision:number}>{
    const [body,storedRevision]=await Promise.all([
      this.ctx.storage.get<unknown>(`content:${key}`),
      this.ctx.storage.get<number>(`revision:${key}`),
    ]);
    return{body,revision:storedRevision??(body===undefined?0:1)};
  }

  async fetch(request:Request):Promise<Response>{
    if(request.method!=='GET')return errorJson('METHOD_NOT_ALLOWED',405);
    const url=new URL(request.url);
    const match=url.pathname.match(/^\/get\/(terms|credits|licenses)$/);
    if(!match)return errorJson('NOT_FOUND',404);
    const key=match[1] as ContentKey;
    if(!contentKeys.has(key))return errorJson('NOT_FOUND',404);
    const {body,revision}=await this.current(key);
    if(body===undefined)return responseJson({key,available:false,revision,body:null});
    return responseJson({key,available:true,revision,body});
  }

  // Internal management boundary only. Durable Objects are not Internet-addressable;
  // no public Worker route forwards user requests to these RPC methods.
  async upsertManagedContent(keyValue:unknown,bodyValue:unknown,expectedRevisionValue:unknown):Promise<{key:ContentKey;revision:number}>{
    const key=requireContentKey(keyValue);
    const body=requireManagedBody(bodyValue);
    const expectedRevision=requireRevision(expectedRevisionValue);
    const current=await this.current(key);
    if(current.revision!==expectedRevision)throw new Error('CONTENT_REVISION_CONFLICT');
    const nextRevision=current.revision+1;
    await this.ctx.storage.put({[`content:${key}`]:body,[`revision:${key}`]:nextRevision});
    return{key,revision:nextRevision};
  }

  async deleteManagedContent(keyValue:unknown,expectedRevisionValue:unknown):Promise<{key:ContentKey;revision:number;deleted:boolean}>{
    const key=requireContentKey(keyValue);
    const expectedRevision=requireRevision(expectedRevisionValue);
    const current=await this.current(key);
    if(current.revision!==expectedRevision)throw new Error('CONTENT_REVISION_CONFLICT');
    if(current.body===undefined)return{key,revision:current.revision,deleted:false};
    const nextRevision=current.revision+1;
    const deletion=this.ctx.storage.delete(`content:${key}`);
    const revisionWrite=this.ctx.storage.put(`revision:${key}`,nextRevision);
    const [deleted]=await Promise.all([deletion,revisionWrite]);
    return{key,revision:nextRevision,deleted};
  }
}
