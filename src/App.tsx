import { useCallback, useState } from 'react';

import { useAgeConfirmation } from './hooks/useAgeConfirmation';
import { dataset, useInterview } from './hooks/useInterview';
import { omakase, recommend, type Result } from './engine/recommend';
import { AgeGate } from './screens/AgeGate';
import { QuestionScreen } from './screens/QuestionScreen';
import { ResultsScreen } from './screens/ResultsScreen';

export default function App() {
  const age = useAgeConfirmation();
  const interview = useInterview();
  const [omakaseResults, setOmakaseResults] = useState<Result[] | null>(null);

  const handleOmakase = useCallback(() => {
    // ローカル静的データのみで完結するため、実行時ネットワークは発生しない（D1）。
    setOmakaseResults(omakase(dataset, { seed: Date.now() }));
  }, []);

  const handleRestart = useCallback(() => {
    interview.reset();
    setOmakaseResults(null);
  }, [interview]);

  // F5: 未確認では質問も結果も一切描画しない。閉じただけ（dismissed）でも
  // 確認済みにはならないため、age-gate 自体を非表示にするだけで下の画面には
  // 進めない（何も描画しない空の状態になる）。
  if (!age.confirmed) {
    return <AgeGate open={!age.dismissed} onConfirm={age.confirm} onDismiss={age.dismiss} />;
  }

  if (omakaseResults !== null) {
    return <ResultsScreen results={omakaseResults} onRestart={handleRestart} />;
  }

  if (interview.question === null) {
    // 動的選択が終了 = 収束または上限到達。ここで初めて推薦を計算する。
    return <ResultsScreen results={recommend(interview.answers, dataset)} onRestart={handleRestart} />;
  }

  return (
    <QuestionScreen
      question={interview.question}
      index={interview.index}
      total={interview.total}
      selected={interview.answers[interview.question.axis] ?? null}
      onAnswer={interview.answer}
      onOmakase={handleOmakase}
    />
  );
}
