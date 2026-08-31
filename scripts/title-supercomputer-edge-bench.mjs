const url='https://mpuhgfbdkxmhynytwhzu.supabase.co/functions/v1/title-supercomputer';
const key='sb_publishable_POCxau9QCPFlF0J11o-ZFg_-QY4b8gF';
const positionWords=[1397245769,1,-2,-3,-4,-5,-8,-5,-4,-3,-2,0,-7,0,0,0,0,0,-6,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,0,6,0,0,0,0,0,7,0,2,3,4,5,8,5,4,3,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
if(positionWords.length!==97)throw new Error(`POSITION_WORDS:${positionWords.length}`);
async function specialist(id){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  const started=performance.now();
  try{
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','apikey':key},body:JSON.stringify({action:'specialist',specialist:id,positionWords}),signal:controller.signal});
    const wallMs=performance.now()-started;
    const text=await response.text();
    let data=null;try{data=JSON.parse(text);}catch{}
    if(!response.ok||!data?.ok)throw new Error(`SPECIALIST_${id}_HTTP_${response.status}:${String(data?.error??text.slice(0,120))}`);
    const result=data.result;
    if(Number(result?.nodes)!==5_000_000)throw new Error(`SPECIALIST_${id}_NODE_MISMATCH:${String(result?.nodes)}`);
    return{id,wallMs,internalMs:Number(result.elapsedMs),nodes:Number(result.nodes),moveCode:Number(result.moveCode),score:Number(result.score)};
  }finally{clearTimeout(timer);}
}
const results=[];
for(const id of [1,10,20])results.push(await specialist(id));
console.log('EDGE_BENCH_RESULT:'+JSON.stringify({ok:true,results,maxWallMs:Math.max(...results.map(x=>x.wallMs)),maxInternalMs:Math.max(...results.map(x=>x.internalMs))}));