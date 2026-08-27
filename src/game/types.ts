export type Side = 'sente' | 'gote';
export type PieceKind = 'king'|'rook'|'bishop'|'gold'|'silver'|'knight'|'lance'|'pawn';
export type PromotedKind = 'dragon'|'horse'|'promotedSilver'|'promotedKnight'|'promotedLance'|'tokin';
export type BoardKind = PieceKind | PromotedKind;
export interface Piece { side: Side; kind: BoardKind }
export type Square = Piece | null;
export type Board = Square[][];
export type Hands = Record<Side, Record<PieceKind, number>>;
export interface Position { board: Board; hands: Hands; turn: Side; ply: number; history: string[] }
export interface Move { from?: [number, number]; to: [number, number]; drop?: PieceKind; promote?: boolean }
export type Handicap = 'even'|'rook'|'bishop'|'two'|'four'|'six';
export type Mode = 'cpu'|'local'|'online';
export type CpuLevel = 'beginner'|'intermediate'|'amateur'|'pro'|'title';
