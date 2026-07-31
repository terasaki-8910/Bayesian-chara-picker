import { initBayes } from '../src/data/bayesRuntime';

/**
 * ベイズエンジンは likelihoods / questions.runtime を initBayesData() で外から
 * 受け取る形になっている（engine/bayes.ts 冒頭のコメント参照）。テストは
 * エンジン関数を直接呼ぶため、各テストファイルで初期化を書かずに済むよう
 * ここ（vitest.config.ts の setupFiles）で一括して注入する。
 */
initBayes();
