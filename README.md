# Shogi Web App

設計図 `shogi_webapp_blueprint.docx` に基づくゲーム本体リポジトリ。

## 構成
- TypeScript: UI / 状態管理 / 入力 / 通信 / WASM連携
- C++ → WebAssembly: 高負荷処理用境界
- Cloudflare: オンライン対局・共通API・表示用管理情報（別経路で実装）

## 開発
```sh
npm install
npm run build
npm test
```

WASMを生成する環境では Emscripten を用意して `sh scripts/build-wasm.sh` を実行する。

## 未確定仕様
設計図第31項に列挙された事項、および入玉・持将棋の採用方式は勝手に確定しない。素材・規約・クレジット・ライセンス本文も後付け可能な構造とする。
