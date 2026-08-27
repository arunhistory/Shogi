export type Side = 'sente' | 'gote';
export type PieceKind = 'king'|'rook'|'bishop'|'gold'|'silver'|'knight'|'lance'|'pawn';
export type DroppableKind = Exclude<PieceKind, 'king'>;
export type PromotedKind = 'dragon'|'horse'|'promotedSilver'|'promotedKnight'|'promotedLance'|'tokin';
export type BoardKind = PieceKind | PromotedKind;
export interface Piece { side: Side; kind: BoardKind }
export type Square = Piece | null;
export type Board = Square[][];
export type Hands = Record<Side, Record<DroppableKind, number>>;
export interface Move { from?: [number, number]; to: [number, number]; drop?: DroppableKind; promote?: boolean }
export interface HistoryEntry {
  key: string;
  turn: Side;
  lastMoveBy: Side | null;
  gaveCheck: boolean;
}
export interface Position {
  board: Board;
  hands: Hands;
  turn: Side;
  ply: number;
  history: HistoryEntry[];
}
export type Handicap = 'even'|'rook'|'bishop'|'two'|'four'|'six';
export type Mode = 'cpu'|'local'|'online';
export type CpuLevel = 'beginner'|'intermediate'|'amateur'|'pro'|'title';
export type TerminalReason = 'checkmate'|'repetition'|'perpetual_check';
export type GameResult =
  | { status: 'ongoing' }
  | { status: 'finished'; reason: TerminalReason; winner: Side | null; loser: Side | null };
