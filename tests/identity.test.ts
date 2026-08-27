import { describe, expect, it } from 'vitest';
import { connectionOwnsSeat, issueSeatCredential, reconnectSeat, verifySeatCredential } from '../src/online/identity';

describe('online seat identity',()=>{
  it('requires the issued player credential for reconnect',async()=>{
    const issued=await issueSeatCredential('sente');
    expect(await verifySeatCredential(issued.identity,issued.credential)).toBe(true);
    expect(await verifySeatCredential(issued.identity,'wrong-credential')).toBe(false);
  });

  it('moves authority to the newest connection generation',async()=>{
    const issued=await issueSeatCredential('gote');
    const first=await reconnectSeat(issued.identity,issued.credential,'conn-a');
    expect(first).not.toBeNull();
    if(!first)throw new Error('reconnect failed');
    expect(connectionOwnsSeat(first,'conn-a',1)).toBe(true);

    const second=await reconnectSeat(first,issued.credential,'conn-b');
    expect(second).not.toBeNull();
    if(!second)throw new Error('second reconnect failed');
    expect(connectionOwnsSeat(second,'conn-a',1)).toBe(false);
    expect(connectionOwnsSeat(second,'conn-b',2)).toBe(true);
  });
});
