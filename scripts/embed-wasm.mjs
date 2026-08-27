import fs from 'node:fs';
const [,,input,output]=process.argv;
if(!input||!output)throw new Error('usage: node scripts/embed-wasm.mjs input.wasm output.ts');
const base64=fs.readFileSync(input).toString('base64');
fs.writeFileSync(output,`// Generated from cpp/engine.cpp. Regenerate with scripts/build-wasm.sh.\nexport const SHOGI_ENGINE_WASM_BASE64 = '${base64}';\n`);
