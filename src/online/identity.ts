import type { Side } from '../game/types';

export interface SeatIdentity {
  seat: Side;
  credentialHash: string;
  generation: number;
  activeConnectionId: string | null;
}

export interface IssuedSeatCredential {
  seat: Side;
  credential: string;
  identity: SeatIdentity;
}

function bytesToBase64Url(bytes:Uint8Array):string{
  let binary='';
  for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export function generateOpaqueCredential(byteLength=32):string{
  if(byteLength<24)throw new Error('CREDENTIAL_ENTROPY_TOO_LOW');
  const bytes=new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function hashCredential(credential:string):Promise<string>{
  const data=new TextEncoder().encode(credential);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',data));
  return Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
}

export async function issueSeatCredential(seat:Side):Promise<IssuedSeatCredential>{
  const credential=generateOpaqueCredential();
  const credentialHash=await hashCredential(credential);
  return{
    seat,
    credential,
    identity:{seat,credentialHash,generation:0,activeConnectionId:null},
  };
}

export async function verifySeatCredential(identity:SeatIdentity,credential:string):Promise<boolean>{
  const candidate=await hashCredential(credential);
  if(candidate.length!==identity.credentialHash.length)return false;
  let difference=0;
  for(let i=0;i<candidate.length;i++)difference|=candidate.charCodeAt(i)^identity.credentialHash.charCodeAt(i);
  return difference===0;
}

// A successful reconnect replaces the previous connection generation. Storage/transport
// adapters must persist this change atomically before granting move authority.
export async function reconnectSeat(
  identity:SeatIdentity,
  credential:string,
  connectionId:string,
):Promise<SeatIdentity|null>{
  if(!connectionId)return null;
  if(!await verifySeatCredential(identity,credential))return null;
  return{
    ...identity,
    generation:identity.generation+1,
    activeConnectionId:connectionId,
  };
}

export function connectionOwnsSeat(identity:SeatIdentity,connectionId:string,generation:number):boolean{
  return identity.activeConnectionId===connectionId&&identity.generation===generation;
}
