import {describe,expect,it} from 'vitest';
import {isOptionalPromotionChoice,shouldRotatePromotionDialog} from './local-promotion';
import {isRedundantOnlineStatus,isRemovableOnlineNote} from './online-copy';

describe('promotion UI',()=>{
  it('shows an optional promotion choice when entering the promotion zone',()=>{
    expect(isOptionalPromotionChoice({label:'角',side:'sente',fromY:7,toY:2})).toBe(true);
    expect(isOptionalPromotionChoice({label:'角',side:'gote',fromY:1,toY:6})).toBe(true);
  });

  it('does not intercept forced or non-promotable moves',()=>{
    expect(isOptionalPromotionChoice({label:'歩',side:'sente',fromY:1,toY:0})).toBe(false);
    expect(isOptionalPromotionChoice({label:'桂',side:'gote',fromY:6,toY:7})).toBe(false);
    expect(isOptionalPromotionChoice({label:'金',side:'gote',fromY:5,toY:6})).toBe(false);
  });

  it('rotates only the local gote dialog for face-to-face play',()=>{
    expect(shouldRotatePromotionDialog('sente','local')).toBe(false);
    expect(shouldRotatePromotionDialog('gote','local')).toBe(true);
    expect(shouldRotatePromotionDialog('gote','cpu')).toBe(false);
    expect(shouldRotatePromotionDialog('gote','online')).toBe(false);
  });
});

describe('online copy cleanup',()=>{
  it('removes only redundant explanatory copy',()=>{
    expect(isRedundantOnlineStatus('部屋を作るか、受け取ったパスコードを入力してください。')).toBe(true);
    expect(isRedundantOnlineStatus('接続に失敗しました。パスコードと接続状態を確認してください。')).toBe(false);
    expect(isRemovableOnlineNote('オンライン対局はCloudflare側の正式状態管理へ接続して開始します。接続先未設定時は対局を開始しません。')).toBe(true);
    expect(isRemovableOnlineNote('正式局面はCloudflare側から受信した後に表示します。')).toBe(true);
  });
});
