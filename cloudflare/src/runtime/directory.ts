import { DurableObject } from 'cloudflare:workers';
import {
  type CreateOperation,
  type Env,
  type Handshake,
  type JoinOperation,
  errorJson,
  inviteUrl,
  jsonHeaders,
  parseHandicap,
  passcodeAlphabet,
  randomPasscode,
  randomToken,
  readJson,
  requestId,
  responseJson,
  sha256,
  validateAppUrl,
} from './common';

function encodeBase64Url(bytes:Uint8Array):string{
  let binary='';
  for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export class ShogiDirectory extends DurableObject<Env>{
  private gate:Promise<void>=Promise.resolve();
  private identityKey:CryptoKey|null=null;

  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);}

  async fetch(request:Request):Promise<Response>{
    if(request.method!=='POST')return errorJson('METHOD_NOT_ALLOWED',405);
    return this.exclusive(async()=>{
      const url=new URL(request.url);
      try{
        const body=await readJson(request);
        const ip=request.headers.get('x-client-ip')??'unknown';
        if(url.pathname==='/create')return await this.create(body,ip);
        if(url.pathname==='/join-passcode')return await this.join(body,ip,'passcode');
        if(url.pathname==='/join-invite')return await this.join(body,ip,'invite');
        return errorJson('NOT_FOUND',404);
      }catch(error){return errorJson(error instanceof Error?error.message:'INVALID_REQUEST',400);}
    });
  }

  private async exclusive<T>(operation:()=>Promise<T>):Promise<T>{
    const previous=this.gate;
    let release!:()=>void;
    this.gate=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    try{return await operation();}finally{release();}
  }

  private async getIdentityKey():Promise<CryptoKey>{
    if(this.identityKey)return this.identityKey;
    let secret=await this.ctx.storage.get<string>('identity-secret:v1');
    if(!secret){
      secret=randomToken(32);
      await this.ctx.storage.put('identity-secret:v1',secret);
    }
    this.identityKey=await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      {name:'HMAC',hash:'SHA-256'},
      false,
      ['sign'],
    );
    return this.identityKey;
  }

  private async derivePlayerToken(scope:string):Promise<string>{
    const signature=new Uint8Array(await crypto.subtle.sign('HMAC',await this.getIdentityKey(),new TextEncoder().encode(scope)));
    return encodeBase64Url(signature);
  }

  private async enforceRateLimit(ip:string,scope:'create'|'join'):Promise<void>{
    const bucket=Math.floor(Date.now()/60_000);
    const ipHash=await sha256(ip);
    const key=`rate:${scope}:${ipHash}:${bucket}`;
    const count=(await this.ctx.storage.get<number>(key))??0;
    const limit=scope==='create'?12:40;
    if(count>=limit)throw new Error('RATE_LIMITED');
    await this.ctx.storage.put(key,count+1);
    await this.ctx.storage.delete(`rate:${scope}:${ipHash}:${bucket-2}`);
  }

  private async allocatePasscode(opKey:string):Promise<string>{
    for(let attempt=0;attempt<32;attempt++){
      const candidate=randomPasscode();
      const [mapped,reserved]=await Promise.all([
        this.ctx.storage.get<string>(`pass:${candidate}`),
        this.ctx.storage.get<string>(`reserve-pass:${candidate}`),
      ]);
      if(!mapped&&!reserved){
        await this.ctx.storage.put(`reserve-pass:${candidate}`,opKey);
        return candidate;
      }
    }
    throw new Error('PASSCODE_ALLOCATION_FAILED');
  }

  private async create(body:Record<string,unknown>,ip:string):Promise<Response>{
    const id=requestId(body.requestId);
    const handicap=parseHandicap(body.handicap);
    const appUrl=validateAppUrl(body.appUrl);
    const opKey=`create:${id}`;
    const existing=await this.ctx.storage.get<CreateOperation>(opKey);
    if(existing){
      if(existing.kind!=='create'||existing.requestId!==id||existing.handicap!==handicap||existing.appUrl!==appUrl)return errorJson('REQUEST_ID_CONFLICT',409);
      return await this.resumeCreate(opKey,existing);
    }

    await this.enforceRateLimit(ip,'create');
    const passcode=await this.allocatePasscode(opKey);
    const operation:CreateOperation={
      kind:'create',phase:'pending',requestId:id,handicap,appUrl,
      roomId:randomToken(18),inviteToken:randomToken(24),passcode,
    };
    await this.ctx.storage.put(opKey,operation);
    return await this.resumeCreate(opKey,operation);
  }

  private async resumeCreate(opKey:string,operation:CreateOperation):Promise<Response>{
    const playerToken=await this.derivePlayerToken(`sente:${operation.requestId}:${operation.roomId}`);
    const creatorTokenHash=await sha256(playerToken);
    const init=await this.env.ROOMS.get(this.env.ROOMS.idFromName(operation.roomId)).fetch(new Request('https://internal/init',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        roomId:operation.roomId,
        handicap:operation.handicap,
        creatorTokenHash,
        creationRequestId:operation.requestId,
      }),
    }));
    if(!init.ok)return new Response(init.body,{status:init.status,headers:jsonHeaders});
    const room=await init.json() as {revision:number};
    const done:CreateOperation={...operation,phase:'done'};
    await this.ctx.storage.put({
      [`pass:${operation.passcode}`]:operation.roomId,
      [`invite:${operation.inviteToken}`]:operation.roomId,
      [`room-pass:${operation.roomId}`]:operation.passcode,
      [`room-invite:${operation.roomId}`]:operation.inviteToken,
      [opKey]:done,
    });
    await this.ctx.storage.delete(`reserve-pass:${operation.passcode}`);
    const result:Handshake={
      roomId:operation.roomId,
      inviteUrl:inviteUrl(operation.appUrl,operation.inviteToken),
      passcode:operation.passcode,
      playerToken,
      seat:'sente',
      revision:room.revision,
    };
    return responseJson(result);
  }

  private async join(body:Record<string,unknown>,ip:string,method:'passcode'|'invite'):Promise<Response>{
    const id=requestId(body.requestId);
    const appUrl=validateAppUrl(body.appUrl);
    const credential=method==='passcode'?String(body.passcode??'').trim().toUpperCase():String(body.inviteToken??'').trim();
    if(method==='passcode'&&(credential.length!==8||![...credential].every(char=>passcodeAlphabet.includes(char))))throw new Error('INVALID_PASSCODE');
    if(method==='invite'&&!/^[A-Za-z0-9_-]{24,128}$/.test(credential))throw new Error('INVALID_INVITE');
    const opKey=`join:${method}:${id}`;
    const existing=await this.ctx.storage.get<JoinOperation>(opKey);
    if(existing){
      if(existing.kind!=='join'||existing.method!==method||existing.requestId!==id||existing.credential!==credential||existing.appUrl!==appUrl)return errorJson('REQUEST_ID_CONFLICT',409);
      return await this.resumeJoin(opKey,existing);
    }

    await this.enforceRateLimit(ip,'join');
    const lookup=method==='passcode'?`pass:${credential}`:`invite:${credential}`;
    const roomId=await this.ctx.storage.get<string>(lookup);
    if(!roomId)return errorJson(method==='passcode'?'PASSCODE_NOT_FOUND':'INVITE_NOT_FOUND',404);
    const [passcode,inviteToken]=await Promise.all([
      this.ctx.storage.get<string>(`room-pass:${roomId}`),
      this.ctx.storage.get<string>(`room-invite:${roomId}`),
    ]);
    if(!passcode||!inviteToken)throw new Error('ROOM_MAPPING_MISSING');
    const operation:JoinOperation={
      kind:'join',phase:'pending',method,requestId:id,credential,appUrl,roomId,passcode,inviteToken,
    };
    await this.ctx.storage.put(opKey,operation);
    return await this.resumeJoin(opKey,operation);
  }

  private async resumeJoin(opKey:string,operation:JoinOperation):Promise<Response>{
    const joinRequestId=`${operation.method}:${operation.requestId}`;
    const playerToken=await this.derivePlayerToken(`gote:${joinRequestId}:${operation.roomId}`);
    const playerTokenHash=await sha256(playerToken);
    const joined=await this.env.ROOMS.get(this.env.ROOMS.idFromName(operation.roomId)).fetch(new Request('https://internal/join',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({playerTokenHash,joinRequestId}),
    }));
    if(!joined.ok)return new Response(joined.body,{status:joined.status,headers:jsonHeaders});
    const room=await joined.json() as {revision:number};
    await this.ctx.storage.put(opKey,{...operation,phase:'done'} satisfies JoinOperation);
    const result:Handshake={
      roomId:operation.roomId,
      inviteUrl:inviteUrl(operation.appUrl,operation.inviteToken),
      passcode:operation.passcode,
      playerToken,
      seat:'gote',
      revision:room.revision,
    };
    return responseJson(result);
  }
}
