import { useCallback, useEffect, useMemo, useReducer } from 'react';

import { useSessionLog, type SessionLogRecord } from './useSessionLog';
import { pickGuessWithCooldown } from '../engine/cooldown';
import {
  bayesNextProbe,
  bayesScoreCharacters,
  bayesShouldGuess,
  type BayesAnswerMap,
  type BayesProbe,
  type Confidence,
  type Dataset,
  type Scored,
} from '../engine/bayes';

/**
 * useInterview.ts のreducerを丸ごとミラーしたもの（PLAN「UI配線」）。
 * nextProbe/scoreCharacters/shouldGuess だけをbayes版に差し替え、
 * Snapshot/Action/undo/bonusPending/exhausted等の状態機械は完全に同じ構造を保つ
 * — 本番と別のロジックを二重実装して食い違うことを避けるため、意図的に揃えてある。
 *
 * `dataset` は import せず引数で受け取る。データの取得方法（静的import / 実行時fetch）が
 * アプリごとに異なるため（詳細は engine/bayes.ts 冒頭のコメント）。reducer へは
 * recentGuessIds と同じく action 経由で渡し、reducer を純粋なまま保つ。
 */

const NEAR_MISS_COUNT = 3;

type Snapshot = {
  answers: BayesAnswerMap;
  askedKeys: readonly string[];
  rejected: readonly string[];
  bonusPending: boolean;
  guess: Scored | null;
  confirmed: boolean;
  exhausted: boolean;
};

type RawState = Snapshot & { history: readonly Snapshot[] };

function snapshotOf(state: RawState): Snapshot {
  const { history: _history, ...snapshot } = state;
  return snapshot;
}

const initialState: RawState = {
  answers: {},
  askedKeys: [],
  rejected: [],
  bonusPending: false,
  guess: null,
  confirmed: false,
  exhausted: false,
  history: [],
};

type Action =
  | { type: 'answer'; key: string; confidence: Confidence; recentGuessIds: readonly string[]; dataset: Dataset }
  | { type: 'reject'; characterId: string; recentGuessIds: readonly string[]; dataset: Dataset }
  | { type: 'confirm' }
  | { type: 'undo' }
  | { type: 'reset' };

function reducer(state: RawState, action: Action): RawState {
  switch (action.type) {
    case 'answer': {
      const history = [...state.history, snapshotOf(state)];
      const answers: BayesAnswerMap = { ...state.answers, [action.key]: action.confidence };
      const askedKeys = [...state.askedKeys, action.key];
      const rejectedSet = new Set(state.rejected);

      if (state.bonusPending) {
        const scored = bayesScoreCharacters(answers, action.dataset, { exclude: rejectedSet });
        return {
          ...state,
          answers,
          askedKeys,
          bonusPending: false,
          guess: pickGuessWithCooldown(scored, action.recentGuessIds, Math.random),
          history,
        };
      }

      const askedSet = new Set(askedKeys);
      const probe = bayesNextProbe(action.dataset, answers, askedSet, { exclude: rejectedSet, rng: Math.random });
      const scored = bayesScoreCharacters(answers, action.dataset, { exclude: rejectedSet });
      const goToGuessing = probe === null || bayesShouldGuess(scored, askedKeys.length, probe !== null);

      if (!goToGuessing) return { ...state, answers, askedKeys, history };
      return {
        ...state,
        answers,
        askedKeys,
        guess: pickGuessWithCooldown(scored, action.recentGuessIds, Math.random),
        history,
      };
    }

    case 'reject': {
      const history = [...state.history, snapshotOf(state)];
      const rejected = [...state.rejected, action.characterId];
      const rejectedSet = new Set(rejected);
      const scored = bayesScoreCharacters(state.answers, action.dataset, { exclude: rejectedSet });

      if (scored.length === 0) return { ...state, rejected, exhausted: true, history };

      const askedSet = new Set(state.askedKeys);
      const bonusProbe = bayesNextProbe(action.dataset, state.answers, askedSet, { exclude: rejectedSet, rng: Math.random });

      if (bonusProbe !== null) return { ...state, rejected, bonusPending: true, history };
      return {
        ...state,
        rejected,
        guess: pickGuessWithCooldown(scored, action.recentGuessIds, Math.random),
        history,
      };
    }

    case 'confirm':
      return { ...state, confirmed: true };

    case 'undo': {
      if (state.history.length === 0) return state;
      const prev = state.history[state.history.length - 1];
      const history = state.history.slice(0, -1);
      return { ...prev, history };
    }

    case 'reset':
      return initialState;

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
  | { phase: 'guessing'; guess: Scored; canUndo: boolean; confirm(): void; reject(): void; undo(): void; reset(): void }
  | { phase: 'confirmed'; guess: Scored; reset(): void }
  | { phase: 'exhausted'; nearMisses: Scored[]; reset(): void };

function answersLogOf(answers: BayesAnswerMap): SessionLogRecord['answers'] {
  return Object.entries(answers).map(([key, confidence]) => ({ key, confidence }));
}

export function useBayesInterview(dataset: Dataset): BayesInterviewState {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { recentGuessIds, log } = useSessionLog();

  const askedSet = useMemo(() => new Set(state.askedKeys), [state.askedKeys]);
  const rejectedSet = useMemo(() => new Set(state.rejected), [state.rejected]);
  const probe = useMemo(
    () => bayesNextProbe(dataset, state.answers, askedSet, { exclude: rejectedSet, rng: Math.random }),
    [dataset, state.answers, askedSet, rejectedSet],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
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

  if (!state.bonusPending && state.guess) {
    return { phase: 'guessing', guess: state.guess, canUndo, confirm, reject, undo, reset };
  }

  if (!probe) {
    const nearMisses = bayesScoreCharacters(state.answers, dataset).slice(0, NEAR_MISS_COUNT);
    return { phase: 'exhausted', nearMisses, reset };
  }
  return { phase: 'asking', probe, askedCount: state.askedKeys.length, canUndo, answer, undo, reset };
}
