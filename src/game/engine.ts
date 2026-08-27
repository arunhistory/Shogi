import type {
  Board, BoardKind, DroppableKind, GameResult, Handicap, Hands, HistoryEntry,
  Move, Piece, PieceKind, Position, Side, Square,
} from './types';

export const BOARD_SIZE = 9;
export const DROPPABLE_KINDS: DroppableKind[] = ['rook','bishop','gold','silver','knight','lance','pawn'];

const promoteMap: Partial<Record<PieceKind, BoardKind>> = {
  rook:'dragon', bishop:'horse', silver:'promotedSilver', knight:'promotedKnight', lance:'promotedLance', pawn:'tokin',
};
const unpromoteMap: Record<BoardKind, PieceKind> = {
  king:'king', rook:'rook', bishop:'bishop', gold:'gold', silver:'silver', knight:'knight', lance:'lance', pawn:'pawn',
  dragon:'rook', horse:'bishop', promotedSilver:'silver', promotedKnight:'knight', promotedLance:'lance', tokin:'pawn',
};

const enemy = (side: Side): Side => side === 'sente' ? 'gote' : 'sente';
const inside = (y: number, x: number) => y >= 0 && y < BOARD_SIZE && x >= 0 && x < BOARD_SIZE;
const piece = (side: Side, kind: BoardKind): Piece => ({ side, kind });

export function emptyHands(): Hands {
  const hand = (): Record<DroppableKind, number> => ({rook:0,bishop:0,gold:0,silver:0,knight:0,lance:0,pawn:0});
  return { sente: hand(), gote: hand() };
}

function clonePosition(pos: Position): Position {
  return {
    board: pos.board.map(row => row.map(cell => cell ? { ...cell } : null)),
    hands: { sente: { ...pos.hands.sente }, gote: { ...pos.hands.gote } },
    turn: pos.turn,
    ply: pos.ply,
    history: pos.history.map(h => ({ ...h })),
  };
}

export function positionKey(pos: Pick<Position, 'turn'|'board'|'hands'>): string {
  return JSON.stringify([pos.turn, pos.board, pos.hands]);
}

function seedHistory(pos: Position): Position {
  const seeded = clonePosition(pos);
  seeded.history = [{ key: positionKey(seeded), turn: seeded.turn, lastMoveBy: null, gaveCheck: false }];
  return seeded;
}

export function initialPosition(handicap: Handicap = 'even'): Position {
  const board: Board = Array.from({ length: 9 }, () => Array<Square>(9).fill(null));
  const back: PieceKind[] = ['lance','knight','silver','gold','king','gold','silver','knight','lance'];
  for (let x = 0; x < 9; x++) {
    board[0]![x] = piece('gote', back[x]!);
    board[8]![x] = piece('sente', back[x]!);
    board[2]![x] = piece('gote', 'pawn');
    board[6]![x] = piece('sente', 'pawn');
  }
  board[1]![1] = piece('gote', 'rook');
  board[1]![7] = piece('gote', 'bishop');
  board[7]![1] = piece('sente', 'bishop');
  board[7]![7] = piece('sente', 'rook');

  const removeGote = (kind: PieceKind) => {
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      const q = board[y]![x];
      if (q?.side === 'gote' && q.kind === kind) { board[y]![x] = null; return; }
    }
  };
  if (handicap === 'rook') removeGote('rook');
  if (handicap === 'bishop') removeGote('bishop');
  if (handicap === 'two' || handicap === 'four' || handicap === 'six') { removeGote('rook'); removeGote('bishop'); }
  if (handicap === 'four' || handicap === 'six') { removeGote('lance'); removeGote('lance'); }
  if (handicap === 'six') { removeGote('knight'); removeGote('knight'); }

  return seedHistory({ board, hands: emptyHands(), turn: handicap === 'even' ? 'sente' : 'gote', ply: 0, history: [] });
}

const goldBase = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,0]] as const;
function vectors(q: Piece): { step: readonly (readonly [number,number])[]; slide: readonly (readonly [number,number])[] } {
  const f = q.side === 'sente' ? -1 : 1;
  switch (q.kind) {
    case 'king': return { step:[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]], slide:[] };
    case 'gold': case 'promotedSilver': case 'promotedKnight': case 'promotedLance': case 'tokin':
      return { step: goldBase.map(([dy,dx]) => [dy * (q.side === 'sente' ? 1 : -1), dx] as const), slide:[] };
    case 'silver': return { step:[[f,-1],[f,0],[f,1],[-f,-1],[-f,1]], slide:[] };
    case 'knight': return { step:[[2*f,-1],[2*f,1]], slide:[] };
    case 'lance': return { step:[], slide:[[f,0]] };
    case 'pawn': return { step:[[f,0]], slide:[] };
    case 'rook': return { step:[], slide:[[-1,0],[1,0],[0,-1],[0,1]] };
    case 'bishop': return { step:[], slide:[[-1,-1],[-1,1],[1,-1],[1,1]] };
    case 'dragon': return { step:[[-1,-1],[-1,1],[1,-1],[1,1]], slide:[[-1,0],[1,0],[0,-1],[0,1]] };
    case 'horse': return { step:[[-1,0],[1,0],[0,-1],[0,1]], slide:[[-1,-1],[-1,1],[1,-1],[1,1]] };
  }
}

function pseudoTargets(pos: Position, y: number, x: number): [number,number][] {
  const q = pos.board[y]?.[x];
  if (!q) return [];
  const out: [number,number][] = [];
  const { step, slide } = vectors(q);
  for (const [dy,dx] of step) {
    const ny = y + dy, nx = x + dx;
    if (inside(ny,nx) && pos.board[ny]![nx]?.side !== q.side) out.push([ny,nx]);
  }
  for (const [dy,dx] of slide) {
    let ny = y + dy, nx = x + dx;
    while (inside(ny,nx)) {
      const target = pos.board[ny]![nx];
      if (!target) out.push([ny,nx]);
      else { if (target.side !== q.side) out.push([ny,nx]); break; }
      ny += dy; nx += dx;
    }
  }
  return out;
}

export function isSquareAttacked(pos: Position, by: Side, y: number, x: number): boolean {
  for (let fy = 0; fy < 9; fy++) for (let fx = 0; fx < 9; fx++) {
    const q = pos.board[fy]![fx];
    if (q?.side === by && pseudoTargets(pos, fy, fx).some(([ty,tx]) => ty === y && tx === x)) return true;
  }
  return false;
}

export function isCheck(pos: Position, side: Side): boolean {
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const q = pos.board[y]![x];
    if (q?.side === side && q.kind === 'king') return isSquareAttacked(pos, enemy(side), y, x);
  }
  return true;
}

const inPromotionZone = (side: Side, y: number) => side === 'sente' ? y <= 2 : y >= 6;
function mustPromote(kind: PieceKind, side: Side, y: number): boolean {
  if ((kind === 'pawn' || kind === 'lance') && (side === 'sente' ? y === 0 : y === 8)) return true;
  return kind === 'knight' && (side === 'sente' ? y <= 1 : y >= 7);
}

function rawApply(pos: Position, move: Move): Position {
  const next = clonePosition(pos);
  const mover = pos.turn;
  next.turn = enemy(mover);
  next.ply++;

  if (move.drop) {
    if (next.hands[mover][move.drop] <= 0) throw new Error('INVALID_DROP_STATE');
    next.board[move.to[0]]![move.to[1]] = { side:mover, kind:move.drop };
    next.hands[mover][move.drop]--;
  } else if (move.from) {
    const [fy,fx] = move.from;
    let moving = next.board[fy]?.[fx];
    if (!moving) throw new Error('INVALID_MOVE_STATE');
    const captured = next.board[move.to[0]]![move.to[1]];
    if (captured?.kind === 'king') throw new Error('KING_CAPTURE_FORBIDDEN');
    if (captured) {
      const base = unpromoteMap[captured.kind];
      if (base === 'king') throw new Error('KING_CAPTURE_FORBIDDEN');
      next.hands[mover][base as DroppableKind]++;
    }
    next.board[fy]![fx] = null;
    const base = unpromoteMap[moving.kind];
    if (move.promote && moving.kind === base && promoteMap[base]) moving = { ...moving, kind:promoteMap[base]! };
    next.board[move.to[0]]![move.to[1]] = moving;
  } else {
    throw new Error('INVALID_MOVE_STATE');
  }

  const gaveCheck = isCheck(next, next.turn);
  const entry: HistoryEntry = { key:positionKey(next), turn:next.turn, lastMoveBy:mover, gaveCheck };
  next.history.push(entry);
  return next;
}

function dropBaseLegal(pos: Position, kind: DroppableKind, y: number, x: number): boolean {
  if (pos.board[y]![x] || pos.hands[pos.turn][kind] <= 0) return false;
  if ((kind === 'pawn' || kind === 'lance') && (pos.turn === 'sente' ? y === 0 : y === 8)) return false;
  if (kind === 'knight' && (pos.turn === 'sente' ? y <= 1 : y >= 7)) return false;
  if (kind === 'pawn') {
    for (let yy = 0; yy < 9; yy++) {
      const q = pos.board[yy]![x];
      if (q?.side === pos.turn && q.kind === 'pawn') return false;
    }
  }
  return true;
}

function moveIdentity(move: Move): string {
  return `${move.from?.[0] ?? 'd'},${move.from?.[1] ?? move.drop}:${move.to[0]},${move.to[1]}:${move.promote ? 1 : 0}`;
}

function generateLegalMoves(pos: Position, cache: Map<string,Move[]>, stack: Set<string>): Move[] {
  const cacheKey = `${positionKey(pos)}|legal`;
  const cached = cache.get(cacheKey);
  if (cached) return cached.map(m => ({ ...m, from:m.from ? [...m.from] as [number,number] : undefined, to:[...m.to] as [number,number] }));

  const out: Move[] = [];
  const mover = pos.turn;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const q = pos.board[y]![x];
    if (q?.side !== mover) continue;
    for (const to of pseudoTargets(pos, y, x)) {
      const destination = pos.board[to[0]]![to[1]];
      if (destination?.kind === 'king') continue;
      const base = unpromoteMap[q.kind];
      const canPromote = q.kind === base && !!promoteMap[base] && (inPromotionZone(mover,y) || inPromotionZone(mover,to[0]));
      const variants: Move[] = mustPromote(base,mover,to[0])
        ? [{from:[y,x],to,promote:true}]
        : canPromote ? [{from:[y,x],to},{from:[y,x],to,promote:true}] : [{from:[y,x],to}];
      for (const move of variants) {
        const next = rawApply(pos, move);
        if (!isCheck(next, mover)) out.push(move);
      }
    }
  }

  for (const kind of DROPPABLE_KINDS) {
    if (pos.hands[mover][kind] <= 0) continue;
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      if (!dropBaseLegal(pos,kind,y,x)) continue;
      const move: Move = { drop:kind, to:[y,x] };
      const next = rawApply(pos, move);
      if (isCheck(next,mover)) continue;
      if (kind === 'pawn' && isCheck(next,next.turn)) {
        const recursionKey = `${positionKey(next)}|pawn-mate`;
        if (!stack.has(recursionKey)) {
          stack.add(recursionKey);
          const replies = generateLegalMoves(next, cache, stack);
          stack.delete(recursionKey);
          if (replies.length === 0) continue;
        }
      }
      out.push(move);
    }
  }
  const unique = [...new Map(out.map(m => [moveIdentity(m),m])).values()];
  cache.set(cacheKey, unique);
  return unique.map(m => ({ ...m, from:m.from ? [...m.from] as [number,number] : undefined, to:[...m.to] as [number,number] }));
}

export function legalMoves(pos: Position): Move[] {
  return generateLegalMoves(pos, new Map(), new Set());
}

export function applyMove(pos: Position, move: Move): Position {
  const id = moveIdentity(move);
  const legal = legalMoves(pos).find(candidate => moveIdentity(candidate) === id);
  if (!legal) throw new Error('ILLEGAL_MOVE');
  return rawApply(pos, legal);
}

export function isMate(pos: Position): boolean {
  return isCheck(pos,pos.turn) && legalMoves(pos).length === 0;
}

export function repetitionCount(pos: Position): number {
  const key = positionKey(pos);
  return pos.history.reduce((n,h) => n + (h.key === key ? 1 : 0), 0);
}

function perpetualChecker(pos: Position): Side | null {
  const key = positionKey(pos);
  const occurrences: number[] = [];
  pos.history.forEach((entry,index) => { if (entry.key === key) occurrences.push(index); });
  if (occurrences.length < 4) return null;
  const start = occurrences[occurrences.length - 4]!;
  const end = occurrences[occurrences.length - 1]!;
  for (const side of ['sente','gote'] as const) {
    const moves = pos.history.slice(start + 1, end + 1).filter(h => h.lastMoveBy === side);
    if (moves.length > 0 && moves.every(h => h.gaveCheck)) return side;
  }
  return null;
}

export function gameResult(pos: Position): GameResult {
  if (isMate(pos)) {
    const winner = enemy(pos.turn);
    return { status:'finished', reason:'checkmate', winner, loser:pos.turn };
  }
  if (repetitionCount(pos) >= 4) {
    const checker = perpetualChecker(pos);
    if (checker) return { status:'finished', reason:'perpetual_check', winner:enemy(checker), loser:checker };
    return { status:'finished', reason:'repetition', winner:null, loser:null };
  }
  return { status:'ongoing' };
}

export function dangerousSquaresFor(pos: Position, side: Side): Set<string> {
  const attacked = new Set<string>();
  const by = enemy(side);
  for (let y=0;y<9;y++) for (let x=0;x<9;x++) if (isSquareAttacked(pos,by,y,x)) attacked.add(`${y},${x}`);
  return attacked;
}

export function serializePositionForWasm(pos: Position): Int32Array {
  const code: Record<BoardKind,number> = {
    king:1,rook:2,bishop:3,gold:4,silver:5,knight:6,lance:7,pawn:8,
    dragon:9,horse:10,promotedSilver:11,promotedKnight:12,promotedLance:13,tokin:14,
  };
  const out = new Int32Array(96);
  let i = 0;
  for (let y=0;y<9;y++) for (let x=0;x<9;x++) {
    const q = pos.board[y]![x];
    out[i++] = q ? code[q.kind] * (q.side === 'sente' ? 1 : -1) : 0;
  }
  for (const side of ['sente','gote'] as const) for (const kind of DROPPABLE_KINDS) out[i++] = pos.hands[side][kind];
  out[i] = pos.turn === 'sente' ? 1 : -1;
  return out;
}

export function decodePackedWasmMove(packed: number): Move | null {
  if (packed < 0) return null;
  const to = packed & 0x7f;
  const from = (packed >>> 7) & 0x7f;
  const promote = ((packed >>> 14) & 1) === 1;
  const dropCode = (packed >>> 15) & 0x0f;
  const toY = Math.floor(to / 9), toX = to % 9;
  if (!inside(toY,toX)) return null;
  if (dropCode > 0) {
    const kind = DROPPABLE_KINDS[dropCode - 1];
    return kind ? {drop:kind,to:[toY,toX]} : null;
  }
  const fromY = Math.floor(from / 9), fromX = from % 9;
  return inside(fromY,fromX) ? {from:[fromY,fromX],to:[toY,toX],promote:promote || undefined} : null;
}
