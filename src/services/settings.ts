export interface SoundSettings { enabled:boolean; volume:number }
export interface AppSettings { bgm:SoundSettings; se:SoundSettings }
const KEY='shogi.settings.v1';
const defaults:AppSettings={bgm:{enabled:true,volume:0.7},se:{enabled:true,volume:0.8}};
export function loadSettings():AppSettings{try{const raw=localStorage.getItem(KEY);if(!raw)return structuredClone(defaults);const p=JSON.parse(raw) as Partial<AppSettings>;return {bgm:{...defaults.bgm,...p.bgm},se:{...defaults.se,...p.se}};}catch{return structuredClone(defaults);}}
export function saveSettings(value:AppSettings){localStorage.setItem(KEY,JSON.stringify(value));}
