# システム構成

`random-chara-picker` の実装アーキテクチャ。何を作ったかは SPEC.md、
合否基準は ACCEPTANCE.md、意思決定の経緯は PLAN.md を参照。ここは
「今のコードが実際にどう繋がっているか」だけを、実装から書き起こす。

## 全体像

```
                    ┌─────────────────────────┐
  ビルド時のみ       │  scripts/collect.mjs      │  DLsite 検索結果 1 ページ目
  （手動実行）        │  scripts/collect-hitomi   │  hitomi.la nozomi ファイル
                    │  scripts/census-hitomi    │  → data/characters.json
                    └───────────┬───────────────┘    data/supply.json
                                │ 静的 import（実行時 fetch は無い）
                                ▼
┌───────────────────────────────────────────────────────────────┐
│  src/data/schema.ts   Character / SupplyFile の型 + zod 検証     │
└───────────────────────────────┬─────────────────────────────────┘
                                 ▼
┌───────────────────────────────────────────────────────────────┐
│  src/engine/                                                    │
│   ├─ supply.ts      pageCount/galleryCount → 供給量ランク         │
│   ├─ questions.ts   (軸,値) ごとの二値プローブ生成 + エントロピー選択 │
│   └─ recommend.ts   3値スコアリング + ハイブリッド母集団 + 推測ループ │
└───────────────────────────────┬─────────────────────────────────┘
                                 ▼
┌───────────────────────────────────────────────────────────────┐
│  src/hooks/useInterview.ts   reducer（phase: asking/guessing/    │
│                               confirmed/exhausted）               │
└───────────────────────────────┬─────────────────────────────────┘
                                 ▼
┌───────────────────────────────────────────────────────────────┐
│  src/App.tsx → src/screens/*.tsx（phase ごとに1画面を出し分け）   │
└───────────────────────────────────────────────────────────────┘
```

ブラウザの実行時には収集スクリプトは一切関与しない。
`data/characters.json` / `data/supply.json` は Vite のビルド時に静的 import
されてバンドルへ同梱され、実行時ネットワークアクセスはゼロ（ACCEPTANCE D1）。

## データ層

### `src/data/schema.ts`

`Character` / `Axes` / `SupplyEntry` / `SupplyFile` の型と、対応する zod
スキーマ（`charactersSchema` / `supplyFileSchema`）。全 16 属性軸（性別表現・
年齢感・体格・胸・性格・関係性ロール・距離感・見た目の記号・髪色・肌色・
衣装立場・種族・雰囲気・戦うか・所属の種類・所属名）はここに定義があり、
`tests/helpers/data.ts` に独立した literal（`AXIS_VALUES`）として二重化して
いる。片方だけを typo しても検出できるようにするための意図的な重複であり、
一方から他方を import してはいけない。

`imagePath` / `imageApproved` は画像用のフィールド（下記「画像」参照）。

### `data/characters.json` / `data/supply.json`

- `characters.json`: 人手キュレーションのキャラ台帳。`reviewed: false` の
  レコードが 1 件でも残っているとゲートが落ちる（`tests/data.test.ts` の
  A2）。`provisional: true` は公式デザイン未確定などで恒久的にレビュー未完了
  のまま置くキャラで、推薦のハードフィルタで常に除外される。
- `supply.json`: キャラ id をキーにした供給量の生データ（DLsite の
  `pageCount` と hitomi.la の `galleryCount`）。`scripts/collect.mjs` /
  `scripts/collect-hitomi.mjs` が書く。手で数値を捏造しないこと
  （SPEC 4.3 — このプロジェクトの存在理由そのものである在庫制約が崩れる）。

### 収集スクリプト（`scripts/`。アプリとは別プロセス）

| スクリプト | 役割 |
|---|---|
| `collect.mjs` | DLsite 検索結果 1 ページ目のみを取得し `pageCount` を書く。robots.txt 準拠・10秒間隔厳守 |
| `collect-hitomi.mjs` | hitomi.la の nozomi ファイル（タグ別ギャラリー数の生配列）を取得 |
| `census-hitomi.mjs` | series タグからそのシリーズのキャラを供給量順に列挙する。**収録候補をここから機械的に決める** — Claude の記憶からキャラ名を出さない（SPEC 4.3の捏造対策） |
| `dist-scan.mjs` | ビルド成果物 `dist/` に DLsite の HTML/画像/作品タイトルが混入していないか走査（ACCEPTANCE D2） |

`npm run collect` 等で手動実行する。CI ゲートには含めない（外部サイト依存を
ゲートに入れると DLsite 側の都合でビルドが落ちるようになるため）。

## エンジン層（`src/engine/`）

### `supply.ts`

`pageCount` / `galleryCount` を5段階ランク（なし/僅少/少ない/十分/豊富）に
段階化する純関数。DLsite と hitomi.la は単位が違うため閾値も別に定義し、
`combinedSupplyRank` で高い方を採用する。

### `questions.ts` — プローブの生成と選択

「軸の選択肢を並べて1つ選ぶ」のではなく、**作業集団に実在する `(軸, 値)` の
組み合わせごとに二値質問（プローブ）を動的生成する**。「髪は黒いですか?」
のように、単一値軸（`===`判定）・複数値軸（`.includes()`判定）を同じ枠組み
で扱う。

- `buildProbePool(characters)`: 集団に実在する値だけからプローブ配列を作る。
- `selectProbe(population, askedKeys)`: 二値エントロピー
  （`H = -p·log2(p) - (1-p)·log2(1-p)`）が最大の未質問プローブを選ぶ。
  0.35 ビット未満（`MIN_GAIN`）は「聞く意味がない」として除外。同点は
  軸の固定優先順位 → 値の辞書順でタイブレーク（決定論）。
- 確信度は5段階（`Confidence`）: はい/たぶんそう/わからない/たぶん違う/
  いいえ。重みは `{ yes: 1, probably_yes: 0.5, unknown: 0, probably_no: -0.5,
  no: -1 }`。

### `recommend.ts` — スコアリングと推測ループ

- **ハードフィルタ**（`survivors`）: 供給量ランク「なし」／性別表現「男性」／
  `provisional: true` を常に除外。
- **スコアリング（3値式）**: 軸が空欄なら確信度に関わらず常に0（供給先行・
  属性は後追いという前提を守るため）。非空欄のみ、一致で `+w×20`、不一致で
  `-w×20`。供給量は加点せず、並び順のタイブレークにのみ使う。
- **質問選択のハイブリッド母集団**: 通常は回答と矛盾しない「作業集合」で
  プローブを選ぶ。作業集合が2体未満に縮んだら、スコア上位10体
  （`CONTENTION_M`）の「接戦集合」に切り替える。これにより、作業集合が早期に
  1体へ収束したあとも最低質問数（`MIN_QUESTIONS = 6`）に達するまで意味の
  ある質問を出し続けられる。上限は `HARD_CAP = 10`。
- **推測**: `shouldGuess` が条件（floor到達 かつ マージン十分/情報量枯渇/
  上限到達のいずれか）を満たすと `topGuess` が単一キャラを返す
  （同点のみ乱択でタイブレーク — 「ランダム」の実体はここだけ）。
- **拒否ループ**: 「いいえ」で除外して再スコアし、分離できる情報量があれば
  1問だけ追加してから次点を提示。除外され続けて候補が尽きたら「全滅」。

## 状態管理（`src/hooks/useInterview.ts`）

`useReducer` ベース。生の事実（`answers` / `askedKeys` / `rejected` /
`bonusPending` / `guess` / `confirmed` / `exhausted`）だけを reducer で持ち、
公開する `InterviewState` は `phase` で判別する discriminated union
（`asking` / `guessing` / `confirmed` / `exhausted`）として毎レンダー導出する。

質問選択（`nextProbe`）は完全に決定論的なので毎回引き直して安全だが、
`topGuess` の同点タイブレークは乱数を使うため、遷移が起きた瞬間の reducer
内で一度だけ確定し、以降の再レンダーでは同じ推測を保持する
（引き直すと同点だったときに表示中の推測が再描画のたびに変わってしまう）。

## UI層

`src/App.tsx` が `interview.phase` を見て画面を出し分ける（`switch` +
網羅性チェック）。おまかせ（`omakase`）は質問・推測ループを経ない独立経路。

| 画面 | ファイル | 出るとき |
|---|---|---|
| 質問 | `screens/QuestionScreen.tsx` | `phase === 'asking'`。1プローブ1画面、回答ボタンは常に5つ |
| 推測確認 | `screens/GuessScreen.tsx` | `phase === 'guessing'`。単一候補 + はい/いいえ |
| 結果 | `screens/ResultScreen.tsx` | `phase === 'confirmed'`、またはおまかせの即時結果 |
| 全滅 | `screens/NoGuessScreen.tsx` | `phase === 'exhausted'`。近い候補を参考表示 |

`GuessScreen` と `ResultScreen` は画像・名前・根拠の中身を
`components/CharacterReveal.tsx` に共通化している（枠と下部ボタンだけが違う）。

### 画像（`components/CharacterImage.tsx`）

`Character.imagePath` はユーザー本人が合法的に所持・作成した画像への
ローカルパス（`public/character-images/<id>.<ext>` に手動配置）。DLsite/
hitomi 等の第三者画像は同梱しない方針は不変。`imageApproved !== true` の
間は画像自体は表示しつつ「承認前」バッジを固定位置（右上）に重ねる。
画像未設定でも枠は常に表示する。

### 現時点でUIに出していないもの（2026-07-20時点、暫定）

DLsite外部リンクボタン・供給量メーター・年齢確認モーダルは、ユーザー指示で
UI表示から外した。**エンジン・データ層の対応する機能（供給量によるハード
フィルタ/タイブレーク、`dlsiteQuery`）自体は変更していない**。今回のUIは
暫定で、今後統合する別UIに合わせて作り直す前提。

## ベイズ推薦エンジン試作（`?engine=bayes`、併存・実験中）

16軸の手動キュレーションだけに頼らず、Danbooruタグ共起（クラウドの集合知）から
機械的に尤度を構築する試作エンジン。既定の URL（上記の一式）は無改造のまま、
`?engine=bayes` を付けたときだけ以下の並行経路に分岐する（`src/App.tsx` が
mount時に1回だけ読み、router は使わない）。

- `data/bayes/questions.json`（手書き正本、Danbooruタグ文字列とプロンプトを保持）
  → `scripts/bayes/build-likelihoods.mjs`（決定論・通信なし）が
  `data/bayes/likelihoods.json`（キャラ×質問の確率密行列。数値のみ）と
  `data/bayes/questions.runtime.json`（日本語プロンプトのみ）を生成する。
  実行時keyは意図的に questions.json の id（Danbooruタグ名を含む）とは別の
  不透明な連番 `q001`,`q002`,… にしてあり、`dist/` にタグ語彙が混入しない
  （`tests/bayes-data.test.ts` が回帰を防ぐ）。
- `src/engine/bayes.ts`: 事前分布 `π(c) ∝ log2(2+galleryCount+30·pageCount)`
  から出発し、回答ごとに対数事後確率を更新（ベイズ推定）。質問選択は期待
  エントロピー削減の貪欲最大化。`recommend.ts` の `survivors`・
  `combinedRankFor`・`pickGuessWithCooldown`・`Scored`/`Reason` 型は無改造で
  再利用する（score=200·P(c) が MARGIN_STOP=40 に対応するよう換算）。
- `src/hooks/useBayesInterview.ts` は `useInterview.ts` の reducer をそのまま
  ミラーし、質問選択・スコアリング・停止判定の3関数だけ差し替えた別フック。
  `QuestionScreen`/`GuessScreen`/`ResultScreen`/`NoGuessScreen` は完全に共用・
  無改造。`SessionLogRecord.engine`（`'classic' | 'bayes'`、省略時classic扱い）
  でどちらのセッションかを記録する。
- データ源: Danbooru投稿タグ（`scripts/bayes/sample-posts.mjs` が
  `state/bayes-pipeline/danbooru/<id>.json` にキャッシュ、gitignore対象）+
  既存16軸データ（尤度データが薄い/無い質問のフォールバック）+ Wikidata構造化
  事実（P5a）+ ニコニコ大百科+ローカルLLM抽出（P5b）の4ソースを
  `mergeLikelihoods`（logit空間の信頼度加重平均）でマージする。
- **P5a（Wikidata）**: `scripts/bayes/wikidata-client.mjs`/`map-wikidata.mjs` が
  キャラ→QIDを検索・検証し、`data/bayes/wikidata-facts.json`
  （性別・髪色・目の色・種族=人間の確認、制御語彙のみ）を生成。
  `estimateWikidataLikelihood`（`estimators.mjs`）が尤度化。全131キャラで実行済み
  （131キャラ中107キャラ=82%が何らかのfactsを取得。自動検索の同名衝突
  ——艦これ/アズールレーンの艦娘と実在の艦船、FGOの史実サーヴァントと
  実在の歴史上人物等——は`data/bayes/wikidata-overrides.json`で個別検証の上
  QIDを確定/除外している）。
- **P5b（ニコニコ大百科+ローカルLLM抽出）**: 「客観的・タグ化しやすい」外見系を
  Danbooru/Wikidataで、「主観的・タグ化しにくい」性格/雰囲気系
  （personality/mood/species/combat/distance/affiliationKind/roles、axis-only
  38問）をこちらで補う。`scripts/bayes/niconico-client.mjs`/`map-niconico.mjs`
  が記事本文を取得・検証し（Pixivはロボッツ排除規則がAIクローラーを名指しで
  ブロックしているため対象外——ニコニコ大百科を代替に採用）、
  `scripts/bayes/ollama-client.mjs`/`llm-extract.mjs`
  がローカルLLM（Ornith-9B `hf.co/huihui-ai/Huihui-Ornith-1.0-9B-abliterated-
  MTP-GGUF:Q4_K_M`、Ollama経由）でevidence-first抽出（quoteを先に
  逐語で書かせ、valueをそのquoteだけから判定させる）+ 引用照合ゲート
  （LLMの引用が原文に実在するかを決定論的に照合、幻覚引用は再プロンプト後も
  不採用ならnull寄与）を行い、`data/bayes/llm-extract.json`
  （制御語彙のみ・引用文自体は持たない）を生成する。生記事テキスト・生プロンプト・
  引用照合の全証跡は `state/bayes-pipeline/{niconico,llm}/` にのみキャッシュ
  （gitignore、コミットツリーにファンサイトのプロースを持ち込まない）。
  131キャラ中117キャラ=89%が記事取得・LLM抽出済み（`scripts/bayes/
  bench-llm-models.mjs`で複数のローカルLLM（9B〜35B級）を比較した結果、
  このevidence-first逐語引用タスクではパラメータ数の大きいモデルほど
  指示追従性が崩れて悪化する傾向が判明し、9B級のOrnith-9Bを採用——詳細は
  `--model`フラグで比較実行可能）。
  `llm-extract.mjs` は `--force` なしで実行すると未処理分だけ再開する設計。

## テスト・ゲート

| コマンド | 内容 |
|---|---|
| `npm test`（`vitest run`） | `tests/data.test.ts`（A系、データ品質）+ `tests/engine.test.ts`（C系、エンジン契約）+ 収集スクリプトのユニットテスト + `tests/bayes-*.test.ts`（BA/BB/BC/BD系、ベイズ試作の並行ゲート） |
| `npm run lint` | ESLint（no-emoji / トークン強制 / 禁止語 / jsx-a11y）+ Stylelint + `tsc --noEmit` |
| `scripts/ui-check.sh` | `npm run build` → `scripts/dist-scan.mjs dist`（D2） → `npx playwright test`（D1・F系） |

`tests/engine.test.ts` は実データ（`data/characters.json`）に対して
「真実に沿った回答（オラクル）を与えると自分自身に収束するか」を全生存
キャラ分シミュレートする C13 を含む。エンジンの挙動を変えたら、まずここが
green であることを確認する。

## ディレクトリ構成（抜粋）

```
src/
  data/schema.ts          型 + zod スキーマ
  engine/
    supply.ts              供給量ランク
    questions.ts            プローブ生成・エントロピー選択
    recommend.ts            スコアリング・推測ループ
  hooks/useInterview.ts     状態管理（reducer）
  screens/                  画面（phaseごと）
  components/               画面間で共有する部品
data/
  characters.json           キャラ台帳（人手キュレーション）
  supply.json               供給量の生データ（収集スクリプトが書く）
scripts/
  collect.mjs               DLsite収集
  collect-hitomi.mjs        hitomi.la収集
  census-hitomi.mjs         シリーズ内キャラの機械列挙
  dist-scan.mjs             ビルド成果物の走査（D2）
tests/                      Vitest（データ・エンジン）
e2e/                        Playwright（UI・D1）
public/character-images/    ユーザー手動配置の画像置き場
```
