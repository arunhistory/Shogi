import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base=process.env.SHOGI_E2E_URL??'http://127.0.0.1:8787';
const origin='https://arunhistory.github.io';
const wsBase=base.replace(/^http:/,'ws:').replace(/^https:/,'wss:');

async function api(path,{method='GET',body,requestOrigin=origin}={}){
  const headers={accept:'application/json'};
  if(requestOrigin)headers.origin=requestOrigin;
  if(body!==undefined)headers['content-type']='application/json';
  const response=await fetch(`${base}${path}`,{
    method,
    headers,
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),
    redirect:'error',
  });
  let data=null;
  const text=await response.text();
  if(text)data=JSON.parse(text);
  return{response,data};
}

function socketInbox(socket){
  const queue=[];
  const waiters=[];
  socket.on('message',raw=>{
    const value=JSON.parse(raw.toString());
    const waiter=waiters.shift();
    if(waiter)waiter.resolve(value);else queue.push(value);
  });
  socket.on('error',error=>{
    const waiter=waiters.shift();
    if(waiter)waiter.reject(error);
  });
  return{
    next(timeoutMs=3000){
      if(queue.length)return Promise.resolve(queue.shift());
      return new Promise((resolve,reject)=>{
        const waiter={resolve,reject};
        waiters.push(waiter);
        const timer=setTimeout(()=>{
          const index=waiters.indexOf(waiter);
          if(index>=0)waiters.splice(index,1);
          reject(new Error('WEBSOCKET_MESSAGE_TIMEOUT'));
        },timeoutMs);
        waiter.resolve=value=>{clearTimeout(timer);resolve(value);};
        waiter.reject=error=>{clearTimeout(timer);reject(error);};
      });
    },
    async until(predicate,timeoutMs=5000){
      const deadline=Date.now()+timeoutMs;
      while(Date.now()<deadline){
        const value=await this.next(Math.max(1,deadline-Date.now()));
        if(predicate(value))return value;
      }
      throw new Error('WEBSOCKET_CONDITION_TIMEOUT');
    },
  };
}

function openSocket(roomId,playerToken,requestOrigin=origin){
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(`${wsBase}/v1/rooms/${encodeURIComponent(roomId)}/socket`,[],{origin:requestOrigin});
    const inbox=socketInbox(socket);
    const timer=setTimeout(()=>{socket.terminate();reject(new Error('WEBSOCKET_OPEN_TIMEOUT'));},5000);
    socket.once('open',()=>{
      clearTimeout(timer);
      socket.send(JSON.stringify({type:'authenticate',playerToken}));
      resolve({socket,inbox});
    });
    socket.once('error',error=>{clearTimeout(timer);reject(error);});
  });
}

async function expectWrongOriginRejected(roomId){
  await new Promise((resolve,reject)=>{
    const socket=new WebSocket(`${wsBase}/v1/rooms/${encodeURIComponent(roomId)}/socket`,[],{origin:'https://example.invalid'});
    const timer=setTimeout(()=>{socket.terminate();reject(new Error('WRONG_ORIGIN_SOCKET_TIMEOUT'));},3000);
    socket.once('unexpected-response',(_request,response)=>{
      clearTimeout(timer);
      try{assert.equal(response.statusCode,403);resolve();}catch(error){reject(error);}finally{response.resume();}
    });
    socket.once('open',()=>{clearTimeout(timer);socket.close();reject(new Error('WRONG_ORIGIN_SOCKET_ACCEPTED'));});
    socket.once('error',()=>{});
  });
}

async function main(){
  const health=await api('/health',{requestOrigin:null});
  assert.equal(health.response.status,200);
  assert.deepEqual(health.data,{ok:true,service:'shogi-system',runtime:'authoritative-v2'});

  const denied=await api('/v1/rooms',{method:'POST',requestOrigin:null,body:{requestId:'create-e2e-0001',handicap:'even'}});
  assert.equal(denied.response.status,403);
  assert.equal(denied.data.code,'ORIGIN_NOT_ALLOWED');

  const createBody={requestId:'create-e2e-0001',handicap:'even'};
  const created=await api('/v1/rooms',{method:'POST',body:createBody});
  assert.equal(created.response.status,200);
  assert.equal(created.data.seat,'sente');
  assert.equal(created.data.revision,0);
  assert.match(created.data.roomId,/^[A-Za-z0-9_-]{16,128}$/);
  assert.match(created.data.passcode,/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
  assert.ok(created.data.playerToken.length>=32);
  assert.equal(new URL(created.data.inviteUrl).origin,origin);

  const createRetry=await api('/v1/rooms',{method:'POST',body:createBody});
  assert.equal(createRetry.response.status,200);
  assert.deepEqual(createRetry.data,created.data,'create retransmission must return the same room identity');

  const createConflict=await api('/v1/rooms',{method:'POST',body:{requestId:createBody.requestId,handicap:'rook'}});
  assert.equal(createConflict.response.status,409);
  assert.equal(createConflict.data.code,'REQUEST_ID_CONFLICT');

  const joinBody={requestId:'join-e2e-0001',passcode:created.data.passcode};
  const joined=await api('/v1/rooms/join',{method:'POST',body:joinBody});
  assert.equal(joined.response.status,200);
  assert.equal(joined.data.roomId,created.data.roomId);
  assert.equal(joined.data.seat,'gote');
  assert.equal(joined.data.revision,1);
  assert.notEqual(joined.data.playerToken,created.data.playerToken);

  const joinRetry=await api('/v1/rooms/join',{method:'POST',body:joinBody});
  assert.equal(joinRetry.response.status,200);
  assert.deepEqual(joinRetry.data,joined.data,'join retransmission must restore the same seat identity');

  const extraJoin=await api('/v1/rooms/join',{method:'POST',body:{requestId:'join-e2e-0002',passcode:created.data.passcode}});
  assert.equal(extraJoin.response.status,409);
  assert.equal(extraJoin.data.code,'ROOM_FULL');

  const terms=await api('/v1/content/terms',{requestOrigin:null});
  assert.equal(terms.response.status,200);
  assert.deepEqual(terms.data,{key:'terms',available:false,revision:0,body:null});

  await expectWrongOriginRejected(created.data.roomId);

  const sente1=await openSocket(created.data.roomId,created.data.playerToken);
  const senteAuth=await sente1.inbox.until(v=>v.type==='authenticated');
  assert.equal(senteAuth.seat,'sente');
  const senteState=await sente1.inbox.until(v=>v.type==='state');
  assert.equal(senteState.state.status,'playing');
  assert.equal(senteState.state.revision,1);

  const gote=await openSocket(created.data.roomId,joined.data.playerToken);
  const goteAuth=await gote.inbox.until(v=>v.type==='authenticated');
  assert.equal(goteAuth.seat,'gote');
  const goteState=await gote.inbox.until(v=>v.type==='state');
  assert.equal(goteState.state.revision,1);

  const oldSenteClosed=new Promise(resolve=>sente1.socket.once('close',(code)=>resolve(code)));
  const sente2=await openSocket(created.data.roomId,created.data.playerToken);
  assert.equal((await sente2.inbox.until(v=>v.type==='authenticated')).seat,'sente');
  assert.equal(await oldSenteClosed,4001,'reconnect must replace the previous same-seat socket');
  await sente2.inbox.until(v=>v.type==='state'&&v.state.revision===1);

  sente2.socket.send(JSON.stringify({
    type:'move',requestId:'move-stale-0001',expectedRevision:0,
    move:{from:[6,4],to:[5,4]},
  }));
  const stale=await sente2.inbox.until(v=>v.type==='rejected'&&v.requestId==='move-stale-0001');
  assert.equal(stale.code,'STALE_REVISION');
  assert.equal(stale.revision,1);

  const legalMessage={
    type:'move',requestId:'move-e2e-0001',expectedRevision:1,
    move:{from:[6,4],to:[5,4]},
  };
  sente2.socket.send(JSON.stringify(legalMessage));
  const afterMove=await sente2.inbox.until(v=>v.type==='state'&&v.state.revision===2);
  assert.equal(afterMove.state.position.ply,1);
  assert.equal(afterMove.state.position.turn,'gote');
  assert.equal(afterMove.state.position.board[6][4],null);
  assert.equal(afterMove.state.position.board[5][4].kind,'pawn');
  await gote.inbox.until(v=>v.type==='state'&&v.state.revision===2);

  sente2.socket.send(JSON.stringify(legalMessage));
  const duplicate=await sente2.inbox.until(v=>v.type==='state'&&v.state.revision===2);
  assert.equal(duplicate.state.position.ply,1,'duplicate request must not apply twice');

  sente2.socket.send(JSON.stringify({
    ...legalMessage,
    move:{from:[6,3],to:[5,3]},
  }));
  const conflict=await sente2.inbox.until(v=>v.type==='rejected'&&v.requestId==='move-e2e-0001');
  assert.equal(conflict.code,'REQUEST_ID_CONFLICT');
  assert.equal(conflict.revision,2);

  const disconnectedState=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('DISCONNECT_STATE_TIMEOUT')),3000);
    (async()=>{
      try{
        const state=await sente2.inbox.until(v=>v.type==='state'&&v.state.connections.gote===0,3000);
        clearTimeout(timeout);resolve(state);
      }catch(error){clearTimeout(timeout);reject(error);}
    })();
  });
  gote.socket.close(1000,'test-disconnect');
  const afterDisconnect=await disconnectedState;
  assert.equal(afterDisconnect.state.status,'playing','disconnect must not become a loss');
  assert.equal(afterDisconnect.state.revision,2);

  const invalid=await openSocket(created.data.roomId,'x'.repeat(43));
  const authRejected=await invalid.inbox.until(v=>v.type==='auth-rejected');
  assert.equal(authRejected.type,'auth-rejected');
  const invalidClose=await new Promise(resolve=>invalid.socket.once('close',code=>resolve(code)));
  assert.equal(invalidClose,4003);

  sente2.socket.close(1000,'done');
  console.log('Cloudflare authoritative room E2E: PASS');
}

main().catch(error=>{
  console.error(error);
  process.exitCode=1;
});
