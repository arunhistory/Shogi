export const websocketProtocol='shogi-v1';
export const playerTokenPattern=/^[A-Za-z0-9_-]{32,128}$/;

export function websocketPlayerToken(headers:Headers):string|null{
  const raw=headers.get('sec-websocket-protocol')??'';
  if(raw.length===0||raw.length>512)return null;
  const protocols=raw.split(',').map(value=>value.trim()).filter(Boolean);
  if(protocols.length!==2||!protocols.includes(websocketProtocol))return null;
  const playerProtocols=protocols.filter(value=>value.startsWith('player.'));
  if(playerProtocols.length!==1)return null;
  const token=playerProtocols[0]!.slice('player.'.length);
  return playerTokenPattern.test(token)?token:null;
}
