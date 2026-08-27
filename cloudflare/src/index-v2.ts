import type { Env, ContentKey } from './runtime/common';
import {
  asInternalRequest,
  contentStub,
  corsHeaders,
  directoryStub,
  errorJson,
  hasExpectedOrigin,
  jsonHeaders,
  passcodeAlphabet,
  readJson,
  requestId,
  responseJson,
  roomIdPattern,
  roomStub,
} from './runtime/common';
import { ShogiDirectory } from './runtime/directory';
import { ShogiRoom } from './runtime/room';
import { ShogiContent } from './runtime/content';

async function workerFetch(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);
  const cors=corsHeaders(request,env);

  if(request.method==='OPTIONS'){
    if(!hasExpectedOrigin(request,env))return errorJson('ORIGIN_NOT_ALLOWED',403);
    return new Response(null,{status:204,headers:cors});
  }

  if(url.pathname==='/health'&&request.method==='GET'){
    return responseJson({ok:true,service:'shogi-system',runtime:'authoritative-v2'},200,cors);
  }

  if(url.pathname==='/v1/rooms'&&request.method==='POST'){
    if(!hasExpectedOrigin(request,env))return errorJson('ORIGIN_NOT_ALLOWED',403,cors);
    try{
      const body=await readJson(request);
      const result=await directoryStub(env).fetch(asInternalRequest('/create',{
        requestId:requestId(body.requestId),
        handicap:body.handicap,
        appUrl:env.APP_URL,
      },request));
      return new Response(result.body,{status:result.status,headers:{...jsonHeaders,...cors}});
    }catch(error){return errorJson(error instanceof Error?error.message:'INVALID_REQUEST',400,cors);}
  }

  if(url.pathname==='/v1/rooms/join'&&request.method==='POST'){
    if(!hasExpectedOrigin(request,env))return errorJson('ORIGIN_NOT_ALLOWED',403,cors);
    try{
      const body=await readJson(request);
      const passcode=typeof body.passcode==='string'?body.passcode.trim().toUpperCase():'';
      if(passcode.length!==8||![...passcode].every(char=>passcodeAlphabet.includes(char)))throw new Error('INVALID_PASSCODE');
      const result=await directoryStub(env).fetch(asInternalRequest('/join-passcode',{
        requestId:requestId(body.requestId),passcode,appUrl:env.APP_URL,
      },request));
      return new Response(result.body,{status:result.status,headers:{...jsonHeaders,...cors}});
    }catch(error){return errorJson(error instanceof Error?error.message:'INVALID_REQUEST',400,cors);}
  }

  if(url.pathname==='/v1/rooms/invite'&&request.method==='POST'){
    if(!hasExpectedOrigin(request,env))return errorJson('ORIGIN_NOT_ALLOWED',403,cors);
    try{
      const body=await readJson(request);
      const inviteToken=typeof body.inviteToken==='string'?body.inviteToken.trim():'';
      if(!/^[A-Za-z0-9_-]{24,128}$/.test(inviteToken))throw new Error('INVALID_INVITE');
      const result=await directoryStub(env).fetch(asInternalRequest('/join-invite',{
        requestId:requestId(body.requestId),inviteToken,appUrl:env.APP_URL,
      },request));
      return new Response(result.body,{status:result.status,headers:{...jsonHeaders,...cors}});
    }catch(error){return errorJson(error instanceof Error?error.message:'INVALID_REQUEST',400,cors);}
  }

  const socketMatch=url.pathname.match(/^\/v1\/rooms\/([A-Za-z0-9_-]{16,128})\/socket$/);
  if(socketMatch&&request.method==='GET'){
    if(!hasExpectedOrigin(request,env))return errorJson('ORIGIN_NOT_ALLOWED',403,cors);
    if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return errorJson('WEBSOCKET_REQUIRED',426,cors);
    const roomId=socketMatch[1]!;
    if(!roomIdPattern.test(roomId))return errorJson('INVALID_ROOM_ID',400,cors);
    return roomStub(env,roomId).fetch(new Request('https://internal/socket',{headers:request.headers}));
  }

  const contentMatch=url.pathname.match(/^\/v1\/content\/(terms|credits|licenses)$/);
  if(contentMatch&&request.method==='GET'){
    const key=contentMatch[1] as ContentKey;
    const result=await contentStub(env).fetch(new Request(`https://internal/get/${key}`));
    return new Response(result.body,{status:result.status,headers:{...jsonHeaders,...cors}});
  }

  return errorJson('NOT_FOUND',404,cors);
}

export default {fetch:workerFetch} satisfies ExportedHandler<Env>;
export {ShogiDirectory,ShogiRoom,ShogiContent};
