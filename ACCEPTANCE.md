# ACCEPTANCE — random-chara-picker

各項目は pass/fail が機械判定可能。判定手段を必ず併記する。
LLM の主観レビューは受け入れ基準に含めない。

## A. データ品質

| # | 基準 | 判定 |
|---|---|---|
| A1 | `data/characters.json` の全レコードがスキーマ検証を通る（zod） | Vitest |
| A2 | `reviewed: false` のレコードが 0 件（`provisional: true` は対象外） | Vitest |
| A3 | `id` が一意 | Vitest |
| A4 | 全レコードに必須 8 軸（性別表現・年齢感・体格・胸・性格・髪色・戦うか・所属の種類）が埋まっている | Vitest |
| A5 | 全軸の値が §SPEC 2.3 の許容値リストに含まれる（typo・独自値を弾く） | Vitest |
| A6 | `dlsiteQuery` が `null` でないレコードは `data/supply.json` に対応エントリを持つ | Vitest |
| A7 | 出荷データに供給量ランク「なし」のキャラが 0 件（DLsite と hitomi.la の高い方で判定） | Vitest |
| A8 | `supply.json` の全エントリが `fetchedAt` を持ち、ISO 8601 として解釈可能 | Vitest |
| A9 | 全軸の値が NFC 正規化されている（濁点カナの NFC/NFD 混入を弾く） | Vitest |
| A10 | 性別表現「男性」のレコードが既存 2 件から増えていない（SPEC 3 のラチェット） | Vitest |
| A11 | 各キャラが任意軸のうち 4 つ以上埋まっている（薄いレコードで数だけ増やす歯止め） | Vitest |
| A12 | `provisional: true` と `reviewed: true` が同時に成立しない（A2 の抜け道防止） | Vitest |
| A13 | `imagePath` が `null` でないレコードは、対応するファイルが `public/character-images/` に実在する | Vitest（fs 存在確認） |
| A14 | `imageApproved: true` は `imagePath !== null` のときのみ成立する | Vitest（zod の `refine` と二重化） |

## B. 収集スクリプトの規約遵守

| # | 基準 | 判定 |
|---|---|---|
| B1 | URL ビルダーが生成する全 URL が `/page/1/` で終わる（2 ページ目以降を作れない） | Vitest（純関数テスト） |
| B2 | 生成 URL が robots.txt の Disallow パターンに 1 件も一致しない | Vitest（パターン表を固定して検証） |
| B3 | 連続リクエストの間隔が 10 秒以上（モック時計で検証） | Vitest（fake timers） |
| B4 | User-Agent ヘッダが空でなく、連絡用文字列を含む | Vitest |
| B5 | 件数パーサが「最後へ」リンクから `pageCount` を正しく取り出す | Vitest（保存済み HTML フィクスチャ） |
| B6 | 作品 ID の計数が `search_result_list` の内側に限定される（推薦枠を数えない） | Vitest（72 件混入フィクスチャで 30 を返すこと） |
| B7 | 0 件ページと 1 ページ収まりを取り違えない | Vitest（両フィクスチャ） |

## C. 推薦エンジン

プローブ方式・5 段階確信度・単一推測への収束（SPEC 2.4）を対象とする。
旧「軸の値を 1 つ選ぶ・常に上位 3〜5 体を返す」契約（C1〜C11）は本表で
置き換えた。

| # | 基準 | 判定 |
|---|---|---|
| C1 | 固定の回答列に対し `topGuess(scoreCharacters(...))` が決定論的な単一キャラを返す | Vitest（スナップショット） |
| C2 | 推測・確定・おまかせのいずれで返るキャラも供給量ランクが「なし」でない | Vitest |
| C3 | 無作為に生成した 1000 通りの回答パスで、`scoreCharacters` の結果が 1 件も空配列にならない | Vitest（乱数シード固定） |
| C4 | 全問「わからない」で回答した場合も `scoreCharacters` の結果が空にならない | Vitest |
| C5 | 一致した特性が 1 つ以上あるとき、推測・確定結果にその根拠が付く | Vitest |
| C6 | 「おまかせ」がシード固定時に再現可能な単一結果を返す | Vitest |
| C7 | 性別表現「男性」または `provisional: true` のキャラが推測にも「おまかせ」にも出ない | Vitest |
| C8 | `nextProbe` が `askedKeys` に無いプローブから選ばれ、同じプローブを 2 回聞かない | Vitest |
| C9 | 候補が 1 つの値に偏ったプローブより、二分できるプローブが優先して選ばれる | Vitest（合成データで情報量の大小を固定して検証） |
| C10 | `selectProbe` は `rng` 省略時は決定論的（同じ集団・同じ `askedKeys` なら同じプローブを返す）。`rng` 指定時は僅差の上位候補（`TOP_K_RANDOM`件）から乱択し、同じ `rng` シードなら再現可能 | Vitest |
| C11 | 属性が全て空欄のキャラが混ざっていても質問選択・スコアリングが落ちず、空欄は確信度に関わらずスコアに寄与しない | Vitest（供給先行で投入したキャラを模した合成データ。3 値式の空欄=0 を検証） |
| C12 | `askedCount < MIN_QUESTIONS(6)` の間 `shouldGuess` は常に `false`。「いいえ」で拒否したキャラは以降の `scoreCharacters`/`nextProbe` から除外される | Vitest |
| C13 | 実データの生存者全員について、真実に沿った回答（オラクル）を与えると `MIN_QUESTIONS`〜`HARD_CAP` 問の範囲内で自分自身に収束する。全問「わからない」の場合は `HARD_CAP(10)` で強制的に推測へ進む | Vitest（実データ `data/characters.json` を使用） |

## D. 実行時の閉じ込め

| # | 基準 | 判定 |
|---|---|---|
| D1 | アプリ起動〜結果表示まで、外部ホストへのネットワークリクエストが 0 件 | Playwright（`page.on('request')` を集計） |
| D2 | ビルド成果物に DLsite の HTML / 画像 / 作品タイトルが含まれない | Vitest（`dist/` の文字列走査） |

## E. Lint（`npm run lint` が exit 0）

| # | 基準 | 判定 |
|---|---|---|
| E1 | `src/` に絵文字が 1 文字も無い | ESLint カスタム規則 |
| E2 | トークン定義ファイル以外に hex / rgb() / hsl() のリテラルが無い | ESLint + Stylelint |
| E3 | `eslint-plugin-jsx-a11y` の recommended がエラー 0 | ESLint |
| E4 | UI コピーおよびソースに禁止語リストの語が出現しない | ESLint カスタム規則（語リストは設定ファイルに外出し） |
| E5 | TypeScript の型エラー 0（`tsc --noEmit`） | tsc |

## F. UI（`scripts/ui-check.sh` が exit 0）

F4（モーダルの Escape/背景クリック）と F5（年齢確認ゲート）は 2026-07-20 に
年齢確認そのものを廃止したため対象が無くなり削除した（欠番。番号は振り直さない
— PLAN.md の「wave 2 から削除」の前例と同じ扱い）。

| # | 基準 | 判定 |
|---|---|---|
| F1 | 375 / 768 / 1280 px で `document.body` に横スクロールが発生しない | Playwright |
| F2 | axe-core の violations（impact: serious 以上）が 0 件 | Playwright + axe |
| F3 | 全対話要素に Tab のみで到達できる（マウス不要で完走可能） | Playwright（キーボードのみで質問 → 推測 → 確認まで操作） |
| F6 | 色以外の手段でも状態が判別できる（focus リングが可視） | Playwright（`:focus-visible` のアウトライン幅 > 0） |

## G. 完了の定義

上記 A〜F が全て green、かつ SPEC §6 の段階 1（30 体貫通）が実データで
成立していること。ここまでは機械判定。

人間のゲートは 2 点のみ:
- 属性値の妥当性レビュー（`reviewed` フラグを立てる行為そのもの）
- デザイン方向の一度きりの承認
