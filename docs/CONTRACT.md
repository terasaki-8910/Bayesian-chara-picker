# 実装契約（stage 1 で確定、build stage が満たす）

ACCEPTANCE.md の各基準は `tests/` と `e2e/` に符号化済み。テストは実装が存在しない
ため現在すべて赤である。ここには**テストが要求する API の形**だけを書く。
挙動の理由は SPEC.md 側にあるので繰り返さない。

新しい export を勝手に増やすのは自由。ここに書いたものを**削る・改名するのは不可**
（テストが直接名前で参照している）。

## 1. `src/data/schema.ts`

```ts
export interface CharacterAxes {
  genderExpression: string;          // 必須
  ageFeel: string;                   // 必須
  build: string;                     // 必須
  personality: string;               // 必須
  roles: string[];                   // 複数・空配列可
  distance: string | null;
  looks: string[];                   // 複数・空配列可
  outfit: string[];                  // 複数・空配列可
  species: string | null;
  mood: string | null;
}

export interface Character {
  id: string;
  name: string;
  aliases: string[];
  series: string;
  dlsiteQuery: string | null;
  axes: CharacterAxes;
  reviewed: boolean;
}

export interface SupplyEntry {
  pageCount: number;
  estimatedRange: [number, number];
  byWorkType: Record<string, number>;
  fetchedAt: string;                 // ISO 8601
}

export type SupplyFile = Record<string, SupplyEntry>;   // キーは Character['id']

export const characterSchema: z.ZodType<Character>;
export const charactersSchema: z.ZodType<Character[]>;
export const supplyEntrySchema: z.ZodType<SupplyEntry>;
export const supplyFileSchema: z.ZodType<SupplyFile>;
```

軸の許容値は SPEC 2.3 の表。`tests/helpers/data.ts` に literal で固定してあるが、
**そこから import してはいけない**（テスト側とスキーマ側の二重化が A5 の検出力の
源。片方を他方から導出すると typo を検出できなくなる）。

## 2. `src/engine/supply.ts`

```ts
export const SUPPLY_RANKS: readonly ['なし', '僅少', '少ない', '十分', '豊富'];
export type SupplyRank = (typeof SUPPLY_RANKS)[number];

export function supplyRank(pageCount: number): SupplyRank;   // 0 / 1 / 2-5 / 6-20 / 21+
export function supplyRankIndex(rank: SupplyRank): number;   // 0..4
```

## 3. `src/engine/questions.ts`

```ts
export interface QuestionOption { value: string; label: string }
export interface Question {
  id: string;
  axis: keyof CharacterAxes;   // 1 質問 = 1 軸
  prompt: string;
  options: QuestionOption[];   // 2 つ以上。「こだわらない」は含めない
}
export const QUESTIONS: readonly Question[];   // 6〜8 問、id 一意
```

「こだわらない」は選択肢ではなく**回答値 `null`** で表す。UI 側は
`data-testid="answer-no-preference"` の要素として別に描画する。

## 4. `src/engine/recommend.ts`

```ts
export type Answers = Record<string, string | null>;   // key = Question['id'], null = こだわらない

export type Reason =
  | { kind: 'axis'; axis: keyof CharacterAxes; label: string }
  | { kind: 'supply'; label: string };

export interface Recommendation {
  character: Character;
  score: number;
  supplyRank: SupplyRank;
  reasons: Reason[];              // 常に 1 件以上
  dlsiteSearchUrl: string;        // 検索結果ページ。作品詳細 URL は不可
}

export interface Dataset { characters: Character[]; supply: SupplyFile }

export function recommend(answers: Answers, dataset: Dataset, options?: { limit?: number }): Recommendation[];
export function omakase(dataset: Dataset, options: { seed: number; limit?: number }): Recommendation[];
```

テストが縛っている性質:

- `recommend` は 3〜5 件、`score` 降順。同一入力で完全に同一の出力（C1）。
- 供給量ランク「なし」は常に除外（ハードフィルタ）。返る候補は「僅少」以上（C2）。
- どんな回答パスでも空にならない（C3 / C4）。
- `reasons` は必ず 1 件以上。**`kind: 'axis'` の根拠は、その軸が実際に回答と
  一致している場合しか付けてはいけない**（C5 が捏造を検出する）。軸が 1 つも
  一致しないときは `kind: 'supply'` の根拠で埋める。
- `omakase` は供給量「少ない」以上のみ、同一 seed で同一結果、seed が違えば
  顔ぶれが変わりうる（C6）。

## 5. `scripts/collect.mjs`

```js
export const CRAWL_DELAY_MS;   // >= 10000
export const PER_PAGE;         // 30
export const USER_AGENT;       // 空でなく、mailto: か URL かメールアドレスを含む

export function buildSearchUrl({ keyword, workType }): string;
export function parseSearchResult(html, { perPage }): {
  pageCount: number;          // 「最後へ」リンクの N。結果 0 件なら 0
  itemsOnFirstPage: number;   // search_result_list 内側の作品 ID のユニーク数
  estimatedRange: [number, number];
};
export function estimateRange({ pageCount, itemsOnFirstPage, perPage }): [number, number];
export function createPoliteFetcher({ fetchImpl, delayMs }): (url, init?) => Promise<Response>;
```

必須の性質:

- `buildSearchUrl` は**常に `/page/1/` で終わる**。`page` を渡されても無視する。
  `keyword` は URL エンコードしてパス区切りの注入を防ぐ（B1）。
- `createPoliteFetcher` が返す関数は、連続呼び出しの**実行間隔**を `delayMs`
  以上に保ち、`User-Agent` ヘッダを付けて `fetchImpl` を呼ぶ（B3 / B4）。
  待機は `setTimeout` 経由（fake timers で進められること）。
- 作品 ID の計数は `search_result_list` の**内側にスコープする**。ページ全体を
  数えると推薦枠が混ざる（B6。フィクスチャはページ全体で 72 個、正解は 30）。
- **import しただけでは一切通信しない。** 実行本体は
  `if (import.meta.url === pathToFileURL(process.argv[1]).href)` のガード内に置く。
- `tsc --noEmit` の対象なので、export する関数には JSDoc で型を付ける
  （`scripts/dist-scan.mjs` が実例）。

## 6. UI の DOM 契約

`e2e/helpers.ts` の `TESTID` が正本。実装は以下の `data-testid` を必ず備える。

| testid | 要素 |
|---|---|
| `age-gate` | 年齢確認モーダル本体（`role="dialog"`） |
| `age-gate-accept` | 確認ボタン |
| `age-gate-backdrop` | 背景。クリックで閉じる |
| `question` | 質問画面 |
| `answer-option` | 回答選択肢。`aria-checked` / `aria-pressed` / `aria-selected` のいずれかで選択状態を表明する |
| `answer-no-preference` | 「こだわらない」 |
| `results` | 結果画面 |
| `result-item` | 結果 1 件 |
| `result-top` | 1 位（視覚的に主役） |
| `omakase` | おまかせ経路の入口 |

その他の制約:

- 年齢確認は localStorage キー `chara-picker:age-confirmed` に `'true'` を保存する。
- モーダルは Escape と背景クリックの両方で閉じる。ただし**閉じただけでは確認済みに
  しない**（F4 と F5 の整合。閉じた状態から結果へ抜けられてはいけない）。
- 結果の外部リンクは `target="_blank"` + `rel` に `noopener`、href は `/fsr/` を含み
  `/product_id/` を含まない。
- 実行時に外部ホストへ要求を出さない。**Web フォントの CDN 読み込みは D1 違反**に
  なるのでフォントは自己ホストする。

## 7. ゲートの走らせ方

| コマンド | 対応する基準 |
|---|---|
| `npm test` | A1-A8 / B1-B7 / C1-C6 / D2 の検出器 |
| `npm run lint` | E1-E5 |
| `scripts/ui-check.sh` | D1 / D2（成果物本体）/ F1-F6 |

`scripts/ui-check.sh` は `npm run build` → `scripts/dist-scan.mjs` → `playwright test`
の順で走る。`dist/` はビルド後にしか存在しないため、D2 の**成果物本体の走査は
ui-check 側にある**。`npm test` 側は検出器のロジックのみを検証する（ビルド前の
`npm test` が常に赤になると、リペアループが自力で直せない失敗を叩き続けるため）。
