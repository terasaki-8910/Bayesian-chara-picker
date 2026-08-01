import { describe, expect, it } from 'vitest';

import type { Character, SupplyFile } from '../src/data/schema';
import {
  nextProbe,
  scoreCharacters,
  shouldGuess,
  survivors,
  topGuess,
  type AnswerMap,
  type Confidence,
  type Dataset,
} from '../src/engine/recommend';
import { readJson } from './helpers/data';

/**
 * 推薦エンジンの「特定キャラばかり出る」偏りを機械的に検出するゲート
 * （state/engine-review/NOTES.md 参照）。`state/engine-review/bias-sweep.mts`
 * （探索用、gitignore対象で CI からは見えない）の集計ロジックを、固定シードで
 * 決定論的に vitest へ移植したもの。
 *
 * ここで見ているのは `topGuess`（クールダウン適用前の生スコア）の分布。
 * `pickGuessWithCooldown` はセッションをまたいだ localStorage 履歴に依存する
 * ため、単体では決定論的に再現できず、このゲートの対象外
 * （Stage 1 は cooldown.test.ts が別途保証する）。
 */
const dataset: Dataset = {
  characters: readJson<Character[]>('data/characters.json'),
  supply: readJson<SupplyFile>('data/supply.json'),
};

/**
 * `topGuess` が実際に返しうる母集団。`recommend.ts` の `survivors()` と同じ
 * 条件で絞る。ここを全キャラ数のまま一様分布の分母に使うと、一生出現しない
 * キャラ（性別ハードフィルタ・provisional）まで「出現しうるのに出なかった」
 * 扱いになりカイ二乗を過大に見せる（2026-07-21発見、131分母=643.7が正しくは
 * 128分母=514.4だった）。
 */
const reachableCount = survivors(dataset).length;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runOneSession(rng: () => number, biasYes: number): string {
  const answers: AnswerMap = {};
  const askedKeys: string[] = [];
  for (let guard = 0; guard < 60; guard += 1) {
    const askedSet = new Set(askedKeys);
    const probe = nextProbe(dataset, answers, askedSet, { rng });
    const scored = scoreCharacters(answers, dataset);
    const goToGuessing = probe === null || shouldGuess(scored, askedKeys.length, probe !== null);
    if (goToGuessing) return topGuess(scored, rng).character.id;

    const r = rng();
    let confidence: Confidence;
    if (r < 0.1) confidence = 'unknown';
    else if (r < 0.1 + biasYes) confidence = rng() < 0.7 ? 'yes' : 'probably_yes';
    else confidence = rng() < 0.7 ? 'no' : 'probably_no';
    answers[probe!.key] = confidence;
    askedKeys.push(probe!.key);
  }
  throw new Error('runOneSession: ガードを超えた（無限ループの疑い）');
}

/**
 * 現在の値は「これ以上悪化させない」ための天井（N=1000・seed=20260721・
 * reachableCount=128 で正しく計算した実測値 chiSquare=210.6, maxShare=1.90%
 * にヘッドルームを持たせただけ）。分母を全131体にしていた誤りを修正した際に
 * 再計算した（2026-07-21。旧値239.0は131分母の計算誤りに基づく数値だった）。
 * BLANK_YES_PENALTY_RATIO による集計上の偏り改善は見送った
 * （state/engine-review/NOTES.md「2026-07-21 追記」参照 — κを上げても
 * 集計全体のカイ二乗はほぼ動かないことを実測で確認したため）。
 *
 * 2026-07-26追記: キャラ拡充（53体追加、reachableCount 128→181・+41%）に伴い
 * 実測値が上振れした（seed=20260721で335.4、seed=13579246で298.9。特定1体の
 * 異常ではなく、母集団拡大に伴う分散増加——シードごとに最頻出キャラが
 * 入れ替わることを確認済み。C13自己収束は128→181体でも100%を維持しており
 * 推薦の正しさ自体に問題は無い）。2シードの実測上限に約8%のヘッドルームを
 * 持たせて360へ引き上げた。
 *
 * 2026-08-01改定: `survivors()`が`reviewed!==true`もハードフィルタするように
 * なり、reachableCount 181→20 へ激減（査読前データの質のばらつきがベイズ側の
 * BDゲートで統計的に無視できない偏りとして表面化したため、reviewedを
 * ハードフィルタに追加。詳細は tests/bayes-bias.test.ts の同日コメント参照）。
 * 母集団が大きく変わったため両閾値を再計測: N=1000で
 * chiSquare は seed=20260721→112.6, 13579246→75.8, 987654321→79.8
 * （実測上限112.6に約40%の余裕で160へ）。
 * maxShare は同順で9.10%, 8.40%, 7.80%（実測上限9.10%に約30%の余裕で0.12へ
 * ——reachable=20では一様期待値自体が5%なので、旧値0.025は母集団縮小後は
 * 理論上も満たせない値になっていた）。
 * 将来さらにキャラを拡充/査読する場合はこの値もあわせて再計算すること
 * （state/engine-review/bias-sweep.mts があれば、無ければこのファイルの
 * runOneSessionをtop15ログ付きで一時的に走らせて実測する）。
 *
 * 2026-08-01追記（査読バッチ1）: reviewed 22→32体（reachable 20→30）に伴い
 * 再計測（一時スイープをrunOneSession複製で5シード×N=1000、手順は上記の通り）。
 * chiSquare実測: seed=20260721→150.7, 20260724→79.6, 13579246→92.0,
 * 987654321→96.1, 424242→102.1。上限150.7に約40%の余裕で210へ。
 * maxShare実測: 同順で5.80%, 5.00%, 5.20%, 5.80%, 5.90%。上限5.90%に
 * 約35%の余裕で0.08へ（母集団拡大で一様期待値が5%→3.3%に下がったため、
 * 旧値0.12は緩すぎる側に転じていた——閾値は緩める一方ではなく母集団に
 * 合わせて締め直す）。
 *
 * 2026-08-01追記（査読バッチ2）: reviewed 32→62体（reachable 30→60）。
 * chiSquare実測: seed=20260721→136.2, 20260724→157.0, 13579246→202.4,
 * 987654321→144.8, 424242→153.1。上限202.4に約41%の余裕で285へ。
 * maxShare実測: 同順で3.70%, 3.80%, 5.10%, 3.20%, 3.60%。上限5.10%に
 * 約37%の余裕で0.07へ（一様期待値は1.67%）。
 *
 * 2026-08-01追記（査読バッチ3 + W_LLM 15→8）: reviewed 62→92体
 * （reachable 60→90）。BC13修復のためのLLM_MERGE_WEIGHT変更
 * （estimators.mjs参照）後に再計測。chiSquare実測: seed=20260721→181.3,
 * 20260724→149.5, 13579246→213.7, 987654321→161.7, 424242→229.8。
 * 上限229.8に約39%の余裕で320へ。maxShare実測: 同順で2.60%, 2.20%,
 * 3.20%, 2.60%, 2.60%。上限3.20%に約41%の余裕で0.045へ（一様期待値1.11%）。
 */
const CHI_SQUARE_MAX = 320;
const MAX_SHARE = 0.045;

describe('D. 推薦エンジンの偏りゲート', () => {
  // scoreCharacters/nextProbe は呼び出しごとに131体ぶんのプローブプールを
  // 再構築するため、この種のセッション数の合計計算量は軽くない。
  // N=2000だと単体では約20秒で収まるが、他のテストファイル（C3等）と
  // 並列実行されると資源競合で双方がタイムアウトすることを確認したため
  // N=1000に下げ、タイムアウトにも十分な余裕を持たせる。
  it(
    '固定シードの疑似セッション群で、特定キャラへの偏りが閾値を超えない',
    () => {
      const N = 1000;
      const tally = new Map<string, number>();
      const rng = mulberry32(20260721);

      for (let i = 0; i < N; i += 1) {
        const biasYes = 0.2 + rng() * 0.4;
        const id = runOneSession(rng, biasYes);
        tally.set(id, (tally.get(id) ?? 0) + 1);
      }

      const uniform = N / reachableCount;
      const counts = [...tally.values()];
      const zeroCount = reachableCount - counts.length;
      const chiSquare = counts.reduce((sum, c) => sum + (c - uniform) ** 2 / uniform, 0) + zeroCount * uniform;
      const maxShare = Math.max(...counts) / N;

      expect(
        chiSquare,
        `カイ二乗統計量: ${chiSquare.toFixed(1)}（一様期待値 ${uniform.toFixed(1)}/体）`,
      ).toBeLessThanOrEqual(CHI_SQUARE_MAX);
      expect(maxShare, `最頻出キャラの占有率: ${(maxShare * 100).toFixed(1)}%`).toBeLessThanOrEqual(MAX_SHARE);
    },
    // 単体では約10秒だが、他の重いテストファイル（C3等）と並列実行された際の
    // CPU競合で20秒でも超えることがあったため、実測の数倍のヘッドルームを持たせる。
    60000,
  );
});
