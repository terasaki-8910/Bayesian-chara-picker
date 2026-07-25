# Windows引き継ぎ: P5b（ニコニコ大百科+ローカルLLM抽出）の続き

2026-07-25、Mac上のClaude Codeセッションで作成。Windows機（RTX5070Ti搭載想定）の
Claude Codeが、事前の会話文脈を持たない状態からこの続きに着手するための引き継ぎ資料。

## 最初に読むもの

1. `CLAUDE.md`（プロジェクトルート） — このプロジェクト全体のルール・言語方針・
   Gitポリシー。**必ず先に読むこと。**
2. `docs/ARCHITECTURE.md` の「ベイズ推薦エンジン試作」節 — P0〜P5bまでの設計の
   全体像。
3. このファイル — 今回引き継ぐ作業の詳細。

## 現在の状態（このコミットの時点）

- ベイズ推薦エンジン試作（`?engine=bayes`）は4つの尤度ソース
  （Danbooruタグ共起・16軸手動キュレーション・Wikidata構造化事実・ニコニコ大百科+
  ローカルLLM抽出）をマージする設計まで完成し、パイプライン一式（クライアント/
  マッピングスクリプト/テスト）は実装・テスト済み。
- `data/bayes/niconico-map.json`: 131キャラ中107体で記事を取得・検証済み
  （残り24体は記事が存在しない、またはシリーズ名/本人名を本文で確認できず
  安全側で除外——`data/bayes/niconico-overrides.json` に手書きで上書きできる）。
- `data/bayes/llm-extract.json`: 記事のある107体のうち **45体のみ** LLM抽出まで
  実行済み。**残り62体が未処理のまま。** ローカルLLM実行はMac側では1キャラあたり
  20秒〜2分程度かかり、かつ機械への負荷が大きいため、45体で一旦区切って
  安全性検証（後述）だけ済ませた状態でコミットしている。
- 安全性検証（BC13: オラクル自己収束95%以上、BD: 事前分布からの偏りゲート）は
  この45体の部分カバレッジの状態で両方通過済み。

## 引き継ぐ具体的なタスク

**残り62体分のLLM抽出を進める。** これが唯一の、既に設計・実装済みの
「すぐ実行できる」タスク。手順:

```bash
# 1. 前提: Ollamaをインストールし、qwen3:8bをpullする
#    (Windowsネイティブ版・WSL2版どちらでも良いが、下記の理由でWSL2を推奨)
ollama pull qwen3:8b

# 2. 未処理分だけを対象に抽出を実行する（--forceを付けないこと。
#    付けると全131キャラを再実行してしまい、既存45体分も上書きされる
#    ——決定論的な抽出なので上書き自体は無害だが、時間の無駄）
node scripts/bayes/llm-extract.mjs

# 3. 実行後、尤度を再ビルド
node scripts/bayes/build-likelihoods.mjs

# 4. 必須ゲートを再検証（どちらかが壊れたら軽々にコミットしない。
#    レバーは scripts/bayes/estimators.mjs の LLM_MERGE_WEIGHT(=15)/
#    confidence厳格化/data/bayes/niconico-overrides.jsonでの除外強化等）
npx vitest run tests/bayes-engine.test.ts tests/bayes-bias.test.ts

# 5. 全体のlint/テストを最終確認
npm run lint
npx vitest run
```

`llm-extract.mjs` は逐次保存・再開可能な設計（1キャラ処理するごとに
`data/bayes/llm-extract.json` と `state/bayes-pipeline/llm/<id>.json` へ書き込む）。
途中で止めても再実行すれば未処理分だけ続きから進む。`--char <id>` で単体だけ
強制再実行することもできる。

実行後は `引用照合ゲート通過率` のログをコンソール末尾で確認すること
（Mac側では主要キャラで50%前後だった。極端に悪化していたら
`state/bayes-pipeline/llm/<id>.json` の `verification` 配列を見て原因を調査する
——下記「このセッションで見つかった問題」も参照）。

完了したら、P5aの先例（コミット `71340bf`）・P5bの先例（コミット
`81ee661` — このファイルの直前のコミット）と同じ粒度でコミットする
（コミットメッセージにカバレッジの数字を明記）。

## 絶対に守ること: Pixivのスクレイピングは一切行わない

このプロジェクトでは、ファンサイトからのデータ収集先として **Pixiv
（`www.pixiv.net`・`dic.pixiv.net`百科事典）を明示的に除外している。**
Pixivのrobots.txtは`ClaudeBot`/`anthropic-ai`/`GPTBot`等のAIクローラーを
名指しで`Disallow: /`にしている（`User-agent: *`は`Allow`）——検索エンジン向けの
一般的な除外規則ではなく、AIクローラーを狙い撃ちした明示的なopt-outだと
Mac側セッションで確認済み。偽装User-Agentを含め、技術的手段を問わず
Pixivのスクレイピングは行わない。この方針は「後で強力なマシンが手に入ったから」
という理由で緩めるものではない。代替として採用したニコニコ大百科
（`dic.nicovideo.jp`）は、robots.txtにAIクローラー個別ブロックが無く
`Crawl-delay: 5`のみ順守すればよいことを確認済み
（`scripts/bayes/niconico-client.mjs`の`REQUEST_DELAY_MS=5000`はこれに対応）。

「本番規模の常時クロール」という構想が元のプランの「スコープ外」節に
言及されているが、**これはまだ具体的な設計が存在しない未着手の構想**であり、
このマシンの計算資源が強力だからといって、対象サイトを増やしたり
Pixivを含めたりする判断を勝手に行わないこと。スコープを広げたい場合は
先にプラン（Plan Mode）を通し、対象サイトごとのrobots.txt確認を都度行う。

## Windows特有の注意点

- **改行コード**: `.gitattributes`で`* text=auto eol=lf`を設定済み。
  Windows側でチェックアウトしてもLFのまま保たれるはずだが、
  `core.autocrlf=true`等のグローバル設定を明示的に上書きしている環境では
  念のため `git status` で意図しない大量差分が出ていないか確認すること。
- **文字コード**: 全ファイルUTF-8（BOM無し）。日本語コメント・文字列を大量に含む
  ため、エディタ側の既定エンコーディングがUTF-8になっていることを確認する
  （`.editorconfig`で`charset = utf-8`を明示済み）。
- **パス処理**: `scripts/bayes/*.mjs`はいずれも`node:path`の`join`や
  `new URL(..., import.meta.url)`/`fileURLToPath`のみでパスを組み立てており、
  POSIX固定のパス区切り文字をハードコードしている箇所は無い（Mac側で意図的に
  そう書いた）。ネイティブWindows・WSL2のどちらでも動くはずだが、未検証なので
  最初の実行時に確認すること。
- **シェルスクリプト**: `scripts/`配下の`.sh`ファイル（`collect-*.sh`等、今回の
  タスクでは使わない）はbash前提。使う場合はWSL2かGit Bashが必要。
  今回引き継ぐ`llm-extract.mjs`自体は純粋なNode.jsスクリプトなので、
  ネイティブWindows PowerShell/cmd.exeからでも`node scripts/bayes/llm-extract.mjs`
  だけで動くはず。ただし`npm run lint`/`npm test`等npm scripts全体を回すなら
  WSL2の方が挙動が安定する。

## このセッションで見つかった問題と対処（同じ罠を踏まないために）

Mac側での実地検証中に、机上では気づけなかった3つの実データ問題を発見・修正済み。
残り62体の処理でも同じパターンが再発する可能性があるので、もし異常な除外/
低品質な抽出を見つけたら、まずこの3つが再発していないか疑うこと。

1. **同名クラス/概念ページへの誤対応**: Fateのサーヴァントクラス名
   （「ランサー」「キャスター」等）がキャラのaliasesに含まれており、
   ニコニコ大百科ではそれ自体が実在の記事（クラス概念の解説記事）を持つため、
   シリーズ名だけの照合では誤って採用してしまっていた。
   `scripts/bayes/map-niconico.mjs`の`contentVerified`が、シリーズ名に加えて
   キャラ本人の名前も本文に出現するかを要求するよう修正済み。
2. **表記ゆれリダイレクトの未追跡**: ニコニコ大百科は表記ゆれ
   （例:「スカサハ」→正式には「スカアハ」）をHTTP 200 + JS/meta-refreshの
   空スタブページで転送する。`fetch`はHTTPレベルの3xxしか自動追跡しないため、
   これを取りこぼすとほぼ空の記事として扱ってしまう。
   `scripts/bayes/niconico-client.mjs`の`fetchArticleHtml`が自動追跡するよう
   修正済み。
3. **コメント欄とインラインタグ除去のノイズ**: ニコニコ大百科の記事は末尾に
   コメント欄（記事全体の3〜9割を占めることがある雑談・実況スラング）を持ち、
   これがLLMの引用照合品質を大きく悪化させていた。また`<a>`等のインライン
   タグを除去する際にスペースへ置換していたため、リンク化された語の前後に
   余計な空白が入り（例:「あーうー」が「 あーうー 」になる）、LLMが返す
   装飾無しの引用と本文側の照合基準がズレて偽陰性になっていた。
   `scripts/bayes/niconico-client.mjs`の`htmlToText`で、コメント欄
   （`ななしのよっしん`という固定表示名以降を切り捨て）とインライン要素
   （空文字へ置換）の両方を修正済み。

残存する既知の限界（対処済みだが完全解決ではない）:
**「本文に実在する引用だが、判定した属性値とは無関係」というケース**は
引用照合ゲートでは検出できない（例: 印象的な台詞を引用しつつ、それとは
無関係な軸の根拠として流用する）。多層防御で対処——(a)
`confidence:'high'`のみ採用、(b) `W_LLM=15`が16軸(30)より弱いため誤りが
混入しても確信を反転できず減衰に留まる、(c) BC13の自己収束チェックが
最終防衛線。抽出量を増やした後も必ずBC13/BDを再実行すること。

## 困ったときの参照先

- QID/記事タイトルの誤対応を手で直したい: `data/bayes/wikidata-overrides.json`
  （P5a）/ `data/bayes/niconico-overrides.json`（P5b）に `{ "id": { "title":
  "正しいタイトル" } }` または `{ "title": null, "reason": "..." }` を追記して
  `--force --char <id>` で単体再実行。
- 尤度マージの重み・しきい値: `scripts/bayes/estimators.mjs` 冒頭の定数群
  （`AXIS_MERGE_WEIGHT`/`WIKIDATA_MERGE_WEIGHT`/`LLM_MERGE_WEIGHT`等）。
- Ollamaの応答形式・スキーマ: `scripts/bayes/ollama-client.mjs`
  （`/api/chat` + `think:false` + JSON Schema形式の`format`）。
- evidence-first抽出の全体設計・引用照合ゲートの詳細: `scripts/bayes/
  llm-extract.mjs` 冒頭のコメントと各関数のJSDoc。
