# PLAN — random-chara-picker

SPEC.md / ACCEPTANCE.md の分解。**各フィーチャは main から分岐した独立 worktree
で実装される**ため、同じ wave のフィーチャは互いのファイルに触れてはならない。

criteria stage が書いた失敗テストが実装の契約そのものである。本 PLAN は
そのテストが要求する**モジュールパスと公開シンボル**を固定し、並行 worktree が
互いに矛盾する API を作るのを防ぐことを目的とする。

## 依存グラフ

```
wave 1  data-schema      engine-supply      collect-script
           |                  |    |             |
           |                  |    +-------------+
           v                  v                  v
wave 2  engine-questions   character-dataset (collect 実行を含む)
           |                  |
           +--------+---------+
                    v
wave 3         engine-recommend
                    |
        +-----------+-----------+
        v           v           v
wave 4  ui-age-gate ui-interview ui-results
        +-----------+-----------+
                    v
wave 5           app-shell
```

`scripts/dist-scan.mjs`（D2 の走査器）は criteria stage で実装済み・main にあり、
`tests/dist-scan.test.ts` は既に green。フィーチャとして起こさない。

---

## wave 1（依存なし。これが今回の `state/features.txt`）

### 1. `data-schema` — `src/data/schema.ts`

zod によるデータスキーマと型。`tests/data.test.ts` と `tests/engine.test.ts` が
この 1 ファイルから型と検証器を取る。

公開シンボル（テストが import する名前。変更不可）:

| 名前 | 種別 | 備考 |
|---|---|---|
| `charactersSchema` | zod | `Character[]` を検証。`.parse()` の戻りが `Character[]` |
| `supplyFileSchema` | zod | `SupplyFile` を検証 |
| `Character` | type | 下記 |
| `SupplyFile` | type | `Record<string, SupplyEntry>`（キーはキャラ `id`） |

```ts
type Character = {
  id: string;            // 一意（A3）
  name: string;
  aliases: string[];
  series: string;
  dlsiteQuery: string | null;   // null = 収録対象外（SPEC 2.1）
  axes: Axes;
  reviewed: boolean;     // A2。人間のレビューでのみ true になる（SPEC 4.3）
};

type SupplyEntry = {
  pageCount: number;
  estimatedRange: [number, number];
  byWorkType: Record<string, number>;
  fetchedAt: string;     // ISO 8601（A8 の正規表現に一致すること）
};
```

`Axes` の 10 軸のキー名と許容値は **`tests/helpers/data.ts` の `AXIS_VALUES` と
1 文字も違わないこと**（A5 はその literal と突き合わせる。ヘルパを import して
逃げず、SPEC 2.3 から独立に書き起こす — 二重化が A5 の検出力そのもの）。

- 単一軸（`genderExpression` `ageFeel` `build` `personality` `distance` `species` `mood`）
  … `T | null`
- 複数軸（`roles` `looks` `outfit`）… `T[]`（未設定は `[]`。`null` にしない）
- 必須 4 軸（`genderExpression` `ageFeel` `build` `personality`）は zod 側でも
  `null` を弾く。残り 6 軸は `null` / `[]` を許容（SPEC 2.3）。

ゲート: 型検査 + lint のみ。振る舞いの検証は wave 2 の A1 が担う
（`tests/data.test.ts` は `data/*.json` が無いと import 時点で落ちるため、
このフィーチャの worktree では原理的に走らせられない）。

### 2. `engine-supply` — `src/engine/supply.ts`

供給量ランクの段階化（SPEC 2.3 の自動導出軸）。依存ゼロの純関数。

```ts
export const SUPPLY_RANKS = ['なし', '僅少', '少ない', '十分', '豊富'] as const;
export type SupplyRank = (typeof SUPPLY_RANKS)[number];
export function supplyRank(pageCount: number): SupplyRank;
export function supplyRankIndex(rank: SupplyRank): number;
```

閾値（`tests/engine.test.ts` が固定している）: 0→なし / 1→僅少 / 2–5→少ない /
6–20→十分 / 21+→豊富。

ゲート: 閾値と順序を検証するプローブを一時生成して vitest で実行 + 型検査 + lint。
`tests/engine.test.ts` は `recommend` と `data/*.json` を import するため
この worktree では走らない（同じ閾値を wave 3 で本テストが再検証する）。

### 3. `collect-script` — `scripts/collect.mjs`

DLsite 収集バッチ。**アプリからは一切 import しない独立 Node スクリプト**
（SPEC 2.2）。`tests/collect.test.ts` とフィクスチャ 3 種は既に main にあり、
このフィーチャだけで B1–B7 が完結する。

公開シンボル（`tests/collect.test.ts` が import する名前。変更不可）:
`CRAWL_DELAY_MS` / `PER_PAGE` / `USER_AGENT` / `buildSearchUrl` /
`createPoliteFetcher` / `estimateRange` / `parseSearchResult`

実装上の要点は SPEC 2.2 に実測済み。特に:

- URL は必ず `/page/1/` で終わる。**2 ページ目を生成できる引数を持たせない**（B1/B2）。
- リクエスト間隔 10 秒以上（B3。fake timers で検証されるので、実時間の
  `setTimeout` を注入可能にしておく）。
- `USER_AGENT` に連絡手段を含める（B4）。
- 件数は `global_pagination` の「最後へ」リンクの `/page/N/` から取る（B5）。
- 作品 ID の計数は **`search_result_list` の内側にスコープする**（B6。
  ページ全体では推薦枠が混ざり 30 件表示のページで 72 個ヒットする）。
- 0 件と 1 ページ収まりを `search_result_list` 内の ID 数で判別する（B7）。

CLI 実行時は `data/characters.json` の `dlsiteQuery !== null` を回して
`data/supply.json` を書く。この経路は wave 2 で初めて使う。

---

## wave 2（wave 1 マージ後）

### 4. `engine-questions` — `src/engine/questions.ts`

依存: `data-schema`（軸のキー型）。

```ts
export type QuestionOption = { value: string; label: string };
export type Question = {
  id: string;
  axis: AxisKey;              // schema.ts の軸キー
  label: string;              // 軸の短いラベル（radiogroup の aria-label）
  prompt: string;             // 質問文
  options: readonly QuestionOption[];
};
export const QUESTIONS: readonly Question[];
```

制約（`tests/engine.test.ts` 冒頭が固定）: 6〜8 問 / `id` 一意 / 各 2 択以上 /
`axis` は 1 問 1 軸で重複させない（C5 が `axis → question` の Map を作るため、
同一軸に 2 問あると後勝ちになり根拠検証が壊れる）。
必須 4 軸を必ず含める。「こだわらない」は `options` に入れない（回答値 `null`
として UI 側が持つ）。

ゲート: 型検査 + lint（`tests/engine.test.ts` は `recommend` を import するため
まだ走らない）。

### 5. `character-dataset` — `data/characters.json` / `data/supply.json`

依存: `data-schema`（検証）/ `engine-supply`（A7 のランク判定）/
`collect-script`（`supply.json` の生成）。SPEC 6 段階 1 の 30 体。

手順:

1. 30 体以上を `characters.json` に起こす。**`reviewed` は必ず `false` で書く**。
2. `npm run collect` を実行して `data/supply.json` を生成する。
   Crawl-delay 10 秒 × キャラ数 × 媒体別クエリで **20〜30 分かかる**。これは
   仕様どおりであり、短縮しない。
3. `pageCount === 0` のキャラは `characters.json` から削り、30 体を割ったら
   別のキャラで補充してから再収集する（A7）。

**`supply.json` を手で書かない。** 収集していない数値を置くと A6/A7/A8 は通るが
データが嘘になり、このプロジェクトの唯一の存在理由（在庫制約）が消える。
ネットワークが使えず収集できない場合は、捏造せずゲート失敗として停止すること。

ゲート: `tests/data.test.ts` から **A2 のみ除外**して実行する。A2（`reviewed`）は
「人間がレビューした」という事実の表明であり、実装エージェントがフラグを
`true` にして通せるゲートにしてはならない（SPEC 4.3）。除外は
`-t '^(?!.*A2:).*$'` で行う（vitest 4 で動作確認済み: 該当 1 件が skip、exit 0）。

A2 と `dlsiteQuery` の妥当性は **feature_accept の人間ゲート**で確認する:
30 体の属性値と検索クエリを目視し、問題なければその場で `reviewed` を `true` に
してからマージする。マージ後は `npm test` で A2 が green になる。

---

## wave 3（wave 2 マージ後）

### 6. `engine-recommend` — `src/engine/recommend.ts`

依存: `data-schema` / `engine-supply` / `engine-questions` / `character-dataset`。
C1–C6 の全てを負う中核。

```ts
export type Answers = Record<string, string | null>;   // 質問 id -> 回答値（null = こだわらない）
export type Dataset = { characters: Character[]; supply: SupplyFile };

export type Reason =
  | { kind: 'axis'; axis: AxisKey; value: string; label: string }
  | { kind: 'supply'; rank: SupplyRank; label: string };

export type Result = {
  character: Character;
  score: number;
  supplyRank: SupplyRank;
  reasons: Reason[];
};

export function recommend(answers: Answers, dataset: Dataset): Result[];
export function omakase(dataset: Dataset, opts: { seed: number }): Result[];
```

設計の要点（テストが直接縛る箇所）:

- **ハードフィルタは供給量のみ**。ランク「なし」を除外する。嗜好の不一致で
  候補を落とさない（C3: 無作為 1000 パスで 1 件も空にならない、を成立させる
  唯一の方法がスコアリングのみで足切りしないこと）。
- 返す件数は 3〜5（C1）。候補が十分にある限り 5 固定でよい。スコア降順。
- 決定論。同じ入力で同じ出力（C1 は 2 回呼んで `toEqual`）。同点は `id` の
  昇順など**安定した基準**で割る。`Math.random` を使わない。
- `reasons` は必ず 1 件以上（C5）。全問「こだわらない」では axis 根拠が
  1 件も立たないため、**`kind: 'supply'` の根拠を必ず添える**設計にする。
  これが `Reason` を union にしている理由。
- `kind: 'axis'` の根拠は**実際に一致した軸だけ**（C5 後半が捏造を弾く）:
  その軸に対応する質問が存在し、回答が `null` でなく、キャラの軸値が
  その回答に一致していること（複数軸なら `includes`）。
- 供給量ランクはスコアに加点するが、嗜好一致の重みを上書きしない
  小さい係数に抑える（SPEC 2.4）。
- `omakase` はランク「少ない」以上のみを対象に、供給量で重み付けした乱択。
  **seed から自前の疑似乱数（mulberry32 等）を回す**。同一 seed で再現し
  （C6）、seed を変えれば顔ぶれが変わること（30 seed で 2 通り以上）。

ゲート: `npx vitest run tests/engine.test.ts` + 型検査 + lint。
C1 のスナップショットはこの worktree での初回実行時に生成される
（`__snapshots__` を成果物として必ずコミットすること）。

---

## wave 4（wave 3 マージ後）

UI 3 画面。**互いに import しない純粋なプレゼンテーション層**として作り、
配線は wave 5 の `app-shell` が行う。`data-testid` は `e2e/helpers.ts` の
`TESTID` が唯一の正であり、勝手に増やさない。共通の見た目の規約は
`design_brief.md` と `.claude/rules/ui.md`、寸法と色は `src/styles/tokens.css`。

wave 4 の 3 フィーチャは vitest の環境が `node` で jsdom を持たないため
**コンポーネント単体テストが書けない**。ゲートは型検査 + lint に限られ、
実際の描画検証（F1–F6, D1）は integration_accept の `scripts/ui-check.sh` が担う。
その分、下記の props 契約からの逸脱がそのまま wave 5 の破綻になる。契約を守ること。

### 7. `ui-age-gate` — `src/screens/AgeGate.tsx` / `src/hooks/useAgeConfirmation.ts`

```ts
// useAgeConfirmation.ts
export const AGE_STORAGE_KEY = 'chara-picker:age-confirmed';   // e2e/helpers.ts と一致必須
export function useAgeConfirmation(): {
  confirmed: boolean;    // localStorage の 'true' で初期化
  dismissed: boolean;    // 閉じただけの状態
  confirm(): void;       // localStorage に 'true' を書く
  dismiss(): void;       // 書かない（F4 の 3 番目のテスト）
};

// AgeGate.tsx
export function AgeGate(props: { open: boolean; onConfirm(): void; onDismiss(): void }): JSX.Element | null;
```

- testid: `age-gate`（本体）/ `age-gate-accept`（承認ボタン）/
  `age-gate-backdrop`（背景）。`open === false` では `age-gate` が
  **hidden であること**（e2e は `toBeHidden` で見る。DOM から消すのが確実）。
- Escape と背景クリックの両方で `onDismiss`（F4）。閉じただけでは
  localStorage に書かない。
- `age-gate-accept` は Tab のみで到達でき、`:focus-visible` でアウトラインが
  出ること（F6。トークンの `--color-accent` を使う）。
- axe serious 0（F2）。`role="dialog"` + `aria-modal` + ラベル付け、
  フォーカストラップ。design_brief: **凝らない。単純・一度きり。**

### 8. `ui-interview` — `src/screens/QuestionScreen.tsx` / `src/hooks/useInterview.ts`

main にある `QuestionScreen.tsx` は design gate の参照画面（ダミー文言 + 自前
`useState`）。これを **`QUESTIONS` 駆動の props 受け取り型に作り替える**。
見た目（1 問 1 画面・縦リスト左揃え・選択中のみアクセント）は維持する。

```ts
// useInterview.ts
export function useInterview(): {
  question: Question | null;     // null = 全問終了
  index: number; total: number;
  answers: Answers;
  answer(value: string | null): void;   // 回答して次の問へ
  reset(): void;
};

// QuestionScreen.tsx
export function QuestionScreen(props: {
  question: Question;
  index: number; total: number;
  selected: string | null;
  onAnswer(value: string | null): void;
  onOmakase(): void;
}): JSX.Element;
```

- testid: `question` / `answer-option`（各選択肢）/ `answer-no-preference` /
  `omakase`。
- `answer-option` は `aria-checked` を持つ（F6 後半が属性の存在を直接見る）。
- Tab + Enter だけで回答でき、選択と同時に次の問へ進む（F3 の
  `answerAllByKeyboard` は 1 問につき「最初の `answer-option` に Tab → Enter」
  しかしない）。
- `omakase` はこの画面から Tab で到達できること（F3 の 3 番目）。
- 説明文・ツールチップを足さない（design_brief）。

### 9. `ui-results` — `src/screens/ResultsScreen.tsx` / `src/lib/dlsite-link.ts` / `src/components/SupplyMeter.tsx`

```ts
// dlsite-link.ts
export function dlsiteSearchUrl(query: string): string;
```

- 検索結果ページ（`/fsr/`）のみを生成する。**作品詳細（`/product_id/`）を
  生成しない**（D1 の 2 番目のテストが href を直接検査する）。
  `scripts/collect.mjs` を import しない（アプリとバッチは別プロセス。SPEC 2.2）。
- 結果行の外部リンクは `target="_blank"` + `rel="noopener"`（最低限。
  `noreferrer` の併記可）。fetch/prefetch を一切しない（D1）。

```ts
export function ResultsScreen(props: { results: Result[]; onRestart(): void }): JSX.Element;
```

- testid: `results`（本体）/ `result-item`（各行。1 位も含む）/ `result-top`（1 位）。
  D1 は `result-item` の中に `a[href^="http"]` が 1 件以上あることを要求する
  ので、**1 位も `result-item` を名乗ること**。
- 1 位を主役として大きく、2 位以下は簡素な行（design_brief）。
- 各行に一致した軸の根拠を出す。数値は tabular-nums。
- `SupplyMeter` はアクセント 1 色。**嗜好の一致より目立たせない**
  （design_brief の名指しの失敗例）。
- 画像・作品タイトルを一切描画しない（SPEC 3 / D2）。
- 空状態（`results` が空）は素直に出し、**操作ボタンの残骸を残さない**。

---

## wave 5（wave 4 マージ後）

### 10. `app-shell` — `src/App.tsx` / `src/main.tsx` / `index.html`

依存: wave 4 の全て + `engine-recommend`。画面遷移の配線。

- 年齢未確認では `question` も `results` も**描画しない**（F5。閉じた後に
  Tab を 30 回 + Enter しても結果へ抜けられないこと = 未確認時は
  質問画面自体を DOM に置かない）。
- 遷移: 年齢確認 → 質問（`useInterview`）→ 全問終了で `recommend` を呼び
  結果へ。`omakase` は質問画面から結果へ直行。
- `characters.json` / `supply.json` は**静的 import でバンドルに同梱**する
  （`resolveJsonModule` は有効済み）。fetch しない（D1）。
- `omakase` の seed は `Date.now()` 等でその場で作る（実行時ネットワーク不要）。

ゲート: 型検査 + lint + `npm run build`（`tsc --noEmit && vite build`）。
e2e（D1 / F1–F6）は横断的なので integration_accept に置く。

---

## integration_accept

`gate_all` = `npm test`（A/B/C/D2 全部）+ `npm run lint`（E1–E5）+
`scripts/ui-check.sh`（build → dist 走査 → Playwright + axe で D1 / F1–F6）。

ここで初めて全 e2e が回る。wave 4 の 3 フィーチャは型検査しか通っていないため、
**修正が集中するのはこの段階**と見込んでおくこと。

人間のゲートは SPEC のとおり 2 点のみ:

- 属性値のレビュー（wave 2 の feature_accept で `reviewed` を立てる行為）
- デザイン方向の承認（design gate で完了済み）

そのうえで 3 ブレークポイントのスクリーンショットを実際に見る
（design_brief「確認手順」: 視覚的重さの逆転と空状態の残骸を名指しで確認）。
