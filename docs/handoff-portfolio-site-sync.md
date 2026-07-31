# 引き継ぎ: ポートフォリオサイトへの移植と、このリポジトリとの同期

2026-07-29〜31、Mac上のClaude Codeセッションで作成。
このアプリを [terasaki-8910.github.io](https://terasaki-8910.github.io) の1ページ
（`/chara-picker/` = 「理想の推しア◯ネイター」）として公開したのに伴い、
**このリポジトリのエンジンとデータを、あちらへ機械的に同期する仕組み**を入れた。
その際に本リポジトリ側へ加えた変更の説明。

## 最初に読むもの

1. `CLAUDE.md`（プロジェクトルート） — 全体のルール・言語方針・Gitポリシー。**必ず先に読む。**
2. `docs/ARCHITECTURE.md` の「ベイズ推薦エンジン試作」節 — エンジンの設計。
3. このファイル。

## 何が変わったか（1コミット）

`refactor(engine): bayesのデータ注入をinitBayesData()に分離`

**エンジンの計算内容は1行も変えていない。** 変えたのは「尤度データをどこから受け取るか」だけ。

### 変更理由

`src/engine/bayes.ts` が先頭で
```ts
import likelihoodsData from '../../data/bayes/likelihoods.json';
import questionsRuntimeData from '../../data/bayes/questions.runtime.json';
```
としていたため、このファイルをそのまま持っていくと、配信方法の違う
ポートフォリオサイト側で**約280KBのJSONが必ずJSバンドルに載ってしまう**
（あちらは静的ホスティングで、データは実行時fetchしたい）。

かといってあちらで別バージョンを持つと、エンジンが二重管理になって必ず食い違う。
そこで**データの取得元を呼び出し側の責務に移し、`bayes.ts` 自体は
両リポジトリでバイト単位に同一**にした。

### 具体的な差分

| ファイル | 変更 |
|---|---|
| `src/engine/bayes.ts` | JSON importを削除。`initBayesData(likelihoods, questions)` で受け取る。導出テーブル（`questionIndex`/`probeByKey`/`allProbes`）も同関数内で構築。初期化前にエンジン関数を呼ぶと `likelihoodOf()` が明示的に投げる |
| `src/hooks/useBayesInterview.ts` | `dataset` を import せず**引数**で受け取る。reducerへは `recentGuessIds` と同じく action 経由で渡し、reducerは純粋なまま |
| `src/data/bayesRuntime.ts` | **新規**。このアプリ側の注入口。静的importして `initBayes()` を提供。**SPEC 2.5 の「実行時ネットワークアクセス0件（D1）」は従来どおり維持される** |
| `src/App.tsx` | モジュールスコープで `initBayes()` を1回呼ぶ。`useBayesInterview(dataset)` に変更 |
| `tests/setup.bayes.ts` | **新規**。テスト用の注入。 |
| `vitest.config.ts` | `setupFiles: ['tests/setup.bayes.ts']` を追加 |

**テスト本体は1ファイルも変更していない。** `setupFiles` で全テスト共通に注入するため。

### 検証済みのこと

- `npm run lint`（ESLint + Stylelint + tsc）通過
- `npm run build` 通過
- `npm test`: **231 passed / 1 failed**
  - 失敗は `tests/data.test.ts` の未レビューキャラゲート（A2）。
    `sao-silica` / `umamusume-*` など**53体が `reviewed: false`** のまま。
    **この変更の前（main）でも同じく失敗する既存の状態**であり、本変更による
    新規失敗は無い。キャラ拡充を進めるなら手動レビューが必要（人の判断が要る作業）
- ブラウザ実機: classic（既定）と bayes（`?engine=bayes`）の両方で
  質問 → 推測 → 拒否 → 確定 → 結果 → おまかせ を通しで確認。
  コンソールエラーは `favicon.ico` の404のみ（元からある、無関係）

## 今後の編集場所の使い分け

ポートフォリオサイト側に同期スクリプト（`scripts/sync-chara-picker.mjs`）があり、
**このリポジトリが「正」の側**として扱われる。

| やること | 場所 | 理由 |
|---|---|---|
| キャラ追加・属性修正 | **こちら** | 収集バッチ・zodスキーマ検証・ACCEPTANCEゲートがある |
| 質問/尤度/推薦ロジック | **こちら** | bayes関連テスト5ファイルがある |
| 画面の見た目・文言 | **サイト側** | UIはあちらが正。Tailwindのバージョンが違い互換性が無い |

### 同期対象（あちらでは編集されない = ここが正）

- データ4件: `data/characters.json` / `data/supply.json` /
  `data/bayes/likelihoods.json` / `data/bayes/questions.runtime.json`
- コード8件: `src/engine/{bayes,recommend,questions,supply,cooldown}.ts` /
  `src/data/schema.ts` / `src/hooks/{useBayesInterview,useSessionLog}.ts`

**この8ファイルを編集すると、あちらへそのまま流れる。** 逆に、あちらで
これらが編集されていた場合は同期スクリプトが検出して中断する
（sha256をマニフェストに記録している）。

### 注意: エンジンを編集するときの制約

上記8ファイルは**両リポジトリで同一である前提**なので、以下を守ること。

- `bayes.ts` に `data/*.json` の import を戻さない（同期が壊れる）
- コメントに「このアプリでは〜」のような片側視点の記述を書かない
  （あちらでも同じ文面が表示されるため、両方に通じる書き方にする）
- 配信方法に依存する処理は `src/data/bayesRuntime.ts` 側に置く

## ポートフォリオサイト側で何が起きているか（参考）

- UIは全面的に書き直されている（Tailwind 3、サイト共通のデザイン言語、
  ライト/ダーク両対応）。こちらのUIとはコードを共有していない
- classicエンジンと `?engine=` の切り替えは移植していない（bayesのみ）
- `useSessionLog` の dev用POST（`/__session-log`）はあちらにも同じコードがあるが、
  受け側は204を返すだけのダミー。**分析用のセッションログ収集はこちら側で行う**
- キャラ画像は全件 `imagePath: null` のまま。あちらでは空の枠が表示され続けている
  （SPEC 2.6 の「枠自体は消さない」方針のまま）。Danbooru APIでの画像取得が
  検討されているが未着手
- サイト側の詳細: あちらの `documentation/chara-picker.md`
