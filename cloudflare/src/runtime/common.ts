import type { Handicap, Move, PieceKind, Position, Side } from '../../../src/game/types';

export interface Env {
  ROOMS: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  CONTENT: DurableObjectNamespace;
  APP_URL: string;
  APP_ORIGIN: string;
}

export type RoomStatus='waiting'|'playing'|'ended';
export type ContentKey='terms'|'credits'|'licenses';

export interface StoredRoomState {
  roomId:string;
  handicap:Handicap;
  creationRequestId:string;
  goteJoinRequestId?:string;
  revision:number;
  status:RoomStatus;
  position:Position;
  players:{sente:string|null;gote:string|null};
  processed:{sente:Record<string,string>;gote:Record<string,string>};
  winner?:Side;
  resultReason?:string;
}

export interface SocketAttachment {
  connectionId:string;
  authenticated:boolean;
  seat?:Side;
}

export interface Handshake {
  roomId:string;
  inviteUrl:string;
  passcode:string;
  playerToken:string;
  seat:Side;
  revision:number;
}

export interface CreateOperation {
  kind:'create';
  phase:'pending'|'done';
  requestId:string;
  handicap:Handicap;
  appUrl:string;
  roomId:string;
  inviteToken:string;
  passcode:string;
}

export interface JoinOperation {
  kind:'join';
  phase:'pending'|'done';
  method:'passcode'|'invite';
  requestId:string;
  credential:string;
  appUrl:string;
  roomId:string;
  inviteToken:string;
  passcode:string;
}

export const jsonHeaders={'content-type':'application/json; charset=utf-8','cache-control':'no-store'} as const;
export const passcodeAlphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const handicaps=new Set<Handicap>(['even','rook','bishop','two','four','six']);
export const contentKeys=new Set<ContentKey>(['terms','credits','licenses']);
export const roomIdPattern=/^[A-Za-z0-9_-]{16,128}$/;
export const requestIdPattern=/^[A-Za-z0-9_-]{8,128}$/;

export function responseJson(value:unknown,status=200,extra:HeadersInit={}):Response{
  return new Response(JSON.stringify(value),{status,headers:{...jsonHeaders,...extra}});
}
export function errorJson(code:string,status=400,extra:HeadersInit={}):Response{return responseJson({ok:false,code},status,extra);}
export function directoryStub(env:Env){return env.DIRECTORY.get(env.DIRECTORY.idFromName('shogi-directory-v2'));}
export function contentStub(env:Env){return env.CONTENT.get(env.CONTENT.idFromName('shogi-content-v1'));}
export function roomStub(env:Env,roomId:string){return env.ROOMS.get(env.ROOMS.idFromName(roomId));}

export function randomToken(bytes:number):string{
  const data=new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary='';
  for(const byte of data)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export function randomPasscode(length=8):string{
  const data=new Uint8Array(length);
  crypto.getRandomValues(data);
  let out='';
  for(const byte of data)out+=passcodeAlphabet[byte%passcodeAlphabet.length]!;
  return out;
}

export async function sha256(value:string):Promise<string>{
  const bytes=new TextEncoder().encode(value);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function safeEqual(a:string,b:string):boolean{
  if(a.length!==b.length)return false;
  let diff=0;
  for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

export async function readJson(request:Request,maxBytes=16_384):Promise<Record<string,unknown>>{
  const length=Number(request.headers.get('content-length')??'0');
  if(Number.isFinite(length)&&length>maxBytes)throw new Error('BODY_TOO_LARGE');
  const text=await request.text();
  if(text.length>maxBytes)throw new Error('BODY_TOO_LARGE');
  let value:unknown;
  try{value=JSON.parse(text);}catch{throw new Error('INVALID_JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_JSON_OBJECT');
  return value as Record<string,unknown>;
}

export function requestId(value:unknown):string{
  if(typeof value!=='string'||!requestIdPattern.test(value))throw new Error('INVALID_REQUEST_ID');
  return value;
}

export function parseHandicap(value:unknown):Handicap{
  if(typeof value!=='string'||!handicaps.has(value as Handicap))throw new Error('INVALID_HANDICAP');
  return value as Handicap;
}

export function parseMove(value:unknown):Move{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_MOVE');
  const data=value as Record<string,unknown>;
  const to=parseSquare(data.to);
  const promote=data.promote===true;
  if(data.drop!==undefined){
    if(promote)throw new Error('INVALID_MOVE');
    if(typeof data.drop!=='string'||!['rook','bishop','gold','silver','knight','lance','pawn'].includes(data.drop))throw new Error('INVALID_MOVE');
    return{drop:data.drop as PieceKind,to};
  }
  const from=parseSquare(data.from);
  return{from,to,...(promote?{promote:true}:{})};
}

export function parseSquare(value:unknown):[number,number]{
  if(!Array.isArray(value)||value.length!==2)throw new Error('INVALID_SQUARE');
  const y=Number(value[0]),x=Number(value[1]);
  if(!Number.isInteger(y)||!Number.isInteger(x)||y<0||y>8||x<0||x>8)throw new Error('INVALID_SQUARE');
  return[y,x];
}

export function moveFingerprint(move:Move):string{
  if(move.drop)return `d:${move.drop}:${move.to[0]},${move.to[1]}`;
  return `m:${move.from![0]},${move.from![1]}:${move.to[0]},${move.to[1]}:${move.promote?1:0}`;
}

export function corsHeaders(request:Request,env:Env):HeadersInit{
  const origin=request.headers.get('origin');
  if(origin===env.APP_ORIGIN){
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

export function hasExpectedOrigin(request:Request,env:Env):boolean{return request.headers.get('origin')===env.APP_ORIGIN;}
export function clientIp(request:Request):string{return request.headers.get('cf-connecting-ip')?.trim()||'unknown';}
export function asInternalRequest(path:string,body:unknown,request:Request):Request{
  return new Request(`https://internal${path}`,{
    method:'POST',
    headers:{'content-type':'application/json','x-client-ip':clientIp(request)},
    body:JSON.stringify(body),
  });
}

export function validateAppUrl(value:unknown):string{
  if(typeof value!=='string')throw new Error('INVALID_APP_URL');
  let url:URL;
  try{url=new URL(value);}catch{throw new Error('INVALID_APP_URL');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('INVALID_APP_URL');
  return url.toString();
}

export function inviteUrl(appUrl:string,inviteToken:string):string{
  const url=new URL(appUrl);
  url.searchParams.set('invite',inviteToken);
  return url.toString();
}

export function publicState(state:StoredRoomState,ctx:DurableObjectState){
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
