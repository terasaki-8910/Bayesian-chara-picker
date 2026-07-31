# Windows引き継ぎ: LLM抽出の再実行と、査読を100体規模まで進める作業

2026-07-25作成 / **2026-08-01 全面更新**（Mac上のClaude Codeセッション）。
Windows機（RTX5070Ti搭載想定）のClaude Codeが、事前の会話文脈を持たない状態から
着手するための引き継ぎ資料。

## 最初に読むもの

1. `CLAUDE.md`（プロジェクトルート） — このプロジェクト全体のルール・言語方針・
   Gitポリシー。**必ず先に読むこと。** 特に「キャラを追加するとき」の手順。
2. `docs/ARCHITECTURE.md` の「ベイズ推薦エンジン試作」節 — 設計の全体像。
3. このファイル — 今回引き継ぐ作業の詳細。

## 現在の状態（2026-08-01時点）

- キャラは **184体**。ベイズ推薦エンジン試作（`?engine=bayes`）は4つの尤度ソース
  （Danbooruタグ共起・手動キュレーション18軸・Wikidata構造化事実・ニコニコ大百科+
  ローカルLLM抽出）をマージする。
- **重要: 到達可能キャラが20体しかない。** `survivors()` が `reviewed === true` を
  ハードフィルタするようになった（2026-08-01、コミット45cb10e）。184体中162体が
  未査読（`reviewed: false`）なので、実際に推薦に出るのは22体（うち供給条件を
  満たす20体）だけ。**これを100体規模まで増やすのが本引き継ぎの主目的。**
  - なぜこうしたか: 査読前データの品質のばらつきが、ベイズの偏りゲート(BD)で
    χ²=319.1（閾値300、期待値から約7σ）という統計的に無視できない偏りとして
    表面化したため。閾値を緩めるのではなく母集団側を正した。
- **軸が16→18に増えた**（2026-08-01）。`stature`（小柄/標準/長身）と
  `occupation`（忍者/海賊/兵士・軍人/…14値・複数値）を新設。bayes質問も
  107→131問に増えた。
- `data/bayes/llm-extract.json`: **旧16軸の時点で全131体ぶん抽出済みだが、
  新設2軸（stature/occupation）と、今回質問を追加した ageFeel/build の
  データを持っていない。** → 下記タスク1で再抽出が要る。
- `data/bayes/wikidata-facts.json`: 184体ぶん取得済み。stature は Wikidata の
  P2048（身長）から39体ぶん自動で入っている。
- `data/bayes/niconico-map.json`: 記事の取得・検証済み。

## 引き継ぐタスク

### タスク1: 新軸込みでLLM抽出を全体再実行

`LLM_AXIS_KEYS` に ageFeel/build/stature/occupation が加わったので、既存の
抽出結果は古い。`--force` を付けて全件やり直す（これは意図的な全件再実行）。

```bash
# 前提: Ollama と抽出用モデル。Mac側では qwen3:8b で検証したが、
# Windows機のGPUに余裕があるならより大きいモデルの方が精度は上がる
# （scripts/bayes/llm-extract.mjs の MODEL 定数、または --model で指定）。
ollama pull qwen3:8b

# 全件再抽出（新軸を含める。--force が必要）
node scripts/bayes/llm-extract.mjs --force

# 尤度を再ビルド
node scripts/bayes/build-likelihoods.mjs

# 必須ゲート（落ちたら軽々にコミットしない。レバーは
# scripts/bayes/estimators.mjs の LLM_MERGE_WEIGHT(=15) / confidence厳格化 /
# data/bayes/niconico-overrides.json での除外強化）
npx vitest run tests/bayes-engine.test.ts tests/bayes-bias.test.ts
npm run lint && npx vitest run
```

実行後は末尾の **引用照合ゲート通過率** を必ず見ること。Mac側の実測では主要
キャラで50%前後だった。極端に悪化していたら
`state/bayes-pipeline/llm/<id>.json` の `verification` 配列で原因を調べる。

### タスク2: 査読を100体規模まで進める（本命）

`reviewed: true` を立てるのは **人間の判断が必要な作業**で、機械が確定させて
よい領域ではない（ACCEPTANCE §G。`scripts/bayes/review-hints.mjs` の冒頭
コメントにも明記されている）。ただし判断材料は機械で用意できる:

```bash
# 未査読キャラについて「Danbooru実測タグ・Wikidata facts・LLM抽出結果」と
# 現在の下書きaxesを突き合わせ、agree/conflict/no-evidence に分類したレポートを出す。
# characters.json には一切書き込まない。
node scripts/bayes/review-hints.mjs

# 出力: state/bayes-review/review-hints.{json,md}（gitignore。conflict件数の降順）
# 単体で見たいときは --char <id>
```

conflict が多い軸から順に人間が確認し、`data/characters.json` の axes を直して
`reviewed: true` に変える、という流れ。**新設2軸（stature/occupation）も
査読対象**——特に occupation は査読済み22体のうち15体しか埋まっておらず、
判断が割れた7体（fgo-kiyohime, fgo-medusa, dragonball-18, monmusu-miia,
monmusu-centorea, kanokari-chizuru, fate-astolfo）は意図的に空のまま残してある。

**査読を進めるたびに必ずやること**: 到達可能キャラ数が変わると偏りゲートの
分布も変わる。`tests/engine-bias.test.ts` と `tests/bayes-bias.test.ts` の
閾値（`CHI_SQUARE_MAX` / `MAX_SHARE`）は reachable=20 を前提に実測から
導出した値なので、母集団が大きく変わったら再導出すること。手順は両ファイルの
2026-08-01コメントに書いてある（`state/{engine,bayes}-review/bias-sweep.mts` を
複数シードで走らせて実測上限を取り、3〜4割の余裕を持たせる）。

`llm-extract.mjs` は逐次保存・再開可能な設計（1キャラ処理するごとに
`data/bayes/llm-extract.json` と `state/bayes-pipeline/llm/<id>.json` へ書き込む）。
途中で止めても再実行すれば未処理分だけ続きから進む。`--char <id>` で単体だけ
強制再実行することもできる。

コミットは既存の先例（`71340bf` / `81ee661` / `79e1b0c`）と同じ粒度で、
カバレッジの数字を明記すること。

## サイトへの同期について（重要な判断ポイント）

`docs/handoff-portfolio-site-sync.md` の通り、`src/engine/*` `src/data/schema.ts`
`src/hooks/useBayesInterview.ts` と `data/` の4ファイルは
terasaki-8910.github.io（`/chara-picker/`）へ同期される。

2026-08-01の変更（`survivors()` の reviewed ハードフィルタ）を同期すると、
**サイト側の母集団も20体に縮む**。査読が進んでから、エンジンとデータを
まとめて同期するのが安全。同期のタイミングはユーザーの判断事項なので、
勝手に同期せず必ず確認すること。

なお `map-wikidata.mjs` に `--from-cache` を追加した（2026-08-01）。
色QIDの対応表や stature のしきい値のような「手書きの写像規則」を変えたときは、
184体を再取得せずキャッシュ済みの生エンティティから facts だけ作り直せる:

```bash
node scripts/bayes/map-wikidata.mjs --from-cache
```

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
