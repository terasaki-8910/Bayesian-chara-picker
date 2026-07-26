# intake提案: ベイズ推薦エンジン（`?engine=bayes`）の本採用について

2026-07-26作成。CLAUDE.mdのWorkflow（ゲート付きintake）に従い、SPEC改訂の可否を
判断するための材料として作成。**この文書自体はSPEC/PLAN/ACCEPTANCEを変更しない**
——提案のみ。

## 結論（先に書く）: 現時点での本採用は推奨しない

`tests/bayes-headtohead.test.ts`（`RUN_HEAD_TO_HEAD=1 npx vitest run
tests/bayes-headtohead.test.ts`で再現可能。通常ゲート対象外）で、classicと
bayesの両エンジンに**同一の独立オラクル**（`characters.json`の実データそのもの
——classicのC13オラクルと同じ発想。bayes側もこのために新設）を与えて自己収束率を
測定した結果:

| エンジン | 収束率 | 平均質問数 |
|---|---|---|
| classic | **128/128 (100.0%)** | 7.27問（範囲6-10） |
| bayes | **44/128 (34.4%)** | 10.88問（範囲6-12、上限張り付き多数） |

bayes側が独立オラクルで収束できなかったのは84体。classicが失敗した体は0件。

### なぜこの数字は既存のBC13（95%以上）と食い違うのか

既存の`tests/bayes-engine.test.ts`のBC13は、オラクルを`data/bayes/
likelihoods.json`**自身**から生成している（p≥0.75→yes等）。これは「推薦が
実データと一致するか」ではなく「マージ済み尤度行列に対して自己整合的か」しか
測れない**自己参照テスト**である（この点はExplore調査でも指摘済み）。

実際に`characters.json`の査読済み/下書きaxes（＝人間が意図した「正解」）を
オラクルにすると収束率が34.4%まで落ちる、という今回の実測が示すのは:
Danbooru/Wikidata/LLM由来の尤度が、16軸の意図した値と食い違うケースが
実データ上かなりの割合で存在するということ。P5a/P5bのカバレッジがまだ
131キャラ中107〜117（82-89%）に留まっていることに加え、37問がLLM抽出頼みの
axis+llm型質問である（Explore調査より）ことも一因と考えられる。

## 判断材料チェックリスト（Explore調査、2026-07-26実施）

### A. ドキュメント/プロセス（SPEC改訂が必要になった場合の前提整備）
- [ ] SPEC.mdの「スコープOUT: 本物のベイズ推定エンジン」（L259-260）は現状
      維持を推奨（下記の実測を踏まえると、現時点で撤回する根拠が無い）
- [ ] PLAN.mdにベイズ関連の記述が一切無い（ARCHITECTURE/コード/テストが
      参照する「PLAN『P5a』」「PLAN『BD系』」等の参照先が消失している）。
      本採用するしないに関わらず、ドキュメントの整合性としてPLAN.mdへの
      復元は別途検討の価値あり
- [ ] `HARD_CAP_BAYES=12`はSPEC§2.4の「絶対上限10問」と矛盾。今回の実測でも
      bayesは平均10.88問（範囲上限12に張り付くケース多数）で、classicの
      平均7.27問より明確に長い——精度と質問数の両面でclassicに劣る

### B. 精度（今回の実測で判明）
- [x] ~~ヘッドツーヘッド比較ハーネスが無い~~ → `tests/bayes-headtohead.test.ts`
      として新設済み（今後の再測定に再利用可）
- [x] ~~BC13が自己参照的~~ → 今回の実測で独立オラクルとの乖離を定量化
- [ ] bayesのみ未収束84体の傾向を見ると、Wikidata/LLM未カバー（P5b残り14/131・
      P5a残り24/131）のキャラだけでなく、**カバー済みキャラでも食い違うケース**
      が多数含まれる（例: touhou-reimu, kancolle-kaga等、本セッションで
      review-hints.mjsが実際にconflictを検出した面々と重なる）。P5a/P5b自体の
      精度向上が本採用の前提条件になりそう

### C. テストゲート・運用（Exploreの元チェックリストのうち未着手のもの）
- [ ] BD偏りゲートに classic の MAX_SHARE(0.025) 相当が無い
- [ ] C9/C11/C12相当のbayes版が無い
- [ ] e2e F1/F2/F3/F6（レスポンシブ/axe/キーボード/focus）がbayesプロンプト
      (107問・文言長が異なる)に対して未実行
- [ ] `useInterview.ts`/`useBayesInterview.ts`のreducer完全重複、
      `App.tsx`の`ClassicFlow`/`BayesFlow`重複、`probe as unknown as Probe`の
      二重キャストが未解消
- [ ] `likelihoods.json`再生成がDanbooru/Wikidata/ニコニコ/ローカルLLM依存で
      CI外・特定マシン依存のまま

## 推奨する次のステップ（本採用を目指す場合）

1. P5a/P5bのカバレッジを131キャラ全件に近づける（現在107-117/131）
2. `LLM_MERGE_WEIGHT`等の重み・confidence閾値を、独立オラクルでの収束率を
   指標にチューニングする（本ハーネスをそのまま評価関数として使える）
3. 収束率が実用的な水準（classicに近い、少なくとも80%以上等）に達してから、
   改めてSPEC改訂のintakeを起票する
4. それまでは`?engine=bayes`は現状通り「併存・実験中」の位置づけを維持する

## 再現方法

```bash
node scripts/bayes/build-likelihoods.mjs   # 最新データで尤度を再ビルド
RUN_HEAD_TO_HEAD=1 npx vitest run tests/bayes-headtohead.test.ts --reporter=verbose
```
