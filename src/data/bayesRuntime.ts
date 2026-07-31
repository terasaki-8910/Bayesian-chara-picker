import likelihoodsData from '../../data/bayes/likelihoods.json';
import questionsRuntimeData from '../../data/bayes/questions.runtime.json';
import { initBayesData, type LikelihoodsFile, type QuestionsRuntimeFile } from '../engine/bayes';

/**
 * ベイズエンジンへのデータ投入口（このアプリ側の配信方法 = ビルド時同梱）。
 *
 * engine/bayes.ts は配信方法の違う terasaki-8910.github.io (/chara-picker/) と
 * ファイルを共有しているため、JSON の import を持たない（あちらは実行時fetch）。
 * その分の「どこからデータを渡すか」をここに閉じ込める。
 * SPEC 2.5 の「実行時のネットワークアクセスはゼロ（D1）」はこの静的importで維持される。
 *
 * JSON import の型推論は tuple を表現できず number[] になるため unknown 経由でキャストする
 * （実体は zod / tests 側で検証済み。useInterview.ts の dataset と同じ理由）。
 */
export function initBayes(): void {
  initBayesData(
    likelihoodsData as unknown as LikelihoodsFile,
    questionsRuntimeData as unknown as QuestionsRuntimeFile,
  );
}
