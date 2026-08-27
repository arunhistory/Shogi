import type { Move, Position, Side } from '../game/types';

export interface OnlineRoomEntry {
  roomId: string;
  inviteUrl: string;
  passcode: string;
}

interface RoomHandshakeResponse extends OnlineRoomEntry {
  playerToken: string;
  seat: Side;
  revision: number;
}

export interface AuthoritativeState {
  roomId: string;
  revision: number;
  position: Position;
  status: 'waiting'|'playing'|'ended';
  winner?: Side;
  resultReason?: string;
}

export type OnlineEvent =
  |{type:'authenticated'}
  |{type:'state';state:AuthoritativeState}
  |{type:'rejected';requestId:string;code:string;revision:number}
  |{type:'error';code:string};

const storageKey=(roomId:string)=>`shogi:room:${roomId}:player-token`;

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
  if(!value||typeof value!=='object')throw new Error('INVALID_ROOM_RESPONSE');
  const data=value as Record<string,unknown>;
  const seat=data.seat;
  if(seat!=='sente'&&seat!=='gote')throw new Error('INVALID_SEAT');
  const revision=data.revision;
  if(!Number.isSafeInteger(revision)||Number(revision)<0)throw new Error('INVALID_REVISION');
  const inviteUrl=assertString(data.inviteUrl,'INVITE_URL',2048);
  const parsedInvite=new URL(inviteUrl,location.href);
  if(parsedInvite.protocol!=='https:'&&parsedInvite.protocol!=='http:')throw new Error('INVALID_INVITE_URL');
  return{
    roomId:assertString(data.roomId,'ROOM_ID',128),
    inviteUrl:parsedInvite.toString(),
    passcode:assertString(data.passcode,'PASSCODE',128),
    playerToken:assertString(data.playerToken,'PLAYER_TOKEN',512),
    seat,
    revision:Number(revision),
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

function rememberPlayer(handshake:RoomHandshakeResponse):void{
  // Room discovery credentials and existing-player credentials are deliberately separate.
  // The reconnect token is never placed in the invite URL, passcode, or WebSocket URL.
  sessionStorage.setItem(storageKey(handshake.roomId),handshake.playerToken);
}

export async function createOnlineRoom(base:string):Promise<OnlineRoomEntry>{
  const requestId=crypto.randomUUID();
  const handshake=parseHandshake(await postJson(base,'/v1/rooms',{requestId}));
  rememberPlayer(handshake);
  return{roomId:handshake.roomId,inviteUrl:handshake.inviteUrl,passcode:handshake.passcode};
}

export async function joinOnlineRoom(base:string,passcode:string):Promise<OnlineRoomEntry>{
  const normalized=passcode.trim();
  if(normalized.length<4||normalized.length>128)throw new Error('INVALID_PASSCODE');
  const requestId=crypto.randomUUID();
  const handshake=parseHandshake(await postJson(base,'/v1/rooms/join',{requestId,passcode:normalized}));
  rememberPlayer(handshake);
  return{roomId:handshake.roomId,inviteUrl:handshake.inviteUrl,passcode:handshake.passcode};
}

export async function joinOnlineInvite(base:string,inviteToken:string):Promise<OnlineRoomEntry>{
  const normalized=inviteToken.trim();
  if(normalized.length<8||normalized.length>512)throw new Error('INVALID_INVITE');
  const requestId=crypto.randomUUID();
  const handshake=parseHandshake(await postJson(base,'/v1/rooms/invite',{requestId,inviteToken:normalized}));
  rememberPlayer(handshake);
  return{roomId:handshake.roomId,inviteUrl:handshake.inviteUrl,passcode:handshake.passcode};
}

export class OnlineMatchConnection {
  private socket:WebSocket|null=null;
  private currentRevision=-1;
  private authenticated=false;
  private readonly listeners=new Set<(event:OnlineEvent)=>void>();

  constructor(private readonly api:string,private readonly roomId:string){}

  subscribe(listener:(event:OnlineEvent)=>void):()=>void{
    this.listeners.add(listener);
    return()=>this.listeners.delete(listener);
  }

  connect():void{
    if(this.socket)return;
    const playerToken=sessionStorage.getItem(storageKey(this.roomId));
    if(!playerToken)throw new Error('PLAYER_IDENTITY_MISSING');
    const base=new URL(apiBase(this.api));
    base.protocol=base.protocol==='https:'?'wss:':'ws:';
    base.pathname=`${base.pathname.replace(/\/$/,'')}/v1/rooms/${encodeURIComponent(this.roomId)}/socket`;
    base.search='';
    const socket=new WebSocket(base);
    this.socket=socket;
    this.authenticated=false;
    this.currentRevision=-1;
    socket.onopen=()=>{
      if(this.socket!==socket)return;
      socket.send(JSON.stringify({type:'authenticate',playerToken}));
    };
    socket.onmessage=event=>this.receive(event.data);
    socket.onerror=()=>this.emit({type:'error',code:'SOCKET_ERROR'});
    socket.onclose=()=>{
      if(this.socket===socket){
        this.socket=null;
        this.authenticated=false;
        this.currentRevision=-1;
      }
    };
  }

  close():void{
    const socket=this.socket;
    this.socket=null;
    this.authenticated=false;
    this.currentRevision=-1;
    socket?.close(1000,'client-close');
  }

  sendMove(move:Move):string{
    if(!this.socket||this.socket.readyState!==WebSocket.OPEN)throw new Error('SOCKET_NOT_READY');
    if(!this.authenticated)throw new Error('PLAYER_NOT_AUTHENTICATED');
    if(this.currentRevision<0)throw new Error('STATE_NOT_SYNCHRONIZED');
    const requestId=crypto.randomUUID();
    this.socket.send(JSON.stringify({type:'move',requestId,expectedRevision:this.currentRevision,move}));
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
    if(!value||typeof value!=='object'){this.emit({type:'error',code:'INVALID_MESSAGE'});return;}
    const data=value as Record<string,unknown>;
    if(data.type==='authenticated'){
      this.authenticated=true;
      this.emit({type:'authenticated'});
      this.requestState();
      return;
    }
    if(data.type==='state'){
      if(!this.authenticated){this.emit({type:'error',code:'STATE_BEFORE_AUTH'});return;}
      const state=parseAuthoritativeState(data.state,this.roomId);
      if(!state||state.revision<this.currentRevision)return;
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
      this.emit({type:'error',code:'PLAYER_AUTH_REJECTED'});
      this.close();
      return;
    }
    this.emit({type:'error',code:'UNKNOWN_MESSAGE'});
  }

  private emit(event:OnlineEvent):void{for(const listener of this.listeners)listener(event);}
}

function parseAuthoritativeState(value:unknown,expectedRoomId:string):AuthoritativeState|null{
  if(!value||typeof value!=='object')return null;
  const data=value as Record<string,unknown>;
  if(data.roomId!==expectedRoomId)return null;
  if(!Number.isSafeInteger(data.revision)||Number(data.revision)<0)return null;
  if(data.status!=='waiting'&&data.status!=='playing'&&data.status!=='ended')return null;
  if(!isPositionShape(data.position))return null;
  const winner=data.winner;
  if(winner!==undefined&&winner!=='sente'&&winner!=='gote')return null;
  if(data.resultReason!==undefined&&typeof data.resultReason!=='string')return null;
  return{
    roomId:expectedRoomId,
    revision:Number(data.revision),
    position:data.position,
    status:data.status,
    ...(winner?{winner}:{}) ,
    ...(typeof data.resultReason==='string'?{resultReason:data.resultReason}:{}) ,
  };
}

function isPositionShape(value:unknown):value is Position{
  if(!value||typeof value!=='object')return false;
  const data=value as Partial<Position>;
  if(data.turn!=='sente'&&data.turn!=='gote')return false;
  if(!Number.isSafeInteger(data.ply)||Number(data.ply)<0)return false;
  if(!Array.isArray(data.board)||data.board.length!==9)return false;
  if(!data.board.every(row=>Array.isArray(row)&&row.length===9))return false;
  if(!data.hands||typeof data.hands!=='object')return false;
  if(!Array.isArray(data.history))return false;
  return true;
}
