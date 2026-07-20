import { CharacterReveal } from '../components/CharacterReveal';
import type { Scored } from '../engine/recommend';

/**
 * 確定済み推測（GuessScreen で「はい」した後）と、おまかせ結果の両方で使う
 * 終着画面（PLAN: 単一結果用に書き換え。`ResultsScreen`から改名）。
 */
export function ResultScreen(props: { result: Scored; onRestart(): void }) {
  const { result, onRestart } = props;

  return (
    <div data-testid="result" className="min-h-dvh bg-bg text-text-primary">
      <div className="mx-auto flex w-full max-w-(--layout-content-width) flex-col items-center px-(--layout-page-padding) py-16 text-center">
        <p className="text-label tracking-label text-text-secondary uppercase">今日のおすすめ</p>

        <CharacterReveal scored={result} imageTestId="result-image" />

        <button
          type="button"
          data-testid="restart"
          onClick={onRestart}
          className={[
            'mt-10 rounded-control bg-accent px-5 py-3 text-option font-option text-(--color-accent-on)',
            'transition-colors hover:bg-accent-strong focus-visible:outline focus-visible:outline-2',
            'focus-visible:outline-offset-2 focus-visible:outline-accent',
          ].join(' ')}
        >
          もう一度選ぶ
        </button>
      </div>
    </div>
  );
}
