import { useCallback, useEffect, useMemo, useReducer } from 'react';

import { useSessionLog, type SessionLogRecord } from './useSessionLog';
import { pickGuessWithCooldown } from '../engine/cooldown';
import {
  bayesNextProbe,
  bayesScoreCharacters,
  bayesShouldGuess,
  bayesShouldReguess,
  type BayesAnswerMap,
  type BayesProbe,
  type Confidence,
  type Dataset,
  type Scored,
} from '../engine/bayes';

/**
 * useInterview.ts のreducerを丸ごとミラーしたもの（PLAN「UI配線」）。
 * nextProbe/scoreCharacters/shouldGuess/shouldReguess だけをbayes版に差し替え、
 * Snapshot/Action/undo/questionsSinceReject/exhausted等の状態機械は完全に同じ構造を保つ
 * — 本番と別のロジックを二重実装して食い違うことを避けるため、意図的に揃えてある。
 *
 * `dataset` は import せず引数で受け取る。データの取得方法（静的import / 実行時fetch）が
 * アプリごとに異なるため（詳細は engine/bayes.ts 冒頭のコメント）。reducer へは
 * recentGuessIds と同じく action 経由で渡し、reducer を純粋なまま保つ。
 */

const NEAR_MISS_COUNT = 3;
/** guessingフェーズで推測と一緒に露出する「他の上位候補」の数（トップ3〜5候補の
 * アコーディオンUI用。開発元=ここでフックが候補を返し、UIはサイト側で実装する順。
 * 5件返してUI側で表示数を絞れるようにする）。 */
const CANDIDATES_COUNT = 5;

type Snapshot = {
  answers: BayesAnswerMap;
  askedKeys: readonly string[];
  rejected: readonly string[];
  /** 「いいえ」後の再質問モードで、拒否してから答えた質問数。null＝モード外。
   * `bayesShouldReguess` が true を返すまで質問を続け、返したら再推測して null に戻す。 */
  questionsSinceReject: number | null;
  guess: Scored | null;
  confirmed: boolean;
  exhausted: boolean;
  /**
   * このスナップショットの時点で asking 画面に表示されていた質問（無ければ null）。
   * 各アクションの処理時に一度だけ `bayesNextProbe` を呼んで state に確定させ、
   * 以後は undo で復元されるまで再計算しない。
   *
   * 以前はここを持たず、hookの `useMemo` で `state.answers` 等から毎レンダー
   * `bayesNextProbe(..., { rng: Math.random })` を呼んで再導出していた。
   * `bayesNextProbe` は拮抗する候補間のタイブレークに Math.random を使う
   * （意図的な設計 — forward進行が常に同じ質問順にならないための多様性）ため、
   * forward進行中は毎回ユニークな answers/askedKeys に対して1回しか導出されず
   * 問題が表面化しないが、undo で「以前訪れたのと同じ answers/askedKeys」に
   * 巻き戻すと、再導出時にMath.randomが再び振られて**別の質問**が選ばれることが
   * あった（ユーザー報告: 「一つ前の回答に戻ると、一つ前の問題ではなく別の問題に
   * なる」）。質問の選択をstateへ一度だけ確定させることで、undoは常に
   * 「そのスナップショットで実際に表示されていた質問」を復元するようになる。
   */
  probe: BayesProbe | null;
};

export type RawState = Snapshot & { history: readonly Snapshot[] };

function snapshotOf(state: RawState): Snapshot {
  const { history: _history, ...snapshot } = state;
  return snapshot;
}

/**
 * 初期stateの組み立て。`dataset` が無いとモジュールスコープで初期probeを
 * 計算できないため、`useReducer` の遅延初期化(第三引数)から呼ぶ。
 * マウントごとに1回だけ呼ばれる（Reactの仕様）ので、複数インスタンスが
 * 同じ初期質問に固定される心配もない。
 */
export function init(dataset: Dataset): RawState {
  return {
    answers: {},
    askedKeys: [],
    rejected: [],
    questionsSinceReject: null,
    guess: null,
    confirmed: false,
    exhausted: false,
    probe: bayesNextProbe(dataset, {}, new Set(), { exclude: new Set(), rng: Math.random }),
    history: [],
  };
}

export type Action =
  | { type: 'answer'; key: string; confidence: Confidence; recentGuessIds: readonly string[]; dataset: Dataset }
  | { type: 'reject'; characterId: string; recentGuessIds: readonly string[]; dataset: Dataset }
  | { type: 'confirm' }
  | { type: 'undo' }
  | { type: 'reset'; dataset: Dataset };

export function reducer(state: RawState, action: Action): RawState {
  switch (action.type) {
    case 'answer': {
      const history = [...state.history, snapshotOf(state)];
      const answers: BayesAnswerMap = { ...state.answers, [action.key]: action.confidence };
      const askedKeys = [...state.askedKeys, action.key];
      const rejectedSet = new Set(state.rejected);

      const askedSet = new Set(askedKeys);
      const probe = bayesNextProbe(action.dataset, answers, askedSet, { exclude: rejectedSet, rng: Math.random });
      const scored = bayesScoreCharacters(answers, action.dataset, { exclude: rejectedSet });

      // 「いいえ」後の再質問モード中は、最低問数と確信の回復を bayesShouldReguess に委ねる
      // （1問だけ聞いて即答えを出す旧挙動をやめた。engine/bayes.ts の同関数のコメント参照）。
      if (state.questionsSinceReject !== null) {
        const questionsSinceReject = state.questionsSinceReject + 1;
        if (!bayesShouldReguess(scored, questionsSinceReject, probe !== null)) {
          return { ...state, answers, askedKeys, questionsSinceReject, probe, history };
        }
        return {
          ...state,
          answers,
          askedKeys,
          questionsSinceReject: null,
          guess: pickGuessWithCooldown(scored, action.recentGuessIds, Math.random),
          probe: null,
          history,
        };
      }

      const goToGuessing = probe === null || bayesShouldGuess(scored, askedKeys.length, probe !== null);

      if (!goToGuessing) return { ...state, answers, askedKeys, probe, history };
      return {
        ...state,
        answers,
        askedKeys,
        guess: pickGuessWithCooldown(scored, action.recentGuessIds, Math.random),
        probe: null,
        history,
      };
    }

    case 'reject': {
      const history = [...state.history, snapshotOf(state)];
      const rejected = [...state.rejected, action.characterId];
      const rejectedSet = new Set(rejected);
      const scored = bayesScoreCharacters(state.answers, action.dataset, { exclude: rejectedSet });

      if (scored.length === 0) return { ...state, rejected, exhausted: true, probe: null, history };

      const askedSet = new Set(state.askedKeys);
      const bonusProbe = bayesNextProbe(action.dataset, state.answers, askedSet, { exclude: rejectedSet, rng: Math.random });

      // 聞ける質問が残っていれば再質問モードへ入る（0問答えた状態から開始）。
      if (bonusProbe !== null) return { ...state, rejected, questionsSinceReject: 0, probe: bonusProbe, history };
      return {
        ...state,
        rejected,
        guess: pickGuessWithCooldown(scored, action.recentGuessIds, Math.random),
        probe: null,
        history,
      };
    }

    case 'confirm':
      return { ...state, confirmed: true };

    case 'undo': {
      // history に積まれた Snapshot は probe も含めて確定済みなので、
      // ここで bayesNextProbe を呼び直さない（呼び直すとタイブレークの
      // Math.random が再び振られ、undo前と違う質問に化けるバグの原因だった）。
      if (state.history.length === 0) return state;
      const prev = state.history[state.history.length - 1];
      const history = state.history.slice(0, -1);
      return { ...prev, history };
    }

    case 'reset':
      return init(action.dataset);

    default:
      return state;
  }
}

export type BayesInterviewState =
  | {
      phase: 'asking';
      probe: BayesProbe;
      askedCount: number;
      canUndo: boolean;
      answer(confidence: Confidence): void;
      undo(): void;
      reset(): void;
    }
  | {
      phase: 'guessing';
      guess: Scored;
      /** 推測(guess)を除いたスコア上位の他候補（降順・拒否済み除外済み）。
       * guessはクールダウン適用後の1体なのでcandidates[0]と一致するとは限らない。 */
      candidates: Scored[];
      canUndo: boolean;
      confirm(): void;
      reject(): void;
      undo(): void;
      reset(): void;
    }
  | { phase: 'confirmed'; guess: Scored; reset(): void }
  | { phase: 'exhausted'; nearMisses: Scored[]; reset(): void };

function answersLogOf(answers: BayesAnswerMap): SessionLogRecord['answers'] {
  return Object.entries(answers).map(([key, confidence]) => ({ key, confidence }));
}

export function useBayesInterview(dataset: Dataset): BayesInterviewState {
  const [state, dispatch] = useReducer(reducer, dataset, init);
  const { recentGuessIds, log } = useSessionLog();

  const rejectedSet = useMemo(() => new Set(state.rejected), [state.rejected]);
  // 質問はもう毎レンダー導出しない。state.probe が「その時点で表示すべき質問」の
  // 確定値（reducer が各アクションの処理時に一度だけ確定させる。Snapshot型の
  // コメント参照）。
  const probe = state.probe;

  const reset = useCallback(() => dispatch({ type: 'reset', dataset }), [dataset]);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const canUndo = state.history.length > 0;

  const answer = useCallback(
    (confidence: Confidence) => {
      if (!probe) return;
      dispatch({ type: 'answer', key: probe.key, confidence, recentGuessIds, dataset });
    },
    [probe, recentGuessIds, dataset],
  );

  const confirm = useCallback(() => {
    if (state.guess) {
      log({
        ts: Date.now(),
        guessId: state.guess.character.id,
        outcome: 'confirmed',
        askedCount: state.askedKeys.length,
        answers: answersLogOf(state.answers),
        rejectedIds: state.rejected,
        engine: 'bayes',
      });
    }
    dispatch({ type: 'confirm' });
  }, [state.guess, state.askedKeys, state.answers, state.rejected, log]);

  const reject = useCallback(() => {
    if (!state.guess) return;
    log({
      ts: Date.now(),
      guessId: state.guess.character.id,
      outcome: 'rejected',
      askedCount: state.askedKeys.length,
      answers: answersLogOf(state.answers),
      rejectedIds: state.rejected,
      engine: 'bayes',
    });
    dispatch({ type: 'reject', characterId: state.guess.character.id, recentGuessIds, dataset });
  }, [state.guess, state.askedKeys, state.answers, state.rejected, recentGuessIds, dataset, log]);

  useEffect(() => {
    if (!state.exhausted) return;
    log({
      ts: Date.now(),
      guessId: null,
      outcome: 'exhausted',
      askedCount: state.askedKeys.length,
      answers: answersLogOf(state.answers),
      rejectedIds: state.rejected,
      engine: 'bayes',
    });
  }, [state.exhausted, state.askedKeys, state.answers, state.rejected, log]);

  if (state.exhausted) {
    const nearMisses = bayesScoreCharacters(state.answers, dataset).slice(0, NEAR_MISS_COUNT);
    return { phase: 'exhausted', nearMisses, reset };
  }

  if (state.confirmed && state.guess) {
    return { phase: 'confirmed', guess: state.guess, reset };
  }

  // 再質問モード中（questionsSinceReject!==null）は、拒否済みの guess が残っていても
  // guessing 画面へは進まない——次の推測が確定するまで asking を続ける。
  if (state.questionsSinceReject === null && state.guess) {
    const guessId = state.guess.character.id;
    const candidates = bayesScoreCharacters(state.answers, dataset, { exclude: rejectedSet })
      .filter((s) => s.character.id !== guessId)
      .slice(0, CANDIDATES_COUNT);
    return { phase: 'guessing', guess: state.guess, candidates, canUndo, confirm, reject, undo, reset };
  }

  if (!probe) {
    const nearMisses = bayesScoreCharacters(state.answers, dataset).slice(0, NEAR_MISS_COUNT);
    return { phase: 'exhausted', nearMisses, reset };
  }
  return { phase: 'asking', probe, askedCount: state.askedKeys.length, canUndo, answer, undo, reset };
}
