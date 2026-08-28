export type HistorySide='sente'|'gote';

export interface HistoryPiece{
  label:string;
  side:HistorySide;
}

export type BoardSnapshot=Array<HistoryPiece|null>;

export interface InferredMove{
  side:HistorySide;
  piece:string;
  from:string|null;
  to:string;
  captured:string|null;
  promotedTo:string|null;
  drop:boolean;
}

const ranks=['一','二','三','四','五','六','七','八','九'] as const;

function samePiece(a:HistoryPiece|null,b:HistoryPiece|null):boolean{
  return a===b||!!a&&!!b&&a.label===b.label&&a.side===b.side;
}

export function squareLabel(index:number):string{
  if(!Number.isInteger(index)||index<0||index>=81)throw new Error('INVALID_BOARD_INDEX');
  const y=Math.floor(index/9);
  const x=index%9;
  return`${9-x}${ranks[y]}`;
}

export function snapshotsEqual(before:BoardSnapshot,after:BoardSnapshot):boolean{
  return before.length===81&&after.length===81&&before.every((piece,index)=>samePiece(piece,after[index]??null));
}

export function inferMove(before:BoardSnapshot,after:BoardSnapshot):InferredMove|null{
  if(before.length!==81||after.length!==81)return null;
  const changed:number[]=[];
  for(let index=0;index<81;index++)if(!samePiece(before[index]??null,after[index]??null))changed.push(index);
  if(changed.length===0)return null;

  if(changed.length===1){
    const toIndex=changed[0]!;
    const beforeTo=before[toIndex]??null;
    const afterTo=after[toIndex]??null;
    if(beforeTo||!afterTo)return null;
    return{
      side:afterTo.side,
      piece:afterTo.label,
      from:null,
      to:squareLabel(toIndex),
      captured:null,
      promotedTo:null,
      drop:true,
    };
  }

  if(changed.length!==2)return null;
  const fromCandidates=changed.filter(index=>!!before[index]&&!after[index]);
  const toCandidates=changed.filter(index=>!!after[index]&&!samePiece(before[index]??null,after[index]??null));
  if(fromCandidates.length!==1||toCandidates.length!==1)return null;

  const fromIndex=fromCandidates[0]!;
  const toIndex=toCandidates[0]!;
  if(fromIndex===toIndex)return null;
  const source=before[fromIndex]!;
  const destination=after[toIndex]!;
  if(!source||!destination||source.side!==destination.side)return null;
  const previousDestination=before[toIndex]??null;
  if(previousDestination?.side===source.side)return null;

  return{
    side:source.side,
    piece:source.label,
    from:squareLabel(fromIndex),
    to:squareLabel(toIndex),
    captured:previousDestination?.label??null,
    promotedTo:source.label===destination.label?null:destination.label,
    drop:false,
  };
}
