import { useCallback, useState } from 'react';

import { dataset, useInterview } from './hooks/useInterview';
import { useBayesInterview } from './hooks/useBayesInterview';
import { useSessionLog, type SessionLogRecord } from './hooks/useSessionLog';
import { omakase, type Scored } from './engine/recommend';
import type { Probe } from './engine/questions';
import { GuessScreen } from './screens/GuessScreen';
import { NoGuessScreen } from './screens/NoGuessScreen';
import { QuestionScreen } from './screens/QuestionScreen';
import { ResultScreen } from './screens/ResultScreen';

/** 現行（16軸ルールベース）エンジンのフロー。旧 App() 本体をそのまま移しただけで無改造。 */
function ClassicFlow() {
  const interview = useInterview();
  const { log } = useSessionLog();
  const [omakaseResult, setOmakaseResult] = useState<Scored | null>(null);

  const handleOmakase = useCallback(() => {
    // ローカル静的データのみで完結するため、実行時ネットワークは発生しない（D1）。
    const result = omakase(dataset, { seed: Date.now() });
    log({
      ts: Date.now(),
      guessId: result.character.id,
      outcome: 'omakase',
      askedCount: 0,
      answers: [],
      rejectedIds: [],
    });
    setOmakaseResult(result);
  }, [log]);

  const handleRestart = useCallback(() => {
    interview.reset();
    setOmakaseResult(null);
  }, [interview]);

  // おまかせは質問・推測ループを経ない独立経路（PLAN）。結果表示中は
  // interview 側の状態（質問の途中経過など）を無視して直接 result 画面へ出す。
  if (omakaseResult !== null) {
    return <ResultScreen result={omakaseResult} onRestart={handleRestart} />;
  }

  switch (interview.phase) {
    case 'asking':
      return (
        <QuestionScreen
          probe={interview.probe}
          askedCount={interview.askedCount}
          canUndo={interview.canUndo}
          onAnswer={interview.answer}
          onUndo={interview.undo}
          onOmakase={handleOmakase}
          onRestart={handleRestart}
        />
      );
    case 'guessing':
      return (
        <GuessScreen
          guess={interview.guess}
          canUndo={interview.canUndo}
          onConfirm={interview.confirm}
          onReject={interview.reject}
          onUndo={interview.undo}
          onRestart={handleRestart}
        />
      );
    case 'confirmed':
      return <ResultScreen result={interview.guess} onRestart={handleRestart} />;
    case 'exhausted':
      return <NoGuessScreen nearMisses={interview.nearMisses} onRestart={handleRestart} />;
    default: {
      // 型レベルの網羅性チェック。InterviewState に phase が増えたのにここへの
      // 分岐追加を忘れると、ここで型エラーとして検出される。
      const exhaustive: never = interview;
      throw new Error(`未知の phase: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * ベイズ推薦エンジンのフロー（?engine=bayes、試作・PLAN「ベイズ推薦エンジン試作」）。
 * ClassicFlowと画面コンポーネント（QuestionScreen/GuessScreen/ResultScreen/
 * NoGuessScreen）は完全に共用・無改造。omakaseもエンジン非依存で共用する。
 */
function BayesFlow() {
  const interview = useBayesInterview();
  const { log } = useSessionLog();
  const [omakaseResult, setOmakaseResult] = useState<Scored | null>(null);

  const handleOmakase = useCallback(() => {
    const result = omakase(dataset, { seed: Date.now() });
    const record: SessionLogRecord = {
      ts: Date.now(),
      guessId: result.character.id,
      outcome: 'omakase',
      askedCount: 0,
      answers: [],
      rejectedIds: [],
      engine: 'bayes',
    };
    log(record);
    setOmakaseResult(result);
  }, [log]);

  const handleRestart = useCallback(() => {
    interview.reset();
    setOmakaseResult(null);
  }, [interview]);

  if (omakaseResult !== null) {
    return <ResultScreen result={omakaseResult} onRestart={handleRestart} />;
  }

  switch (interview.phase) {
    case 'asking':
      return (
        <QuestionScreen
          // BayesProbe は {key, prompt, reason} で classic の Probe（key/axis/value/multi/prompt）
          // と形が異なるが、QuestionScreen が実際に描画で読むのは probe.prompt だけ
          // （axis/value/multi は classic 側の質問選択・スコアリング内部でしか使われない）。
          probe={interview.probe as unknown as Probe}
          askedCount={interview.askedCount}
          canUndo={interview.canUndo}
          onAnswer={interview.answer}
          onUndo={interview.undo}
          onOmakase={handleOmakase}
          onRestart={handleRestart}
        />
      );
    case 'guessing':
      return (
        <GuessScreen
          guess={interview.guess}
          canUndo={interview.canUndo}
          onConfirm={interview.confirm}
          onReject={interview.reject}
          onUndo={interview.undo}
          onRestart={handleRestart}
        />
      );
    case 'confirmed':
      return <ResultScreen result={interview.guess} onRestart={handleRestart} />;
    case 'exhausted':
      return <NoGuessScreen nearMisses={interview.nearMisses} onRestart={handleRestart} />;
    default: {
      const exhaustive: never = interview;
      throw new Error(`未知の phase: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * `?engine=bayes` を mount 時に1回だけ読んで分岐する（router不使用。既定は
 * classicのまま = 既存テスト・e2e無影響。PLAN「UI配線」）。
 */
function readEngineParam(): 'classic' | 'bayes' {
  return new URLSearchParams(window.location.search).get('engine') === 'bayes' ? 'bayes' : 'classic';
}

export default function App() {
  const [engine] = useState(readEngineParam);
  return engine === 'bayes' ? <BayesFlow /> : <ClassicFlow />;
}
