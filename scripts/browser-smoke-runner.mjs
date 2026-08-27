let failed=null;
try{
  await import('./browser-smoke.mjs');
}catch(error){
  failed=error;
}
if(failed){
  console.error(failed);
  process.exit(1);
}
process.exit(0);
