import { useCallback, useMemo, useState } from 'react';

import charactersData from '../../data/characters.json';
import supplyData from '../../data/supply.json';
import type { AxisKey, Character, SupplyFile } from '../data/schema';
import { MAX_QUESTIONS, type Question } from '../engine/questions';
import { nextQuestion, type Answers, type Dataset } from '../engine/recommend';

/**
 * SPEC 2.5: characters.json / supply.json をビルド時に静的 import してバンドルに
 * 同梱する（実行時のネットワークアクセスはゼロ、D1）。`useInterview()` は
 * 引数を取らない契約（PLAN wave 4）なので、この Dataset の組み立てはここで
 * 完結させる。app-shell（wave 5）が「おまかせ」で同じデータを使う場合はここから
 * import して使い回し、二重に組み立てない。
 */
// JSON import の型推論は tuple（estimatedRange: [number, number] 等）を
// 表現できず number[] になるため、構造的に「十分に重ならない」と tsc に
// 拒否される。実体は zod（tests/data.test.ts の A1）で検証済みなので
// unknown 経由でキャストする。
export const dataset: Dataset = {
  characters: charactersData as unknown as Character[],
  supply: supplyData as unknown as SupplyFile,
};

export function useInterview(): {
  question: Question | null;
  index: number;
  total: number;
  answers: Answers;
  answer(value: string | null): void;
  reset(): void;
} {
  const [answers, setAnswers] = useState<Answers>({});
  const [askedAxes, setAskedAxes] = useState<AxisKey[]>([]);

  const question = useMemo(() => nextQuestion(dataset, answers, askedAxes), [answers, askedAxes]);

  const answer = useCallback(
    (value: string | null) => {
      if (!question) return;
      const axis = question.axis;
      setAnswers((prev) => ({ ...prev, [axis]: value }));
      setAskedAxes((prev) => [...prev, axis]);
    },
    [question],
  );

  const reset = useCallback(() => {
    setAnswers({});
    setAskedAxes([]);
  }, []);

  return {
    question,
    // total は MAX_QUESTIONS 固定の上限値。動的選択で実際の質問数は変動するため
    // 「生きた残り数」ではなく安定した分母として使う（早期終了時は index が
    // total 未満で止まる。PLAN wave 3/4）。
    index: askedAxes.length + 1,
    total: MAX_QUESTIONS,
    answers,
    answer,
    reset,
  };
}
