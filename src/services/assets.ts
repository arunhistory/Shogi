import type { AppSettings } from './settings';

type AssetManifest={bgm?:Record<string,string>;se?:Record<string,string>;images?:Record<string,string>};
export class AssetManager{
  private manifest:AssetManifest={}; private bgm:HTMLAudioElement|null=null;
  async load():Promise<void>{try{const r=await fetch('/assets/manifest.json',{cache:'no-cache'});if(r.ok)this.manifest=await r.json() as AssetManifest;}catch{this.manifest={};}}
  image(key:string):string|null{return this.manifest.images?.[key]??null;}
  playSe(key:string,settings:AppSettings):void{const src=this.manifest.se?.[key];if(!src||!settings.se.enabled)return;const audio=new Audio(src);audio.volume=settings.se.volume;void audio.play().catch(()=>{});}
  playBgm(key:string,settings:AppSettings):void{const src=this.manifest.bgm?.[key];if(!src||!settings.bgm.enabled)return;if(this.bgm?.src.endsWith(src)){this.bgm.volume=settings.bgm.volume;return;}this.stopBgm();this.bgm=new Audio(src);this.bgm.loop=true;this.bgm.volume=settings.bgm.volume;void this.bgm.play().catch(()=>{});}
  apply(settings:AppSettings):void{if(this.bgm){this.bgm.volume=settings.bgm.volume;if(!settings.bgm.enabled)this.bgm.pause();}}
  stopBgm():void{if(this.bgm){this.bgm.pause();this.bgm=null;}}
}
