import type { Handicap, Move, Position, Side } from '../game/types';

export type ManagedDocument='terms'|'credits'|'licenses';
export interface RoomSnapshot{roomId:string;revision:number;sideToMove:Side;position:Position;state:'waiting'|'playing'|'finished';winner:Side|null;reason:string|null;}
export interface RoomCredentials{roomId:string;playerToken:string;side:Side;revision:number;}
export interface CreatedRoom extends RoomCredentials{inviteUrl:string;passcode:string;}

const configuredBase=(import.meta.env.VITE_SHOGI_SYSTEM_BASE_URL as string|undefined)?.replace(/\/$/,'') ?? '';
const clientInstanceId=crypto.randomUUID();
export const systemConfigured=()=>configuredBase.length>0;

async function request<T>(path:string,init:RequestInit={}):Promise<T>{
  if(!configuredBase)throw new Error('SYSTEM_ENDPOINT_NOT_CONFIGURED');
  const response=await fetch(`${configuredBase}${path}`,{...init,headers:{'content-type':'application/json',...(init.headers??{})},cache:'no-store'});
  if(!response.ok){let code=`HTTP_${response.status}`;try{const body=await response.json() as {code?:string};if(body.code)code=body.code;}catch{}throw new Error(code);}return response.json() as Promise<T>;
}

export async function fetchManagedDocument(kind:ManagedDocument):Promise<{title:string;body:string;updatedAt:string}>{return request(`/v1/content/${kind}`);}

function storeCredentials(value:RoomCredentials){sessionStorage.setItem(`shogi.room.${value.roomId}`,JSON.stringify(value));}
export function loadRoomCredentials(roomId:string):RoomCredentials|null{try{const raw=sessionStorage.getItem(`shogi.room.${roomId}`);return raw?JSON.parse(raw) as RoomCredentials:null;}catch{return null;}}

export async function createRoom(handicap:Handicap):Promise<CreatedRoom>{const room=await request<CreatedRoom>('/v1/rooms',{method:'POST',body:JSON.stringify({handicap,clientInstanceId})});storeCredentials(room);return room;}
export async function joinByPasscode(passcode:string):Promise<RoomCredentials>{const room=await request<RoomCredentials>('/v1/rooms/join',{method:'POST',body:JSON.stringify({passcode,clientInstanceId})});storeCredentials(room);return room;}
export async function joinByInvite(inviteToken:string):Promise<RoomCredentials>{const room=await request<RoomCredentials>('/v1/rooms/invite',{method:'POST',body:JSON.stringify({inviteToken,clientInstanceId})});storeCredentials(room);return room;}
export async function roomState(auth:RoomCredentials):Promise<RoomSnapshot>{return request(`/v1/rooms/${encodeURIComponent(auth.roomId)}`,{headers:{authorization:`Room ${auth.playerToken}`,'x-shogi-client':clientInstanceId}});}
export async function submitOnlineMove(auth:RoomCredentials,move:Move,expectedRevision:number):Promise<RoomSnapshot>{return request(`/v1/rooms/${encodeURIComponent(auth.roomId)}/moves`,{method:'POST',headers:{authorization:`Room ${auth.playerToken}`,'x-shogi-client':clientInstanceId},body:JSON.stringify({requestId:crypto.randomUUID(),expectedRevision,move,clientInstanceId})});}

export function connectRoomSocket(auth:RoomCredentials,onSnapshot:(snapshot:RoomSnapshot)=>void,onClose:(code:number)=>void):()=>void{
  if(!configuredBase)throw new Error('SYSTEM_ENDPOINT_NOT_CONFIGURED');
  const wsBase=configuredBase.replace(/^http:/,'ws:').replace(/^https:/,'wss:');
  const socket=new WebSocket(`${wsBase}/v1/rooms/socket`);
  socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'authenticate',roomId:auth.roomId,playerToken:auth.playerToken,clientInstanceId})));
  socket.addEventListener('message',(event)=>{try{const data=JSON.parse(String(event.data)) as {type?:string;snapshot?:RoomSnapshot};if(data.type==='snapshot'&&data.snapshot)onSnapshot(data.snapshot);}catch{}});
  socket.addEventListener('close',(event)=>onClose(event.code));
  return ()=>socket.close(1000,'client_navigation');
}
