import { DurableObject } from 'cloudflare:workers';
import type { ContentKey, Env } from './common';
import { contentKeys, errorJson, responseJson } from './common';

export class ShogiContent extends DurableObject<Env>{
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);}

  async fetch(request:Request):Promise<Response>{
    if(request.method!=='GET')return errorJson('METHOD_NOT_ALLOWED',405);
    const url=new URL(request.url);
    const match=url.pathname.match(/^\/get\/(terms|credits|licenses)$/);
    if(!match)return errorJson('NOT_FOUND',404);
    const key=match[1] as ContentKey;
    if(!contentKeys.has(key))return errorJson('NOT_FOUND',404);
    const body=await this.ctx.storage.get<unknown>(`content:${key}`);
    if(body===undefined)return responseJson({key,available:false,revision:0,body:null});
    const revision=(await this.ctx.storage.get<number>(`revision:${key}`))??1;
    return responseJson({key,available:true,revision,body});
  }
}
