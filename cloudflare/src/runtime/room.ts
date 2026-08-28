import { DurableObject } from 'cloudflare:workers';
import { configuredInitialPosition } from '../../../src/game/setup';
import type { SideHandicaps } from '../../../src/game/setup';
import type { Move, Side } from '../../../src/game/types';
import {
  type Env,
  type SocketAttachment,
  type StoredRoomState,
  errorJson,
  legacyHandicapProjection,
  moveFingerprint,
  normalizeCreatorSide,
  normalizeHandicaps,
  normalizeOrder,
  oppositeSide,
  parseHandicap,
  parseMove,
  parseOrder,
  parseSide,
  randomToken,
  readJson,
  requestIdPattern,
  responseJson,
  safeEqual,
  sha256,
} from './common';
import { validateMoveWithWasm } from './rule-parity';
import { playerTokenPattern, websocketPlayerToken, websocketProtocol } from './socket-auth';

const joinRequestPattern=/^(passcode|invite):[A-Za-z0-9_-]{8,128}$/;

function parseInitHandicaps(body:Record<string,unknown>):SideHandicaps{
  const hasSente=body.senteHandicap!==undefined;
  const hasGote=body.goteHandicap!==undefined;
  if(hasSente||hasGote){
    if(!hasSente||!hasGote)throw new Error('INCOMPLETE_HANDICAP_PAIR');
    return{sente:parseHandicap(body.senteHandicap),gote:parseHandicap(body.goteHandicap)};
  }
  const handicap=body.handicap===undefined?'even':parseHandicap(body.handicap);
  const side=body.handicapSide===undefined?'gote':parseSide(body.handicapSide);
  return side==='sente'?{sente:handicap,gote:'even'}:{sente:'even',gote:handicap};
}

export class ShogiRoom extends DurableObject<Env>{
  private gate:Promise<void>=Promise.resolve();

  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);}

  async fetch(request:Request):Promise<Response>{
    const url=new URL(request.url);
    if(url.pathname==='/socket'&&request.headers.get('upgrade')?.toLowerCase()==='websocket'){
      return this.exclusive(()=>this.openSocket(request));
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

  private async openSocket(request:Request):Promise<Response>{
    const state=await this.ctx.storage.get<StoredRoomState>('state');
    if(!state)return errorJson('ROOM_NOT_FOUND',404);

    const playerToken=websocketPlayerToken(request.headers);
    if(!playerToken)return errorJson('PLAYER_AUTH_REQUIRED',401);
    const tokenHash=await sha256(playerToken);
    const seat=(state.players.sente&&safeEqual(tokenHash,state.players.sente))?'sente'
      :(state.players.gote&&safeEqual(tokenHash,state.players.gote))?'gote':null;
    if(!seat)return errorJson('PLAYER_AUTH_REJECTED',403);

    if(this.ctx.getWebSockets().length>=8)return errorJson('TOO_MANY_CONNECTIONS',429);
    const pair=new WebSocketPair();
    const client=pair[0];
    const server=pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({connectionId:randomToken(12),authenticated:false,seat} satisfies SocketAttachment);
    return new Response(null,{
      status:101,
      webSocket:client,
      headers:{'sec-websocket-protocol':websocketProtocol},
    });
  }

  private async initialize(request:Request):Promise<Response>{
    const body=await readJson(request);
    const roomId=typeof body.roomId==='string'?body.roomId:'';
    const creatorTokenHash=typeof body.creatorTokenHash==='string'?body.creatorTokenHash:'';
    const creationRequestId=typeof body.creationRequestId==='string'?body.creationRequestId:'';
    if(!/^[A-Za-z0-9_-]{16,128}$/.test(roomId)||!/^[a-f0-9]{64}$/.test(creatorTokenHash)||!requestIdPattern.test(creationRequestId))return errorJson('INVALID_ROOM_INIT',400);
    const handicapsValue=parseInitHandicaps(body);
    const legacy=legacyHandicapProjection(handicapsValue);
    const order=body.order===undefined?'sente':parseOrder(body.order);
    const creatorSide=body.creatorSide===undefined?'sente':parseSide(body.creatorSide);
    const existing=await this.ctx.storage.get<StoredRoomState>('state');
    if(existing){
      const existingCreator=normalizeCreatorSide(existing);
      const existingHash=existing.players[existingCreator];
      const existingHandicaps=normalizeHandicaps(existing);
      if(
        existing.roomId===roomId&&existingHandicaps.sente===handicapsValue.sente&&existingHandicaps.gote===handicapsValue.gote&&
        normalizeOrder(existing)===order&&existingCreator===creatorSide&&existing.creationRequestId===creationRequestId&&
        !!existingHash&&safeEqual(existingHash,creatorTokenHash)
      )return responseJson({ok:true,revision:existing.revision});
      return errorJson('ROOM_ALREADY_INITIALIZED',409);
    }
    const players:{sente:string|null;gote:string|null}={sente:null,gote:null};
    players[creatorSide]=creatorTokenHash;
    const state:StoredRoomState={
      roomId,
      senteHandicap:handicapsValue.sente,
      goteHandicap:handicapsValue.gote,
      handicap:legacy.handicap,
      handicapSide:legacy.handicapSide,
      order,
      creatorSide,
      creationRequestId,
      revision:0,
      status:'waiting',
      position:configuredInitialPosition(handicapsValue),
      players,
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

    const existingSeat:Side|null=(state.players.sente&&safeEqual(state.players.sente,tokenHash))?'sente'
      :(state.players.gote&&safeEqual(state.players.gote,tokenHash))?'gote':null;
    if(existingSeat){
      const sameRequest=state.joinRequestId===joinRequestId||(existingSeat==='gote'&&state.goteJoinRequestId===joinRequestId);
      if(sameRequest)return this.joinResponse(state,existingSeat);
      return errorJson('PLAYER_ALREADY_ASSIGNED',409);
    }

    if(state.players.sente&&state.players.gote)return errorJson('ROOM_FULL',409);
    if(state.status!=='waiting')return errorJson('ROOM_NOT_JOINABLE',409);
    const seat:Side=state.players.sente?'gote':'sente';
    const nextPlayers={...state.players,[seat]:tokenHash};
    const next:StoredRoomState={
      ...state,
      players:nextPlayers,
      joinRequestId,
      ...(seat==='gote'?{goteJoinRequestId:joinRequestId}:{}),
      status:'playing',
      startedAt:Date.now(),
      revision:state.revision+1,
    };
    await this.ctx.storage.put('state',next);
    this.broadcastState(next);
    return this.joinResponse(next,seat);
  }

  private joinResponse(state:StoredRoomState,seat:Side):Response{
    const handicapsValue=normalizeHandicaps(state);
    const legacy=legacyHandicapProjection(handicapsValue);
    return responseJson({
      ok:true,
      revision:state.revision,
      seat,
      senteHandicap:handicapsValue.sente,
      goteHandicap:handicapsValue.gote,
      handicap:legacy.handicap,
      handicapSide:legacy.handicapSide,
      order:normalizeOrder(state),
    });
  }

  private async handleSocketMessage(socket:WebSocket,message:string|ArrayBuffer):Promise<void>{
    if(typeof message!=='string'||message.length>32_768){this.send(socket,{type:'error',code:'INVALID_MESSAGE'});return;}
    let value:unknown;
    try{value=JSON.parse(message);}catch{this.send(socket,{type:'error',code:'INVALID_JSON'});return;}
    if(!value||typeof value!=='object'||Array.isArray(value)){this.send(socket,{type:'error',code:'INVALID_MESSAGE'});return;}
    const data=value as Record<string,unknown>;
    const attachment=socket.deserializeAttachment() as SocketAttachment|undefined;
    if(!attachment?.seat){this.rejectAuthentication(socket);return;}

    const state=await this.ctx.storage.get<StoredRoomState>('state');
    if(!state){this.send(socket,{type:'error',code:'ROOM_NOT_FOUND'});return;}

    if(!attachment.authenticated){
      if(data.type!=='authenticate'||typeof data.playerToken!=='string'||!playerTokenPattern.test(data.playerToken)){
        this.rejectAuthentication(socket);return;
      }
      const tokenHash=await sha256(data.playerToken);
      const expectedHash=state.players[attachment.seat];
      if(!expectedHash||!safeEqual(tokenHash,expectedHash)){
        this.rejectAuthentication(socket);return;
      }
      socket.serializeAttachment({...attachment,authenticated:true} satisfies SocketAttachment);
      this.send(socket,{type:'authenticated',seat:attachment.seat});
      this.sendState(socket,state);
      this.broadcastState(state);
      return;
    }

    if(data.type==='sync'){this.sendState(socket,state);return;}
    if(data.type!=='move'&&data.type!=='resign'){this.send(socket,{type:'error',code:'UNKNOWN_MESSAGE'});return;}

    const seat=attachment.seat;
    const id=typeof data.requestId==='string'?data.requestId:'';
    if(!requestIdPattern.test(id)){this.reject(socket,id,'INVALID_REQUEST_ID',state.revision);return;}

    let fingerprint:string;
    let move:Move|null=null;
    if(data.type==='move'){
      try{move=parseMove(data.move);}catch{this.reject(socket,id,'INVALID_MOVE',state.revision);return;}
      fingerprint=moveFingerprint(move);
    }else fingerprint='resign';

    const prior=state.processed[seat][id];
    if(prior!==undefined){
      if(prior===fingerprint)this.sendState(socket,state);
      else this.reject(socket,id,'REQUEST_ID_CONFLICT',state.revision);
      return;
    }

    if(state.status!=='playing'){this.reject(socket,id,'GAME_NOT_PLAYING',state.revision);return;}
    const expectedRevision=Number(data.expectedRevision);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==state.revision){this.reject(socket,id,'STALE_REVISION',state.revision);return;}

    const processed={...state.processed[seat],[id]:fingerprint};
    if(data.type==='resign'){
      const next:StoredRoomState={
        ...state,
        status:'ended',
        winner:oppositeSide(seat),
        resultReason:'resignation',
        endedAt:Date.now(),
        revision:state.revision+1,
        processed:{...state.processed,[seat]:processed},
      };
      await this.ctx.storage.put('state',next);
      this.broadcastState(next);
      return;
    }

    if(state.position.turn!==seat){this.reject(socket,id,'NOT_YOUR_TURN',state.revision);return;}
    const validated=validateMoveWithWasm(state.position,move!);
    if(!validated.ok){this.reject(socket,id,validated.code,state.revision);return;}
    const {position,outcome}=validated;
    const terminal=outcome.ended?{
      status:'ended' as const,
      ...('winner' in outcome?{winner:outcome.winner}:{}),
      resultReason:outcome.reason,
      endedAt:Date.now(),
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
    const clientPosition={...state.position,history:state.position.history.slice(-1)};
    const handicapsValue=normalizeHandicaps(state);
    const legacy=legacyHandicapProjection(handicapsValue);
    return{
      roomId:state.roomId,
      revision:state.revision,
      position:clientPosition,
      status:state.status,
      connections,
      senteHandicap:handicapsValue.sente,
      goteHandicap:handicapsValue.gote,
      handicap:legacy.handicap,
      handicapSide:legacy.handicapSide,
      order:normalizeOrder(state),
      ...(state.startedAt?{startedAt:state.startedAt}:{}),
      ...(state.endedAt?{endedAt:state.endedAt}:{}),
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
