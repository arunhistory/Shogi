import { DurableObject } from 'cloudflare:workers';
import { applyMove, gameOutcome, initialPosition } from '../../../src/game/engine';
import type { Move, Position } from '../../../src/game/types';
import {
  type Env,
  type SocketAttachment,
  type StoredRoomState,
  errorJson,
  moveFingerprint,
  parseHandicap,
  parseMove,
  randomToken,
  readJson,
  requestIdPattern,
  responseJson,
  safeEqual,
  sha256,
} from './common';

const joinRequestPattern=/^(passcode|invite):[A-Za-z0-9_-]{8,128}$/;

export class ShogiRoom extends DurableObject<Env>{
  private gate:Promise<void>=Promise.resolve();

  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);}

  async fetch(request:Request):Promise<Response>{
    const url=new URL(request.url);
    if(url.pathname==='/socket'&&request.headers.get('upgrade')?.toLowerCase()==='websocket'){
      const state=await this.ctx.storage.get<StoredRoomState>('state');
      if(!state)return errorJson('ROOM_NOT_FOUND',404);
      if(this.ctx.getWebSockets().length>=8)return errorJson('TOO_MANY_CONNECTIONS',429);
      const pair=new WebSocketPair();
      const client=pair[0];
      const server=pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({connectionId:randomToken(12),authenticated:false} satisfies SocketAttachment);
      return new Response(null,{status:101,webSocket:client});
    }

    return this.exclusive(async()=>{
      if(url.pathname==='/init'&&request.method==='POST')return await this.initialize(request);
      if(url.pathname==='/join'&&request.method==='POST')return await this.join(request);
      return errorJson('NOT_FOUND',404);
    });
  }

  async webSocketMessage(socket:WebSocket,message:string|ArrayBuffer):Promise<void>{
    await this.exclusive(()=>this.handleSocketMessage(socket,message));
  }

  async webSocketClose(socket:WebSocket,_code:number,_reason:string,_wasClean:boolean):Promise<void>{
    const state=await this.ctx.storage.get<StoredRoomState>('state');
    if(state)this.broadcastState(state,socket);
    // A disconnect never becomes resignation or a loss by itself.
  }

  async webSocketError(socket:WebSocket,_error:unknown):Promise<void>{
    const state=await this.ctx.storage.get<StoredRoomState>('state');
    if(state)this.broadcastState(state,socket);
  }

  private async exclusive<T>(operation:()=>Promise<T>):Promise<T>{
    const previous=this.gate;
    let release!:()=>void;
    this.gate=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    try{return await operation();}finally{release();}
  }

  private async initialize(request:Request):Promise<Response>{
    const body=await readJson(request);
    const roomId=typeof body.roomId==='string'?body.roomId:'';
    const creatorTokenHash=typeof body.creatorTokenHash==='string'?body.creatorTokenHash:'';
    const creationRequestId=typeof body.creationRequestId==='string'?body.creationRequestId:'';
    if(!/^[A-Za-z0-9_-]{16,128}$/.test(roomId)||!/^[a-f0-9]{64}$/.test(creatorTokenHash)||!requestIdPattern.test(creationRequestId))return errorJson('INVALID_ROOM_INIT',400);
    const handicap=parseHandicap(body.handicap);
    const existing=await this.ctx.storage.get<StoredRoomState>('state');
    if(existing){
      if(
        existing.roomId===roomId&&
        existing.handicap===handicap&&
        existing.creationRequestId===creationRequestId&&
        !!existing.players.sente&&safeEqual(existing.players.sente,creatorTokenHash)
      )return responseJson({ok:true,revision:existing.revision});
      return errorJson('ROOM_ALREADY_INITIALIZED',409);
    }
    const state:StoredRoomState={
      roomId,
      handicap,
      creationRequestId,
      revision:0,
      status:'waiting',
      position:initialPosition(handicap),
      players:{sente:creatorTokenHash,gote:null},
      processed:{sente:{},gote:{}},
    };
    await this.ctx.storage.put('state',state);
    return responseJson({ok:true,revision:0});
  }

  private async join(request:Request):Promise<Response>{
    const body=await readJson(request);
    const tokenHash=typeof body.playerTokenHash==='string'?body.playerTokenHash:'';
    const joinRequestId=typeof body.joinRequestId==='string'?body.joinRequestId:'';
    if(!/^[a-f0-9]{64}$/.test(tokenHash)||!joinRequestPattern.test(joinRequestId))return errorJson('INVALID_PLAYER_TOKEN',400);
    const state=await this.ctx.storage.get<StoredRoomState>('state');
    if(!state)return errorJson('ROOM_NOT_FOUND',404);
    if(state.players.gote){
      if(state.goteJoinRequestId===joinRequestId&&safeEqual(state.players.gote,tokenHash))return responseJson({ok:true,revision:state.revision});
      return errorJson('ROOM_FULL',409);
    }
    if(state.status!=='waiting')return errorJson('ROOM_NOT_JOINABLE',409);
    const next:StoredRoomState={
      ...state,
      players:{...state.players,gote:tokenHash},
      goteJoinRequestId:joinRequestId,
      status:'playing',
      revision:state.revision+1,
    };
    await this.ctx.storage.put('state',next);
    this.broadcastState(next);
    return responseJson({ok:true,revision:next.revision});
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
        this.rejectAuthentication(socket);return;
      }
      const state=await this.ctx.storage.get<StoredRoomState>('state');
      if(!state){this.rejectAuthentication(socket);return;}
      const tokenHash=await sha256(data.playerToken);
      const seat=(state.players.sente&&safeEqual(tokenHash,state.players.sente))?'sente'
        :(state.players.gote&&safeEqual(tokenHash,state.players.gote))?'gote':null;
      if(!seat){this.rejectAuthentication(socket);return;}
      for(const existing of this.ctx.getWebSockets()){
        if(existing===socket)continue;
        const other=existing.deserializeAttachment() as SocketAttachment|undefined;
        if(other?.authenticated&&other.seat===seat){try{existing.close(4001,'reconnected');}catch{/* already closed */}}
      }
      socket.serializeAttachment({...attachment,authenticated:true,seat} satisfies SocketAttachment);
      this.send(socket,{type:'authenticated',seat});
      this.sendState(socket,state);
      this.broadcastState(state);
      return;
    }

    const state=await this.ctx.storage.get<StoredRoomState>('state');
    if(!state){this.send(socket,{type:'error',code:'ROOM_NOT_FOUND'});return;}
    if(data.type==='sync'){this.sendState(socket,state);return;}
    if(data.type!=='move'){this.send(socket,{type:'error',code:'UNKNOWN_MESSAGE'});return;}

    const seat=attachment.seat!;
    const id=typeof data.requestId==='string'?data.requestId:'';
    if(!requestIdPattern.test(id)){this.reject(socket,id,'INVALID_REQUEST_ID',state.revision);return;}
    let move:Move;
    try{move=parseMove(data.move);}catch{this.reject(socket,id,'INVALID_MOVE',state.revision);return;}
    const fingerprint=moveFingerprint(move);
    const prior=state.processed[seat][id];
    if(prior!==undefined){
      if(prior===fingerprint)this.sendState(socket,state);
      else this.reject(socket,id,'REQUEST_ID_CONFLICT',state.revision);
      return;
    }

    if(state.status!=='playing'){this.reject(socket,id,'GAME_NOT_PLAYING',state.revision);return;}
    if(state.position.turn!==seat){this.reject(socket,id,'NOT_YOUR_TURN',state.revision);return;}
    const expectedRevision=Number(data.expectedRevision);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==state.revision){this.reject(socket,id,'STALE_REVISION',state.revision);return;}

    let position:Position;
    try{position=applyMove(state.position,move);}catch(error){
      this.reject(socket,id,error instanceof Error&&error.message==='GAME_ENDED'?'GAME_NOT_PLAYING':'ILLEGAL_MOVE',state.revision);
      return;
    }
    const outcome=gameOutcome(position);
    const processed={...state.processed[seat],[id]:fingerprint};
    const terminal=outcome.ended?{
      status:'ended' as const,
      ...('winner' in outcome?{winner:outcome.winner}:{}),
      resultReason:outcome.reason,
    }:{status:'playing' as const};
    const next:StoredRoomState={
      ...state,
      position,
      revision:state.revision+1,
      processed:{...state.processed,[seat]:processed},
      ...terminal,
    };
    await this.ctx.storage.put('state',next);
    this.broadcastState(next);
  }

  private rejectAuthentication(socket:WebSocket){
    this.send(socket,{type:'auth-rejected'});
    try{socket.close(4003,'authentication-failed');}catch{/* already closed */}
  }

  private stateForClient(state:StoredRoomState,excludedSocket?:WebSocket){
    const connections:{sente:number;gote:number}={sente:0,gote:0};
    for(const socket of this.ctx.getWebSockets()){
      if(socket===excludedSocket)continue;
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

  private reject(socket:WebSocket,requestIdValue:string,code:string,revision:number){this.send(socket,{type:'rejected',requestId:requestIdValue,code,revision});}
  private sendState(socket:WebSocket,state:StoredRoomState,excludedSocket?:WebSocket){this.send(socket,{type:'state',state:this.stateForClient(state,excludedSocket)});}
  private broadcastState(state:StoredRoomState,excludedSocket?:WebSocket){
    for(const socket of this.ctx.getWebSockets()){
      if(socket===excludedSocket)continue;
      const attachment=socket.deserializeAttachment() as SocketAttachment|undefined;
      if(attachment?.authenticated)this.sendState(socket,state,excludedSocket);
    }
  }
  private send(socket:WebSocket,value:unknown){try{socket.send(JSON.stringify(value));}catch{/* already closed */}}
}
