import { useCallback, useEffect, useReducer } from 'react';

import charactersData from '../../data/characters.json';
import supplyData from '../../data/supply.json';
import type { Character, SupplyFile } from '../data/schema';
import { pickGuessWithCooldown } from '../engine/cooldown';
import {
  nextProbe,
  scoreCharacters,
  shouldGuess,
  shouldReguess,
  type AnswerMap,
  type Confidence,
  type Dataset,
  type Probe,
  type Scored,
} from '../engine/recommend';
import { useSessionLog, type SessionLogRecord } from './useSessionLog';

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

type Snapshot = {
  answers: AnswerMap;
  askedKeys: readonly string[];
  /** 「いいえ」で拒否済みのキャラ id。以降のスコアリング・質問選択から除外する。 */
  rejected: readonly string[];
  /** 「いいえ」後の再質問モードで、拒否してから答えた質問数。null＝モード外。
   * `shouldReguess` が true を返すまで質問を続け、返したら再推測して null に戻す
   * （PLAN 規則4「1問だけ追加」から、最低3問＋確信回復まで聞く設計へ変更。
   * engine/recommend.ts の shouldReguess のコメント参照）。 */
  questionsSinceReject: number | null;
  /** 直近で提示した推測。guessing/confirmed 表示にはこれを使い、再描画のたびに
   * topGuess を引き直さない — 同点タイブレークは乱択のため、引き直すと表示中の
   * 推測が再描画のたびに変わってしまう（PLAN「同点のみ乱択」の意図は「1回だけ
   * 乱択する」であって「常に乱択し続ける」ではない）。 */
  guess: Scored | null;
  confirmed: boolean;
  /** 拒否を続けた結果、非拒否キャラが尽きた（PLAN 規則5「全滅」）。 */
  exhausted: boolean;
  /**
   * このスナップショットの時点で asking 画面に表示されていた質問（無ければ null）。
   * 各アクションの処理時に一度だけ `nextProbe` を呼んで state に確定させ、
   * 以後は undo で復元されるまで再計算しない。
   *
   * 以前はここを持たず、hookの `useMemo` で `state.answers` 等から毎レンダー
   * `nextProbe(..., { rng: Math.random })` を呼んで再導出していた。`nextProbe`は
   * 拮抗する候補間のタイブレークに Math.random を使う（意図的な設計 — forward
   * 進行が常に同じ質問順にならないための多様性）ため、forward進行中は毎回
   * ユニークな answers/askedKeys に対して1回しか導出されず問題が表面化しないが、
   * undo で「以前訪れたのと同じ answers/askedKeys」に巻き戻すと、再導出時に
   * Math.randomが再び振られて**別の質問**が選ばれることがあった
   * （サイト側でユーザー報告: 「一つ前の回答に戻ると、一つ前の問題ではなく
   * 別の問題になる」。useBayesInterview.tsをミラーしたこちらにも同じ構造の
   * バグが存在したため、対称性を保ったまま同時に修正）。質問の選択をstateへ
   * 一度だけ確定させることで、undoは常に「そのスナップショットで実際に
   * 表示されていた質問」を復元するようになる。
   */
  probe: Probe | null;
};

/**
 * 「一つ前の回答に戻る」用の履歴スタック（ユーザー要望）。answer/reject の
 * 直前スナップショットを積むだけの単純なUndo — 全体リセットとは別に、質問中・
 * 推測確認中のどちらからも1手だけ巻き戻せるようにする。`history` 自身は
 * スナップショットに含めない（再帰的なネストを避けるため）。
 */
export type RawState = Snapshot & { history: readonly Snapshot[] };

function snapshotOf(state: RawState): Snapshot {
  const { history: _history, ...snapshot } = state;
  return snapshot;
}

/**
 * 初期stateの組み立て。`useReducer` の遅延初期化(第三引数)から呼ぶことで、
 * マウントごとに1回だけ初期probeを決定する（Reactの仕様。複数インスタンスが
 * 同じ初期質問に固定される心配もない）。`dataset` はモジュールスコープの
 * 静的importなので引数は不要。
 */
export function init(): RawState {
  return {
    answers: {},
    askedKeys: [],
    rejected: [],
    questionsSinceReject: null,
    guess: null,
    confirmed: false,
    exhausted: false,
    probe: nextProbe(dataset, {}, new Set(), { exclude: new Set(), rng: Math.random }),
    history: [],
  };
}

export type Action =
  | { type: 'answer'; key: string; confidence: Confidence; recentGuessIds: readonly string[] }
  | { type: 'reject'; characterId: string; recentGuessIds: readonly string[] }
  | { type: 'confirm' }
  | { type: 'undo' }
  | { type: 'reset' };

export function reducer(state: RawState, action: Action): RawState {
  switch (action.type) {
    case 'answer': {
      const history = [...state.history, snapshotOf(state)];
      const answers: AnswerMap = { ...state.answers, [action.key]: action.confidence };
      const askedKeys = [...state.askedKeys, action.key];
      const rejectedSet = new Set(state.rejected);

      const askedSet = new Set(askedKeys);
      const probe = nextProbe(dataset, answers, askedSet, { exclude: rejectedSet, rng: Math.random });
      const scored = scoreCharacters(answers, dataset, { exclude: rejectedSet });

      // 「いいえ」後の再質問モード中は、最低問数と確信の回復を shouldReguess に委ねる
      // （1問だけ聞いて即答えを出す旧挙動をやめた。engine/recommend.ts の同関数のコメント参照）。
      if (state.questionsSinceReject !== null) {
        const questionsSinceReject = state.questionsSinceReject + 1;
        if (!shouldReguess(scored, questionsSinceReject, probe !== null)) {
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

      // probe===null（物理的に聞くべき質問が尽きた）なら MIN_QUESTIONS 未達でも
      // 推測へ進む — 存在しない質問を asking 画面に表示することはできないため。
      const goToGuessing = probe === null || shouldGuess(scored, askedKeys.length, probe !== null);

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
      const scored = scoreCharacters(state.answers, dataset, { exclude: rejectedSet });

      if (scored.length === 0) return { ...state, rejected, exhausted: true, probe: null, history };

      const askedSet = new Set(state.askedKeys);
      const bonusProbe = nextProbe(dataset, state.answers, askedSet, { exclude: rejectedSet, rng: Math.random });

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
      // ここで nextProbe を呼び直さない（呼び直すとタイブレークの
      // Math.random が再び振られ、undo前と違う質問に化けるバグの原因だった）。
      if (state.history.length === 0) return state;
      const prev = state.history[state.history.length - 1];
      const history = state.history.slice(0, -1);
      return { ...prev, history };
    }

    case 'reset':
      return init();

    default:
      return state;
  }
}

export type InterviewState =
  | {
      phase: 'asking';
      probe: Probe;
      askedCount: number;
      canUndo: boolean;
      answer(confidence: Confidence): void;
      undo(): void;
      reset(): void;
    }
  | { phase: 'guessing'; guess: Scored; canUndo: boolean; confirm(): void; reject(): void; undo(): void; reset(): void }
  | { phase: 'confirmed'; guess: Scored; reset(): void }
  | { phase: 'exhausted'; nearMisses: Scored[]; reset(): void };

/** answers を SessionLogRecord.answers の形（配列）に変換する。 */
function answersLogOf(answers: AnswerMap): SessionLogRecord['answers'] {
  return Object.entries(answers).map(([key, confidence]) => ({ key, confidence }));
}

export function useInterview(): InterviewState {
  const [state, dispatch] = useReducer(reducer, undefined, init);
  const { recentGuessIds, log } = useSessionLog();

  // 質問はもう毎レンダー導出しない。state.probe が「その時点で表示すべき質問」の
  // 確定値（reducer が各アクションの処理時に一度だけ確定させる。Snapshot型の
  // コメント参照）。classicには候補一覧(candidates)機能が無く rejectedSet の
  // 他の用途も無いため、旧probe導出用useMemoと一緒に削除した。
  const probe = state.probe;

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const canUndo = state.history.length > 0;

  const answer = useCallback(
    (confidence: Confidence) => {
      if (!probe) return;
      dispatch({ type: 'answer', key: probe.key, confidence, recentGuessIds });
    },
    [probe, recentGuessIds],
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
    });
    dispatch({ type: 'reject', characterId: state.guess.character.id, recentGuessIds });
  }, [state.guess, state.askedKeys, state.answers, state.rejected, recentGuessIds, log]);

  // 全滅は reducer 内部の判定結果でしか分からない（reject 実行時点では、
  // その reject が全滅を引き起こすかどうかを呼び出し側から先読みできない）ため、
  // 遷移後に副作用として記録する。exhausted が false の間は毎回 return するだけ
  // なので、実際に log が呼ばれるのは false→true になった瞬間の1回だけ
  // （reset するまで再び true にはならない）。
  useEffect(() => {
    if (!state.exhausted) return;
    log({
      ts: Date.now(),
      guessId: null,
      outcome: 'exhausted',
      askedCount: state.askedKeys.length,
      answers: answersLogOf(state.answers),
      rejectedIds: state.rejected,
    });
  }, [state.exhausted, state.askedKeys, state.answers, state.rejected, log]);

  if (state.exhausted) {
    const nearMisses = scoreCharacters(state.answers, dataset).slice(0, NEAR_MISS_COUNT);
    return { phase: 'exhausted', nearMisses, reset };
  }

  if (state.confirmed && state.guess) {
    return { phase: 'confirmed', guess: state.guess, reset };
  }

  // 再質問モード中（questionsSinceReject!==null）は、拒否済みの guess が残っていても
  // guessing 画面へは進まない——次の推測が確定するまで asking を続ける。
  if (state.questionsSinceReject === null && state.guess) {
    return { phase: 'guessing', guess: state.guess, canUndo, confirm, reject, undo, reset };
  }

  // asking: 通常の質問中、または「いいえ」後の再質問中。
  // probe が null になるのは reducer 側の事前チェックにより通常発生しないが、
  // 万一の不整合に備えて全滅画面へ安全側にフォールバックする。
  if (!probe) {
    const nearMisses = scoreCharacters(state.answers, dataset).slice(0, NEAR_MISS_COUNT);
    return { phase: 'exhausted', nearMisses, reset };
  }
  return { phase: 'asking', probe, askedCount: state.askedKeys.length, canUndo, answer, undo, reset };
}
