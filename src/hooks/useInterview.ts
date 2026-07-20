import { useCallback, useMemo, useReducer } from 'react';

import charactersData from '../../data/characters.json';
import supplyData from '../../data/supply.json';
import type { Character, SupplyFile } from '../data/schema';
import {
  nextProbe,
  scoreCharacters,
  shouldGuess,
  topGuess,
  type AnswerMap,
  type Confidence,
  type Dataset,
  type Probe,
  type Scored,
} from '../engine/recommend';

/**
 * SPEC 2.5: characters.json / supply.json をビルド時に静的 import してバンドルに
 * 同梱する（実行時のネットワークアクセスはゼロ、D1）。`useInterview()` は
 * 引数を取らない契約（PLAN wave 4）なので、この Dataset の組み立てはここで
 * 完結させる。app-shell が「おまかせ」で同じデータを使う場合はここから
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

/** 全滅画面に出す「近かった候補」の数（PLAN: 「スコア上位数体、rejectedも含む」）。 */
const NEAR_MISS_COUNT = 3;

type RawState = {
  answers: AnswerMap;
  askedKeys: readonly string[];
  /** 「いいえ」で拒否済みのキャラ id。以降のスコアリング・質問選択から除外する。 */
  rejected: readonly string[];
  /** 拒否直後、情報量のある質問が残っていた場合に挟む「ボーナス1問」の最中かどうか。
   * この間は shouldGuess のマージン判定を待たず、1問答えたら即座に次の推測へ進む
   * （PLAN 規則4「分離できる情報量のあるプローブが残っていれば1問だけ追加」）。 */
  bonusPending: boolean;
  /** 直近で提示した推測。guessing/confirmed 表示にはこれを使い、再描画のたびに
   * topGuess を引き直さない — 同点タイブレークは乱択のため、引き直すと表示中の
   * 推測が再描画のたびに変わってしまう（PLAN「同点のみ乱択」の意図は「1回だけ
   * 乱択する」であって「常に乱択し続ける」ではない）。 */
  guess: Scored | null;
  confirmed: boolean;
  /** 拒否を続けた結果、非拒否キャラが尽きた（PLAN 規則5「全滅」）。 */
  exhausted: boolean;
};

const initialState: RawState = {
  answers: {},
  askedKeys: [],
  rejected: [],
  bonusPending: false,
  guess: null,
  confirmed: false,
  exhausted: false,
};

type Action =
  | { type: 'answer'; key: string; confidence: Confidence }
  | { type: 'reject'; characterId: string }
  | { type: 'confirm' }
  | { type: 'reset' };

function reducer(state: RawState, action: Action): RawState {
  switch (action.type) {
    case 'answer': {
      const answers: AnswerMap = { ...state.answers, [action.key]: action.confidence };
      const askedKeys = [...state.askedKeys, action.key];
      const rejectedSet = new Set(state.rejected);

      if (state.bonusPending) {
        const scored = scoreCharacters(answers, dataset, { exclude: rejectedSet });
        return { ...state, answers, askedKeys, bonusPending: false, guess: topGuess(scored, Math.random) };
      }

      const askedSet = new Set(askedKeys);
      const probe = nextProbe(dataset, answers, askedSet, { exclude: rejectedSet });
      const scored = scoreCharacters(answers, dataset, { exclude: rejectedSet });
      // probe===null（物理的に聞くべき質問が尽きた）なら MIN_QUESTIONS 未達でも
      // 推測へ進む — 存在しない質問を asking 画面に表示することはできないため。
      const goToGuessing = probe === null || shouldGuess(scored, askedKeys.length, probe !== null);

      if (!goToGuessing) return { ...state, answers, askedKeys };
      return { ...state, answers, askedKeys, guess: topGuess(scored, Math.random) };
    }

    case 'reject': {
      const rejected = [...state.rejected, action.characterId];
      const rejectedSet = new Set(rejected);
      const scored = scoreCharacters(state.answers, dataset, { exclude: rejectedSet });

      if (scored.length === 0) return { ...state, rejected, exhausted: true };

      const askedSet = new Set(state.askedKeys);
      const bonusProbe = nextProbe(dataset, state.answers, askedSet, { exclude: rejectedSet });

      if (bonusProbe !== null) return { ...state, rejected, bonusPending: true };
      return { ...state, rejected, guess: topGuess(scored, Math.random) };
    }

    case 'confirm':
      return { ...state, confirmed: true };

    case 'reset':
      return initialState;

    default:
      return state;
  }
}

export type InterviewState =
  | { phase: 'asking'; probe: Probe; askedCount: number; answer(confidence: Confidence): void; reset(): void }
  | { phase: 'guessing'; guess: Scored; confirm(): void; reject(): void; reset(): void }
  | { phase: 'confirmed'; guess: Scored; reset(): void }
  | { phase: 'exhausted'; nearMisses: Scored[]; reset(): void };

export function useInterview(): InterviewState {
  const [state, dispatch] = useReducer(reducer, initialState);

  const askedSet = useMemo(() => new Set(state.askedKeys), [state.askedKeys]);
  const rejectedSet = useMemo(() => new Set(state.rejected), [state.rejected]);
  // 質問選択は完全に決定論的（乱数を使わない）なので、guess と違って毎回引き直して安全。
  const probe = useMemo(
    () => nextProbe(dataset, state.answers, askedSet, { exclude: rejectedSet }),
    [state.answers, askedSet, rejectedSet],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  const answer = useCallback(
    (confidence: Confidence) => {
      if (!probe) return;
      dispatch({ type: 'answer', key: probe.key, confidence });
    },
    [probe],
  );

  const confirm = useCallback(() => dispatch({ type: 'confirm' }), []);

  const reject = useCallback(() => {
    if (!state.guess) return;
    dispatch({ type: 'reject', characterId: state.guess.character.id });
  }, [state.guess]);

  if (state.exhausted) {
    const nearMisses = scoreCharacters(state.answers, dataset).slice(0, NEAR_MISS_COUNT);
    return { phase: 'exhausted', nearMisses, reset };
  }

  if (state.confirmed && state.guess) {
    return { phase: 'confirmed', guess: state.guess, reset };
  }

  if (!state.bonusPending && state.guess) {
    return { phase: 'guessing', guess: state.guess, confirm, reject, reset };
  }

  // asking: 通常の質問中、またはボーナス1問中。
  // probe が null になるのは reducer 側の事前チェックにより通常発生しないが、
  // 万一の不整合に備えて全滅画面へ安全側にフォールバックする。
  if (!probe) {
    const nearMisses = scoreCharacters(state.answers, dataset).slice(0, NEAR_MISS_COUNT);
    return { phase: 'exhausted', nearMisses, reset };
  }
  return { phase: 'asking', probe, askedCount: state.askedKeys.length, answer, reset };
}
