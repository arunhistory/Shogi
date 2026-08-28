import { positionKey } from '../game/engine';
import { isHandicap } from '../game/handicaps';
import { isOrderPreference, isSide } from '../game/setup';
import type { OrderPreference } from '../game/setup';
import type { Handicap, Move, Position, Side } from '../game/types';

export interface OnlineRoomEntry {
  roomId:string;
  inviteUrl:string;
  passcode:string;
  seat:Side;
  revision:number;
  handicap:Handicap;
  handicapSide:Side;
  order:OrderPreference;
}

interface RoomHandshakeResponse extends OnlineRoomEntry {playerToken:string;}

export interface AuthoritativeState {
  roomId:string;
  revision:number;
  position:Position;
  status:'waiting'|'playing'|'ended';
  connections:{sente:number;gote:number};
  handicap:Handicap;
  handicapSide:Side;
  order:OrderPreference;
  startedAt?:number;
  endedAt?:number;
  winner?:Side;
  resultReason?:string;
}

export type OnlineEvent =
  |{type:'authenticated';seat:Side}
  |{type:'state';state:AuthoritativeState}
  |{type:'rejected';requestId:string;code:string;revision:number}
  |{type:'disconnected';code:number}
  |{type:'error';code:string};

const tokenKey=(roomId:string)=>`shogi:room:${roomId}:player-token`;
const roomInfoKey=(roomId:string)=>`shogi:room:${roomId}:info`;
const inviteRoomKey=(inviteToken:string)=>`shogi:invite:${inviteToken}:room`;
const passcodeRoomKey=(passcode:string)=>`shogi:passcode:${passcode}:room`;
const pendingOperationKey=(kind:string)=>`shogi:pending-operation:${kind}`;
const activeRoomKey='shogi:active-room';
const roomIdPattern=/^[A-Za-z0-9_-]{16,128}$/;
const playerTokenPattern=/^[A-Za-z0-9_-]{32,128}$/;
const passcodePattern=/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
const boardKinds=new Set(['king','rook','bishop','gold','silver','knight','lance','pawn','dragon','horse','promotedSilver','promotedKnight','promotedLance','tokin']);
const handKinds=['king','rook','bishop','gold','silver','knight','lance','pawn'] as const;
const terminalReasons=new Set(['mate','repetition','perpetual-check','resignation']);

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

function assertString(value:unknown,name:string,maxLength=512):string{
  if(typeof value!=='string'||value.length===0||value.length>maxLength)throw new Error(`INVALID_${name}`);
  return value;
}

function parseHandshake(value:unknown):RoomHandshakeResponse{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_ROOM_RESPONSE');
  const data=value as Record<string,unknown>;
  const seat=data.seat;
  if(seat!=='sente'&&seat!=='gote')throw new Error('INVALID_SEAT');
  const revision=Number(data.revision);
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error('INVALID_REVISION');
  const roomId=assertString(data.roomId,'ROOM_ID',128);
  const passcode=assertString(data.passcode,'PASSCODE',8).toUpperCase();
  const playerToken=assertString(data.playerToken,'PLAYER_TOKEN',128);
  if(!roomIdPattern.test(roomId))throw new Error('INVALID_ROOM_ID');
  if(!passcodePattern.test(passcode))throw new Error('INVALID_PASSCODE');
  if(!playerTokenPattern.test(playerToken))throw new Error('INVALID_PLAYER_TOKEN');
  const inviteUrl=assertString(data.inviteUrl,'INVITE_URL',2048);
  const parsedInvite=new URL(inviteUrl,location.href);
  if(parsedInvite.protocol!=='https:'&&parsedInvite.protocol!=='http:')throw new Error('INVALID_INVITE_URL');
  if(parsedInvite.origin!==location.origin)throw new Error('INVALID_INVITE_ORIGIN');
  const handicap=isHandicap(data.handicap)?data.handicap:'even';
  const handicapSide=isSide(data.handicapSide)?data.handicapSide:'gote';
  const order=isOrderPreference(data.order)?data.order:'sente';
  return{
    roomId,
    inviteUrl:parsedInvite.toString(),
    passcode,
    playerToken,
    seat,
    revision,
    handicap,
    handicapSide,
    order,
  };
}

async function postJson(base:string,path:string,body:unknown):Promise<unknown>{
  const response=await fetch(`${apiBase(base)}${path}`,{
    method:'POST',
    headers:{'content-type':'application/json','accept':'application/json'},
    body:JSON.stringify(body),
    cache:'no-store',
    credentials:'omit',
    redirect:'error',
  });
  if(!response.ok)throw new Error(`ONLINE_HTTP_${response.status}`);
  const contentType=response.headers.get('content-type')??'';
  if(!contentType.toLowerCase().includes('application/json'))throw new Error('ONLINE_INVALID_CONTENT_TYPE');
  return response.json();
}

function publicEntry(handshake:RoomHandshakeResponse):OnlineRoomEntry{
  return{
    roomId:handshake.roomId,
    inviteUrl:handshake.inviteUrl,
    passcode:handshake.passcode,
    seat:handshake.seat,
    revision:handshake.revision,
    handicap:handshake.handicap,
    handicapSide:handshake.handicapSide,
    order:handshake.order,
  };
}

function operationRequestId(key:string):string{
  const storage=pendingOperationKey(key);
  const existing=sessionStorage.getItem(storage);
  if(existing&&/^[A-Za-z0-9_-]{8,128}$/.test(existing))return existing;
  const created=crypto.randomUUID();
  sessionStorage.setItem(storage,created);
  return created;
}

function completeOperation(key:string):void{
  sessionStorage.removeItem(pendingOperationKey(key));
}

function inviteTokenFromUrl(inviteUrl:string):string|null{
  try{
    const token=new URL(inviteUrl,location.href).searchParams.get('invite')?.trim()??'';
    return /^[A-Za-z0-9_-]{24,128}$/.test(token)?token:null;
  }catch{return null;}
}

function persistReconnectRoute(inviteToken:string):void{
  const current=new URL(location.href);
  current.searchParams.set('invite',inviteToken);
  history.replaceState(null,'',current);
}

function rememberPlayer(handshake:RoomHandshakeResponse,explicitInviteToken?:string):void{
  const info=publicEntry(handshake);
  const normalizedPasscode=handshake.passcode.trim().toUpperCase();
  const inviteToken=explicitInviteToken??inviteTokenFromUrl(handshake.inviteUrl);
  sessionStorage.setItem(tokenKey(handshake.roomId),handshake.playerToken);
  sessionStorage.setItem(roomInfoKey(handshake.roomId),JSON.stringify(info));
  sessionStorage.setItem(passcodeRoomKey(normalizedPasscode),handshake.roomId);
  sessionStorage.setItem(activeRoomKey,handshake.roomId);
  if(inviteToken){
    sessionStorage.setItem(inviteRoomKey(inviteToken),handshake.roomId);
    persistReconnectRoute(inviteToken);
  }
}

function readRememberedRoom(roomId:string):OnlineRoomEntry|null{
  if(!sessionStorage.getItem(tokenKey(roomId)))return null;
  const raw=sessionStorage.getItem(roomInfoKey(roomId));
  if(!raw)return null;
  try{
    const value=JSON.parse(raw) as Partial<OnlineRoomEntry>;
    if(value.roomId!==roomId||!roomIdPattern.test(roomId)||typeof value.inviteUrl!=='string'||typeof value.passcode!=='string')return null;
    if(value.seat!=='sente'&&value.seat!=='gote')return null;
    if(!Number.isSafeInteger(value.revision)||Number(value.revision)<0)return null;
    if(!passcodePattern.test(value.passcode.trim().toUpperCase()))return null;
    const handicap=isHandicap(value.handicap)?value.handicap:'even';
    const handicapSide=isSide(value.handicapSide)?value.handicapSide:'gote';
    const order=isOrderPreference(value.order)?value.order:'sente';
    return{roomId,inviteUrl:value.inviteUrl,passcode:value.passcode,seat:value.seat,revision:Number(value.revision),handicap,handicapSide,order};
  }catch{return null;}
}

export function getActiveOnlineRoom():OnlineRoomEntry|null{
  const roomId=sessionStorage.getItem(activeRoomKey);
  return roomId?readRememberedRoom(roomId):null;
}

export function clearActiveOnlineRoom():void{
  sessionStorage.removeItem(activeRoomKey);
}

export async function createOnlineRoom(base:string,handicap:Handicap,handicapSide:Side='gote',order:OrderPreference='random'):Promise<OnlineRoomEntry>{
  if(!isSide(handicapSide)||!isOrderPreference(order))throw new Error('INVALID_MATCH_RULES');
  const op=`create:${handicap}:${handicapSide}:${order}`;
  const requestId=operationRequestId(op);
  const handshake=parseHandshake(await postJson(base,'/v1/rooms',{requestId,handicap,handicapSide,order}));
  rememberPlayer(handshake);
  completeOperation(op);
  return publicEntry(handshake);
}

export async function joinOnlineRoom(base:string,passcode:string):Promise<OnlineRoomEntry>{
  const normalized=passcode.trim().toUpperCase();
  if(!passcodePattern.test(normalized))throw new Error('INVALID_PASSCODE');
  const rememberedRoomId=sessionStorage.getItem(passcodeRoomKey(normalized));
  if(rememberedRoomId){
    const remembered=readRememberedRoom(rememberedRoomId);
    if(remembered){
      sessionStorage.setItem(activeRoomKey,remembered.roomId);
      const inviteToken=inviteTokenFromUrl(remembered.inviteUrl);
      if(inviteToken)persistReconnectRoute(inviteToken);
      return remembered;
    }
  }
  const op=`join-passcode:${normalized}`;
  const requestId=operationRequestId(op);
  const handshake=parseHandshake(await postJson(base,'/v1/rooms/join',{requestId,passcode:normalized}));
  rememberPlayer(handshake);
  completeOperation(op);
  return publicEntry(handshake);
}

export async function joinOnlineInvite(base:string,inviteToken:string):Promise<OnlineRoomEntry>{
  const normalized=inviteToken.trim();
  if(!/^[A-Za-z0-9_-]{24,128}$/.test(normalized))throw new Error('INVALID_INVITE');
  const rememberedRoomId=sessionStorage.getItem(inviteRoomKey(normalized));
  if(rememberedRoomId){
    const remembered=readRememberedRoom(rememberedRoomId);
    if(remembered){
      sessionStorage.setItem(activeRoomKey,remembered.roomId);
      persistReconnectRoute(normalized);
      return remembered;
    }
  }
  const op=`join-invite:${normalized}`;
  const requestId=operationRequestId(op);
  const handshake=parseHandshake(await postJson(base,'/v1/rooms/invite',{requestId,inviteToken:normalized}));
  rememberPlayer(handshake,normalized);
  completeOperation(op);
  return publicEntry(handshake);
}

export class OnlineMatchConnection {
  private socket:WebSocket|null=null;
  private currentRevision=-1;
  private authenticated=false;
  private seat:Side|null=null;
  private readonly listeners=new Set<(event:OnlineEvent)=>void>();

  constructor(private readonly api:string,private readonly roomId:string){}

  subscribe(listener:(event:OnlineEvent)=>void):()=>void{
    this.listeners.add(listener);
    return()=>this.listeners.delete(listener);
  }

  connect():void{
    if(this.socket)return;
    const playerToken=sessionStorage.getItem(tokenKey(this.roomId));
    if(!playerToken||!playerTokenPattern.test(playerToken))throw new Error('PLAYER_IDENTITY_MISSING');
    const base=new URL(apiBase(this.api));
    base.protocol=base.protocol==='https:'?'wss:':'ws:';
    base.pathname=`${base.pathname.replace(/\/$/,'')}/v1/rooms/${encodeURIComponent(this.roomId)}/socket`;
    base.search='';
    const socket=new WebSocket(base,['shogi-v1',`player.${playerToken}`]);
    this.socket=socket;
    this.authenticated=false;
    this.currentRevision=-1;
    this.seat=null;
    socket.onopen=()=>{
      if(this.socket!==socket)return;
      socket.send(JSON.stringify({type:'authenticate',playerToken}));
    };
    socket.onmessage=event=>this.receive(event.data);
    socket.onerror=()=>this.emit({type:'error',code:'SOCKET_ERROR'});
    socket.onclose=event=>{
      if(this.socket===socket){
        this.socket=null;
        this.authenticated=false;
        this.currentRevision=-1;
        this.seat=null;
        this.emit({type:'disconnected',code:event.code});
      }
    };
  }

  close():void{
    const socket=this.socket;
    this.socket=null;
    this.authenticated=false;
    this.currentRevision=-1;
    this.seat=null;
    socket?.close(1000,'client-close');
  }

  sendMove(move:Move):string{
    return this.sendAction({type:'move',move});
  }

  sendResign():string{
    return this.sendAction({type:'resign'});
  }

  private sendAction(action:{type:'move';move:Move}|{type:'resign'}):string{
    if(!this.socket||this.socket.readyState!==WebSocket.OPEN)throw new Error('SOCKET_NOT_READY');
    if(!this.authenticated||!this.seat)throw new Error('PLAYER_NOT_AUTHENTICATED');
    if(this.currentRevision<0)throw new Error('STATE_NOT_SYNCHRONIZED');
    const requestId=crypto.randomUUID();
    this.socket.send(JSON.stringify({...action,requestId,expectedRevision:this.currentRevision}));
    return requestId;
  }

  requestState():void{
    if(!this.socket||this.socket.readyState!==WebSocket.OPEN)throw new Error('SOCKET_NOT_READY');
    if(!this.authenticated)throw new Error('PLAYER_NOT_AUTHENTICATED');
    this.socket.send(JSON.stringify({type:'sync'}));
  }

  private receive(raw:unknown):void{
    if(typeof raw!=='string'){this.emit({type:'error',code:'INVALID_MESSAGE'});return;}
    if(raw.length>1_000_000){this.emit({type:'error',code:'MESSAGE_TOO_LARGE'});return;}
    let value:unknown;
    try{value=JSON.parse(raw);}catch{this.emit({type:'error',code:'INVALID_JSON'});return;}
    if(!value||typeof value!=='object'||Array.isArray(value)){this.emit({type:'error',code:'INVALID_MESSAGE'});return;}
    const data=value as Record<string,unknown>;
    if(data.type==='authenticated'){
      if(data.seat!=='sente'&&data.seat!=='gote'){this.emit({type:'error',code:'INVALID_SEAT'});return;}
      this.authenticated=true;
      this.seat=data.seat;
      this.emit({type:'authenticated',seat:data.seat});
      this.requestState();
      return;
    }
    if(data.type==='state'){
      if(!this.authenticated){this.emit({type:'error',code:'STATE_BEFORE_AUTH'});return;}
      const state=parseAuthoritativeState(data.state,this.roomId);
      if(!state){this.emit({type:'error',code:'INVALID_STATE'});return;}
      if(state.revision<this.currentRevision)return;
      this.currentRevision=state.revision;
      this.emit({type:'state',state});
      return;
    }
    if(data.type==='rejected'){
      if(!this.authenticated)return;
      const revision=Number(data.revision);
      if(Number.isSafeInteger(revision)&&revision>=0){
        this.emit({type:'rejected',requestId:String(data.requestId??''),code:String(data.code??'REJECTED'),revision});
        this.requestState();
      }
      return;
    }
    if(data.type==='auth-rejected'){
      this.authenticated=false;
      this.currentRevision=-1;
      this.seat=null;
      this.emit({type:'error',code:'PLAYER_AUTH_REJECTED'});
      this.close();
      return;
    }
    this.emit({type:'error',code:'UNKNOWN_MESSAGE'});
  }

  private emit(event:OnlineEvent):void{for(const listener of this.listeners)listener(event);}
}

export function parseAuthoritativeState(value:unknown,expectedRoomId:string):AuthoritativeState|null{
  if(!roomIdPattern.test(expectedRoomId))return null;
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const data=value as Record<string,unknown>;
  if(data.roomId!==expectedRoomId)return null;
  const revision=Number(data.revision);
  if(!Number.isSafeInteger(revision)||revision<0)return null;
  if(data.status!=='waiting'&&data.status!=='playing'&&data.status!=='ended')return null;
  if(!isPositionShape(data.position))return null;
  const connections=parseConnections(data.connections);
  if(!connections)return null;
  const winner=data.winner;
  if(winner!==undefined&&winner!=='sente'&&winner!=='gote')return null;
  const resultReason=data.resultReason;
  if(resultReason!==undefined&&(typeof resultReason!=='string'||!terminalReasons.has(resultReason)))return null;
  if(data.status==='ended'){
    if(typeof resultReason!=='string')return null;
    if(resultReason==='repetition'){
      if(winner!==undefined)return null;
    }else if(winner!=='sente'&&winner!=='gote')return null;
  }else if(winner!==undefined||resultReason!==undefined)return null;
  const handicap=isHandicap(data.handicap)?data.handicap:'even';
  const handicapSide=isSide(data.handicapSide)?data.handicapSide:'gote';
  const order=isOrderPreference(data.order)?data.order:'sente';
  const startedAt=parseTimestamp(data.startedAt);
  const endedAt=parseTimestamp(data.endedAt);
  if(data.status==='waiting'&&(startedAt!==undefined||endedAt!==undefined))return null;
  if(data.status==='playing'&&endedAt!==undefined)return null;
  if(data.status==='ended'&&startedAt!==undefined&&endedAt!==undefined&&endedAt<startedAt)return null;
  return{
    roomId:expectedRoomId,
    revision,
    position:data.position,
    status:data.status,
    connections,
    handicap,
    handicapSide,
    order,
    ...(startedAt!==undefined?{startedAt}:{}),
    ...(endedAt!==undefined?{endedAt}:{}),
    ...(winner?{winner}:{}),
    ...(typeof resultReason==='string'?{resultReason}:{}),
  };
}

function parseTimestamp(value:unknown):number|undefined{
  if(value===undefined)return undefined;
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:undefined;
}

function parseConnections(value:unknown):{sente:number;gote:number}|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const data=value as Record<string,unknown>;
  const sente=Number(data.sente),gote=Number(data.gote);
  if(!Number.isSafeInteger(sente)||!Number.isSafeInteger(gote)||sente<0||gote<0||sente>8||gote>8||sente+gote>8)return null;
  return{sente,gote};
}

function isPieceShape(value:unknown):boolean{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const data=value as Record<string,unknown>;
  return (data.side==='sente'||data.side==='gote')&&typeof data.kind==='string'&&boardKinds.has(data.kind);
}

function isHandsShape(value:unknown):boolean{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const hands=value as Record<string,unknown>;
  for(const side of ['sente','gote'] as const){
    const sideValue=hands[side];
    if(!sideValue||typeof sideValue!=='object'||Array.isArray(sideValue))return false;
    const counts=sideValue as Record<string,unknown>;
    const keys=Object.keys(counts);
    if(keys.length!==handKinds.length||keys.some(key=>!handKinds.includes(key as typeof handKinds[number])))return false;
    for(const kind of handKinds){
      const count=Number(counts[kind]);
      if(!Number.isSafeInteger(count)||count<0||count>40)return false;
      if(kind==='king'&&count!==0)return false;
    }
  }
  return true;
}

function isHistoryShape(value:unknown,ply:number):boolean{
  if(!Array.isArray(value)||value.length<1||(value.length!==1&&value.length!==ply+1))return false;
  for(const entry of value){
    if(!entry||typeof entry!=='object'||Array.isArray(entry))return false;
    const data=entry as Record<string,unknown>;
    if(typeof data.key!=='string'||data.key.length===0||data.key.length>20_000)return false;
    if(data.mover!==null&&data.mover!=='sente'&&data.mover!=='gote')return false;
    if(typeof data.gaveCheck!=='boolean')return false;
  }
  return true;
}

function isPositionShape(value:unknown):value is Position{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const data=value as Partial<Position>;
  if(data.turn!=='sente'&&data.turn!=='gote')return false;
  if(!Number.isSafeInteger(data.ply)||Number(data.ply)<0)return false;
  const ply=Number(data.ply);
  if(!Array.isArray(data.board)||data.board.length!==9)return false;
  if(!data.board.every(row=>Array.isArray(row)&&row.length===9&&row.every(cell=>cell===null||isPieceShape(cell))))return false;
  if(!isHandsShape(data.hands))return false;
  if(!isHistoryShape(data.history,ply))return false;
  let senteKings=0,goteKings=0;
  for(const row of data.board)for(const cell of row){
    if(cell?.kind==='king')cell.side==='sente'?senteKings++:goteKings++;
  }
  if(senteKings!==1||goteKings!==1)return false;
  const position=data as Position;
  if(position.history[position.history.length-1]?.key!==positionKey(position))return false;
  return true;
}
