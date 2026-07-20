import { useCallback, useState } from 'react';

import { dataset, useInterview } from './hooks/useInterview';
import { omakase, type Scored } from './engine/recommend';
import { GuessScreen } from './screens/GuessScreen';
import { NoGuessScreen } from './screens/NoGuessScreen';
import { QuestionScreen } from './screens/QuestionScreen';
import { ResultScreen } from './screens/ResultScreen';

export default function App() {
  const interview = useInterview();
  const [omakaseResult, setOmakaseResult] = useState<Scored | null>(null);

  const handleOmakase = useCallback(() => {
    // ローカル静的データのみで完結するため、実行時ネットワークは発生しない（D1）。
    setOmakaseResult(omakase(dataset, { seed: Date.now() }));
  }, []);

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
          onAnswer={interview.answer}
          onOmakase={handleOmakase}
        />
      );
    case 'guessing':
      return <GuessScreen guess={interview.guess} onConfirm={interview.confirm} onReject={interview.reject} />;
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
