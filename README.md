# Shogi Web App

設計図 `shogi_webapp_blueprint.docx` に基づくゲーム本体リポジトリ。

## 構成
- TypeScript: UI / 状態管理 / 入力 / 通信 / WASM連携
- C++ → WebAssembly: 合法手生成・局面評価・CPU探索・詰み判定等の高負荷処理
- Cloudflare: オンライン対局・共通API・表示用管理情報（Supabase制御経路で実装）
- `build-output` branch: Pagesで検証・公開した同一artifactのビルド後JavaScript / CSS / WebAssembly / Cloudflare配備bundleを保存

## 開発
```sh
npm ci
npm test
npm run build
```

Cloudflare側も `cloudflare/package-lock.json` を正本として `npm ci` を使用する。

WASMを生成する環境では Emscripten を用意して `sh scripts/build-wasm.sh` を実行する。

## 後付け素材
`public/assets/manifest.json` を素材の差し替え境界とする。素材が0件、未取得、読込失敗でも対局処理は継続する。

- `bgm`: `{ "id": "...", "url": "...", "loop": true }`
- `se`: `{ "id": "...", "url": "..." }`
- `visuals`: `{ "id": "...", "url": "..." }`

visual ID は任意に追加でき、各IDは自動的に `--shogi-asset-<id>` CSS変数として公開される。現在の表示側に接続済みの予約IDは `menu-background`、`game-background`、`board-texture`、`app-icon`。`menu-illustration` と `game-illustration` は差し替え口だけを確保し、具体的な配置デザインは未確定仕様として固定しない。

公開リポジトリへ秘密情報を置かない。素材URLはHTTPSまたは同一Originのみ受け付ける。

## Cloudflare管理コンテンツ
利用規約・クレジット・ライセンス本文はGitHubへ固定せず、Cloudflare側の読み取り専用ユーザー経路から取得する。本文内容は未確定のためリポジトリでは決めない。オブジェクト形式の本文は任意カテゴリ名を見出しとして安全に表示できる。

## 未確定仕様
設計図第31項に列挙された事項、および入玉・持将棋の採用方式は勝手に確定しない。素材内容・規約・クレジット・ライセンス本文も後付け可能な構造とする。
