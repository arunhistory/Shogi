import {readFile,writeFile} from 'node:fs/promises';
const path='src/style.css';
let css=await readFile(path,'utf8');
const replacements=[
  ['rgba(43,92,170,.88)','rgba(177,24,24,.92)'],
  ['rgba(241,205,72,.94)','rgba(177,24,24,.92)'],
  ['rgba(43,92,170,.9)','rgba(177,24,24,.95)'],
  ['rgba(241,205,72,.82)','rgba(196,28,28,.78)'],
  ['rgba(255,248,205,.56)','rgba(255,214,214,.52)'],
];
for(const [from,to] of replacements){
  if(!css.includes(from))throw new Error(`COLOR_MARKER_MISSING:${from}`);
  css=css.split(from).join(to);
}
if(/rgba\(43,92,170|rgba\(241,205,72/.test(css))throw new Error('OLD_OPPONENT_COLORS_REMAIN');
await writeFile(path,css,'utf8');
