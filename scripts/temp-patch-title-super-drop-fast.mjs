import {readFile,writeFile} from 'node:fs/promises';

const input=process.argv[2]??'/tmp/title_supercomputer_inplace.cpp';
const output=process.argv[3]??'/tmp/title_supercomputer_drop_fast.cpp';
let source=await readFile(input,'utf8');
const start=source.indexOf('int super_drop_potential(const Position&pos,int side){');
const end=source.indexOf('\nint super_promotion_potential(',start);
if(start<0||end<=start)throw new Error('DROP_POTENTIAL_BLOCK_MISSING');
const replacement=`int super_drop_potential(const Position&pos,int side){
  bool pawnFile[9]={};int pawnLegalEmpty[9]={};int emptyAll=0,emptyLastOk=0,emptyKnightOk=0;
  const bool sente=side==1;
  for(int sq=0;sq<81;++sq){
    const int code=pos.board[sq],y=row_of(sq),x=col_of(sq);
    if(code==side)pawnFile[x]=true;
    if(code!=0)continue;
    ++emptyAll;
    const bool lastOk=sente?y!=0:y!=8;
    if(lastOk){++emptyLastOk;++pawnLegalEmpty[x];}
    if(sente?y>1:y<7)++emptyKnightOk;
  }
  int pawnOpen=0;for(int x=0;x<9;++x)if(!pawnFile[x])pawnOpen+=pawnLegalEmpty[x];
  const int si=side_index(side);int score=0;
  for(int kind=1;kind<=7;++kind){
    const int held=pos.hands[si][kind-1];if(!held)continue;
    const int open=kind==1?pawnOpen:kind==2?emptyLastOk:kind==3?emptyKnightOk:emptyAll;
    score+=held*(piece_value(kind)/20+4)+open*(kind>=6?3:1);
  }
  return score;
}
`;
source=source.slice(0,start)+replacement+source.slice(end+1);
await writeFile(output,source);
console.log(JSON.stringify({ok:true,input,output,bytes:source.length}));