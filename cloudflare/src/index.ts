import { DurableObject } from 'cloudflare:workers';
import { applyMove, gameOutcome, initialPosition } from '../../src/game/engine';
import type { Handicap, Move, Position, Side } from '../../src/game/types';

interface Env {
  ROOMS: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  CONTENT: DurableObjectNamespace;
  APP_URL: string;
  APP_ORIGIN: string;
}

type RoomStatus='waiting'|'playing'|'ended';
type ContentKey='terms'|'credits'|'licenses';

interface StoredRoomState {
  roomId:string;
  handicap:Handicap;
  revision:number;
  status:RoomStatus;
  position:Position;
  players:{sente:string|null;gote:string|null};
  processed:{sente:string[];gote:string[]};
  winner?:Side;
  resultReason?:string;
}

interface SocketAttachment {
  connectionId:string;
  authenticated:boolean;
  seat?:Side;
}

const jsonHeaders={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const passcodeAlphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const handicaps=new Set<Handicap>(['even','rook','bishop','two','four','six']);
const contentKeys=new Set<ContentKey>(['terms','credits','licenses']);
const roomIdPattern=/^[A-Za-z0-9_-]{16,128}$/;
const requestIdPattern=/^[A-Za-z0-9_-]{8,128}$/;

function responseJson(value:unknown,status=200,extra:HeadersInit={}):Response{
  return new Response(JSON.stringify(value),{status,headers:{...jsonHeaders,...extra}});
}

function errorJson(code:string,status=400):Response{return responseJson({ok:false,code},status);}
function directoryStub(env:Env){return env.DIRECTORY.get(env.DIRECTORY.idFromName('shogi-directory-v1'));}
function contentStub(env:Env){return env.CONTENT.get(env.CONTENT.idFromName('shogi-content-v1'));}
function roomStub(env:Env,roomId:string){return env.ROOMS.get(env.ROOMS.idFromName(roomId));}
function otherSide(side:Side):Side{return side==='sente'?'gote':'sente';}

function randomToken(bytes:number):string{
  const data=new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary='';
  for(const byte of data)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function randomPasscode(length=8):string{
  const data=new Uint8Array(length);
  crypto.getRandomValues(data);
  let out='';
  for(const byte of data)out+=passcodeAlphabet[byte%passcodeAlphabet.length]!;
  return out;
}

async function sha256(value:string):Promise<string>{
  const bytes=new TextEncoder().encode(value);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
}

function safeEqual(a:string,b:string):boolean{
  if(a.length!==b.length)return false;
  let diff=0;
  for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

async function readJson(request:Request,maxBytes=16_384):Promise<Record<string,unknown>>{
  const length=Number(request.headers.get('content-length')??'0');
  if(Number.isFinite(length)&&length>maxBytes)throw new Error('BODY_TOO_LARGE');
  const text=await request.text();
  if(text.length>maxBytes)throw new Error('BODY_TOO_LARGE');
  let value:unknown;
  try{value=JSON.parse(text);}catch{throw new Error('INVALID_JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_JSON_OBJECT');
  return value as Record<string,unknown>;
}

function requestId(value:unknown):string{
  if(typeof value!=='string'||!requestIdPattern.test(value))throw new Error('INVALID_REQUEST_ID');
  return value;
}

function parseHandicap(value:unknown):Handicap{
  if(typeof value!=='string'||!handicaps.has(value as Handicap))throw new Error('INVALID_HANDICAP');
  return value as Handicap;
}

function parseMove(value:unknown):Move{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_MOVE');
  const data=value as Record<string,unknown>;
  const to=parseSquare(data.to);
  const promote=data.promote===true;
  if(data.drop!==undefined){
    if(typeof data.drop!=='string'||!['rook','bishop','gold','silver','knight','lance','pawn'].includes(data.drop))throw new Error('INVALID_MOVE');
    return{drop:data.drop as Move['drop'],to,...(promote?{promote:true}:{})};
  }
  const from=parseSquare(data.from);
  return{from,to,...(promote?{promote:true}:{})};
}

function parseSquare(value:unknown):[number,number]{
  if(!Array.isArray(value)||value.length!==2)return invalidSquare();
  const y=Number(value[0]),x=Number(value[1]);
  if(!Number.isInteger(y)||!Number.isInteger(x)||y<0||y>8||x<0||x>8)return invalidSquare();
  return[y,x];
}
function invalidSquare():never{throw new Error('INVALID_SQUARE');}

function corsHeaders(request:Request,env:Env):HeadersInit{
  const origin=request.headers.get('origin');
  if(origin&&origin===env.APP_ORIGIN){
    return{
      'access-control-allow-origin':origin,
      'access-control-allow-methods':'GET,POST,OPTIONS',
      'access-control-allow-headers':'content-type',
      'access-control-max-age':'600',
      'vary':'Origin',
    };
  }
  return{};
}

function clientIp(request:Request):string{
  return request.headers.get('cf-connecting-ip')?.trim()||'unknown';
}

function asInternalRequest(path:string,body:unknown,request:Request):Request{
  return new Request(`https://internal${path}`,{
    method:'POST',
    headers:{'content-type':'application/json','x-client-ip':clientIp(request)},
    body:JSON.stringify(body),
  });
}

function publicState(state:StoredRoomState,ctx:DurableObjectState){
  const connections:{sente:number;gote:number}={sente:0,gote:0};
  for(const socket of ctx.getWebSockets()){
    const attachment=socket.deserializeAttachment() as SocketAttachment|undefined;
    if(attachment?.authenticated&&attachment.seat)connections[attachment.seat]++;
  }
  return{
    roomId:state.roomId,
    revision:state.revision,
    position:state.position,
    status:state.status,
    connections,
    ...(state.winner?{winner:state.winner}:{}),
    ...(state.resultReason?{resultReason:state.resultReason}:{}),
  };
}

async function workerFetch(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);
  const cors=corsHeaders(request,env);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});

  if(url.pathname==='/health'&&request.method==='GET')return responseJson({ok:true,service:'shogi-system'},200,cors);

  if(url.pathname==='/v1/rooms'&&request.method==='POST'){
    try{
      const body=await readJson(request);
      const result=await directoryStub(env).fetch(asInternalRequest('/create',{requestId:requestId(body.requestId),handicap:parseHandicap(body.handicap),appUrl:env.APP_URL},request));
      return new Response(result.body,{status:result.status,headers:{...jsonHeaders,...cors}});
    }catch(error){return errorJson(error instanceof Error?error.message:'INVALID_REQUEST',400);}
  }

  if(url.pathname==='/v1/rooms/join'&&request.method==='POST'){
    try{
      const body=await readJson(request);
      const passcode=typeof body.passcode==='string'?body.passcode.trim().toUpperCase():'';
      if(passcode.length!==8||![...passcode].every(char=>passcodeAlphabet.includes(char)))throw new Error('INVALID_PASSCODE');
      const result=await directoryStub(env).fetch(asInternalRequest('/join-passcode',{requestId:requestId(body.requestId),passcode,appUrl:env.APP_URL},request));
      return new Response(result.body,{status:result.status,headers:{...jsonHeaders,...cors}});
    }catch(error){return errorJson(error instanceof Error?error.message:'INVALID_REQUEST',400);}
  }

  if(url.pathname==='/v1/rooms/invite'&&request.method==='POST'){
    try{
      const body=await readJson(request);
      const inviteToken=typeof body.inviteToken==='string'?body.inviteToken.trim():'';
      if(!/^[A-Za-z0-9_-]{24,128}$/.test(inviteToken))throw new Error('INVALID_INVITE');
      const result=await directoryStub(env).fetch(asInternalRequest('/join-invite',{requestId:requestId(body.requestId),inviteToken,appUrl:env.APP_URL},request));
      return new Response(result.body,{status:result.status,headers:{...jsonHeaders,...cors}});
    }catch(error){return errorJson(error instanceof Error?error.message:'INVALID_REQUEST',400);}
  }

  const socketMatch=url.pathname.match(/^\/v1\/rooms\/([A-Za-z0-9_-]{16,128})\/socket$/);
  if(socketMatch&&request.method==='GET'){
    if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return errorJson('WEBSOCKET_REQUIRED',426);
    const roomId=socketMatch[1]!;
    if(!roomIdPattern.test(roomId))return errorJson('INVALID_ROOM_ID',400);
    return roomStub(env,roomId).fetch(new Request('https://internal/socket',{headers:request.headers}));
  }

  const contentMatch=url.pathname.match(/^\/v1\/content\/(terms|credits|licenses)$/);
  if(contentMatch&&request.method==='GET'){
    const key=contentMatch[1] as ContentKey;
    const result=await contentStub(env).fetch(new Request(`https://internal/get/${key}`));
    return new Response(result.body,{status:result.status,headers:{...jsonHeaders,...cors}});
  }

  return errorJson('NOT_FOUND',404);
}

export default {fetch:workerFetch} satisfies ExportedHandler<Env>;

export class ShogiDirectory extends DurableObject<Env>{
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);}

  async fetch(request:Request):Promise<Response>{
    if(request.method!=='POST')return errorJson('METHOD_NOT_ALLOWED',405);
    const url=new URL(request.url);
    try{
      const body=await readJson(request);
      const ip=request.headers.get('x-client-ip')??'unknown';
      if(url.pathname==='/create')return this.create(body,ip);
      if(url.pathname==='/join-passcode')return this.join(body,ip,'passcode');
      if(url.pathname==='/join-invite')return this.join(body,ip,'invite');
      return errorJson('NOT_FOUND',404);
    }catch(error){return errorJson(error instanceof Error?error.message:'INVALID_REQUEST',400);}
  }

  private async enforceRateLimit(ip:string,scope:'create'|'join'):Promise<void>{
    const bucket=Math.floor(Date.now()/60_000);
    const key=`rate:${scope}:${await sha256(ip)}:${bucket}`;
    const count=(await this.ctx.storage.get<number>(key))??0;
    const limit=scope==='create'?12:40;
    if(count>=limit)throw new Error('RATE_LIMITED');
    await this.ctx.storage.put(key,count+1);
    const oldKey=`rate:${scope}:${await sha256(ip)}:${bucket-2}`;
    await this.ctx.storage.delete(oldKey);
  }

  private async create(body:Record<string,unknown>,ip:string):Promise<Response>{
    await this.enforceRateLimit(ip,'create');
    const id=requestId(body.requestId);
    const existing=await this.ctx.storage.get<Record<string,unknown>>(`create:${id}`);
    if(existing)return responseJson(existing);
    const handicap=parseHandicap(body.handicap);
    const appUrl=typeof body.appUrl==='string'?body.appUrl:'';
    if(!appUrl.startsWith('https://'))throw new Error('INVALID_APP_URL');

    let passcode='';
    for(let attempt=0;attempt<16;attempt++){
      const candidate=randomPasscode();
      if(!(await this.ctx.storage.get(`pass:${candidate}`))){passcode=candidate;break;}
    }
    if(!passcode)throw new Error('PASSCODE_ALLOCATION_FAILED');

    const roomId=randomToken(18);
    const inviteToken=randomToken(24);
    const playerToken=randomToken(32);
    const creatorTokenHash=await sha256(playerToken);
    const init=await this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId)).fetch(new Request('https://internal/init',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({roomId,handicap,creatorTokenHash}),
    }));
    if(!init.ok)throw new Error('ROOM_INIT_FAILED');

    await this.ctx.storage.put({[`pass:${passcode}`]:roomId,[`invite:${inviteToken}`]:roomId});
    const result={
      roomId,
      inviteUrl:`${appUrl}${appUrl.includes('?')?'&':'?'}invite=${encodeURIComponent(inviteToken)}`,
      passcode,
      playerToken,
      seat:'sente' as const,
      revision:0,
    };
    await this.ctx.storage.put(`create:${id}`,result);
    return responseJson(result);
  }

  private async join(body:Record<string,unknown>,ip:string,kind:'passcode'|'invite'):Promise<Response>{
    await this.enforceRateLimit(ip,'join');
    const id=requestId(body.requestId);
    const opKey=`join:${kind}:${id}`;
    const existing=await this.ctx.storage.get<Record<string,unknown>>(opKey);
    if(existing)return responseJson(existing);
    const lookup=kind==='passcode'
      ?`pass:${String(body.passcode??'')}`
      :`invite:${String(body.inviteToken??'')}`;
    const roomId=await this.ctx.storage.get<string>(lookup);
    if(!roomId)return errorJson(kind==='passcode'?'PASSCODE_NOT_FOUND':'INVITE_NOT_FOUND',404);
    const playerToken=randomToken(32);
    const playerTokenHash=await sha256(playerToken);
    const joined=await this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId)).fetch(new Request('https://internal/join',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({playerTokenHash}),
    }));
    if(!joined.ok)return new Response(joined.body,{status:joined.status,headers:jsonHeaders});
    const room=await joined.json() as {revision:number};
    const appUrl=typeof body.appUrl==='string'?body.appUrl:'';
    const passcode=kind==='passcode'?String(body.passcode):await this.findPasscode(roomId);
    const inviteToken=kind==='invite'?String(body.inviteToken):await this.findInvite(roomId);
    const result={
      roomId,
      inviteUrl:`${appUrl}${appUrl.includes('?')?'&':'?'}invite=${encodeURIComponent(inviteToken)}`,
      passcode,
      playerToken,
      seat:'gote' as const,
      revision:room.revision,
    };
    await this.ctx.storage.put(opKey,result);
    return responseJson(result);
  }

  private async findPasscode(roomId:string):Promise<string>{
    const entries=await this.ctx.storage.list<string>({prefix:'pass:'});
    for(const [key,value] of entries)if(value===roomId)return key.slice(5);
    throw new Error('PASSCODE_MAPPING_MISSING');
  }
  private async findInvite(roomId:string):Promise<string>{
    const entries=await this.ctx.storage.list<string>({prefix:'invite:'});
    for(const [key,value] of entries)if(value===roomId)return key.slice(7);
    throw new Error('INVITE_MAPPING_MISSING');
  }
}

export class ShogiRoom extends DurableObject<Env>{
  private queue:Promise<void>=Promise.resolve();

  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);}

  async fetch(request:Request):Promise<Response>{
    const url=new URL(request.url);
    if(url.pathname==='/init'&&request.method==='POST'){
      const body=await readJson(request);
      const existing=await this.ctx.storage.get<StoredRoomState>('state');
      if(existing)return errorJson('ROOM_ALREADY_INITIALIZED',409);
      const roomId=typeof body.roomId==='string'&&roomIdPattern.test(body.roomId)?body.roomId:'';
      const creatorTokenHash=typeof body.creatorTokenHash==='string'&&/^[a-f0-9]{64}$/.test(body.creatorTokenHash)?body.creatorTokenHash:'';
      if(!roomId||!creatorTokenHash)return errorJson('INVALID_ROOM_INIT',400);
      const handicap=parseHandicap(body.handicap);
      const state:StoredRoomState={
        roomId,handicap,revision:0,status:'waiting',position:initialPosition(handicap),
        players:{sente:creatorTokenHash,gote:null},processed:{sente:[],gote:[]},
      };
      await this.ctx.storage.put('state',state);
      return responseJson({ok:true,revision:state.revision});
    }

    if(url.pathname==='/join'&&request.method==='POST'){
      const body=await readJson(request);
      const tokenHash=typeof body.playerTokenHash==='string'?body.playerTokenHash:'';
      if(!/^[a-f0-9]{64}$/.test(tokenHash))return errorJson('INVALID_PLAYER_TOKEN',400);
      const state=await this.ctx.storage.get<StoredRoomState>('state');
      if(!state)return errorJson('ROOM_NOT_FOUND',404);
      if(state.players.gote)return errorJson('ROOM_FULL',409);
      const next:{[K in keyof StoredRoomState]:StoredRoomState[K]}={...state,players:{...state.players,gote:tokenHash},status:'playing',revision:state.revision+1};
      await this.ctx.storage.put('state',next);
      return responseJson({ok:true,revision:next.revision});
    }

    if(url.pathname==='/socket'&&request.headers.get('upgrade')?.toLowerCase()==='websocket'){
      const state=await this.ctx.storage.get<StoredRoomState>('state');
      if(!state)return errorJson('ROOM_NOT_FOUND',404);
      const pair=new WebSocketPair();
      const client=pair[0];
      const server=pair[1];
      this.ctx.acceptWebSocket(server);
      const attachment:SocketAttachment={connectionId:randomToken(12),authenticated:false};
      server.serializeAttachment(attachment);
      return new Response(null,{status:101,webSocket:client});
    }

    return errorJson('NOT_FOUND',404);
  }

  async webSocketMessage(socket:WebSocket,message:string|ArrayBuffer):Promise<void>{
    this.queue=this.queue.then(()=>this.handleSocketMessage(socket,message)).catch(()=>{
      try{socket.send(JSON.stringify({type:'error',code:'SERVER_ERROR'}));}catch{/* closed */}
    });
    await this.queue;
  }

  webSocketClose(_socket:WebSocket,_code:number,_reason:string,_wasClean:boolean):void{
    // Disconnect never becomes resignation/mate/loss. The detailed disconnect outcome is intentionally unset.
  }

  webSocketError(_socket:WebSocket,_error:unknown):void{
    // Network failure does not mutate the authoritative game result.
  }

  private async handleSocketMessage(socket:WebSocket,message:string|ArrayBuffer):Promise<void>{
    if(typeof message!=='string'||message.length>32_768){this.send(socket,{type:'error',code:'INVALID_MESSAGE'});return;}
    let value:unknown;
    try{value=JSON.parse(message);}catch{this.send(socket,{type:'error',code:'INVALID_JSON'});return;}
    if(!value||typeof value!=='object'||Array.isArray(value)){this.send(socket,{type:'error',code:'INVALID_MESSAGE'});return;}
    const data=value as Record<string,unknown>;
    const attachment=(socket.deserializeAttachment() as SocketAttachment|undefined)??{connectionId:randomToken(12),authenticated:false};

    if(!attachment.authenticated){
      if(data.type!=='authenticate'||typeof data.playerToken!=='string'||data.playerToken.length<32||data.playerToken.length>256){
        this.send(socket,{type:'auth-rejected'});return;
      }
      const state=await this.ctx.storage.get<StoredRoomState>('state');
      if(!state){this.send(socket,{type:'auth-rejected'});return;}
      const tokenHash=await sha256(data.playerToken);
      const seat=(state.players.sente&&safeEqual(tokenHash,state.players.sente))?'sente'
        :(state.players.gote&&safeEqual(tokenHash,state.players.gote))?'gote':null;
      if(!seat){this.send(socket,{type:'auth-rejected'});return;}
      for(const existing of this.ctx.getWebSockets()){
        if(existing===socket)continue;
        const other=existing.deserializeAttachment() as SocketAttachment|undefined;
        if(other?.authenticated&&other.seat===seat){try{existing.close(4001,'reconnected');}catch{/* closed */}}
      }
      const authenticated:SocketAttachment={...attachment,authenticated:true,seat};
      socket.serializeAttachment(authenticated);
      this.send(socket,{type:'authenticated',seat});
      this.sendState(socket,state);
      return;
    }

    const state=await this.ctx.storage.get<StoredRoomState>('state');
    if(!state){this.send(socket,{type:'error',code:'ROOM_NOT_FOUND'});return;}
    if(data.type==='sync'){this.sendState(socket,state);return;}
    if(data.type!=='move'){this.send(socket,{type:'error',code:'UNKNOWN_MESSAGE'});return;}
    const seat=attachment.seat!;
    const id=typeof data.requestId==='string'?data.requestId:'';
    if(!requestIdPattern.test(id)){this.reject(socket,id,'INVALID_REQUEST_ID',state.revision);return;}
    if(state.processed[seat].includes(id)){this.sendState(socket,state);return;}
    if(state.status!=='playing'){this.reject(socket,id,'GAME_NOT_PLAYING',state.revision);return;}
    if(state.position.turn!==seat){this.reject(socket,id,'NOT_YOUR_TURN',state.revision);return;}
    const expectedRevision=Number(data.expectedRevision);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==state.revision){this.reject(socket,id,'STALE_REVISION',state.revision);return;}

    let move:Move;
    try{move=parseMove(data.move);}catch{this.reject(socket,id,'INVALID_MOVE',state.revision);return;}
    let position:Position;
    try{position=applyMove(state.position,move);}catch{this.reject(socket,id,'ILLEGAL_MOVE',state.revision);return;}
    const outcome=gameOutcome(position);
    const processed=[...state.processed[seat],id].slice(-128);
    const next:StoredRoomState={
      ...state,
      position,
      revision:state.revision+1,
      processed:{...state.processed,[seat]:processed},
      ...(outcome.ended?{
        status:'ended' as const,
        ...(outcome.winner?{winner:outcome.winner}:{}),
        resultReason:outcome.reason,
      }:{status:'playing' as const}),
    };
    await this.ctx.storage.put('state',next);
    this.broadcastState(next);
  }

  private reject(socket:WebSocket,requestIdValue:string,code:string,revision:number){
    this.send(socket,{type:'rejected',requestId:requestIdValue,code,revision});
  }
  private sendState(socket:WebSocket,state:StoredRoomState){this.send(socket,{type:'state',state:publicState(state,this.ctx)});}
  private broadcastState(state:StoredRoomState){
    for(const socket of this.ctx.getWebSockets()){
      const attachment=socket.deserializeAttachment() as SocketAttachment|undefined;
      if(attachment?.authenticated)this.sendState(socket,state);
    }
  }
  private send(socket:WebSocket,value:unknown){try{socket.send(JSON.stringify(value));}catch{/* closed */}}
}

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
