import { CharacterReveal } from '../components/CharacterReveal';
import type { Scored } from '../engine/recommend';

/**
 * 単一推測 + はい/いいえ確認（PLAN: Akinator実機と同じ「思い浮かべているのは○○、
 * はい/いいえ」の形）。複数候補を並べて選ばせる旧 wave 5 の設計は廃止した。
 */
export function GuessScreen(props: { guess: Scored; onConfirm(): void; onReject(): void; onRestart(): void }) {
  const { guess, onConfirm, onReject, onRestart } = props;

  return (
    <div data-testid="guess" className="min-h-dvh bg-bg text-text-primary">
      <div className="mx-auto flex w-full max-w-(--layout-content-width) flex-col items-center px-(--layout-page-padding) py-16 text-center">
        <p className="text-label tracking-label text-text-secondary uppercase">この子かな?</p>

        <CharacterReveal scored={guess} imageTestId="guess-image" />

        <div className="mt-10 flex w-full max-w-xs flex-col gap-3">
          <button
            type="button"
            data-testid="guess-confirm"
            onClick={onConfirm}
            className={[
              'w-full rounded-control bg-accent px-5 py-3 text-option font-option text-(--color-accent-on)',
              'transition-colors hover:bg-accent-strong focus-visible:outline focus-visible:outline-2',
              'focus-visible:outline-offset-2 focus-visible:outline-accent',
            ].join(' ')}
          >
            はい、この子です
          </button>
          <button
            type="button"
            data-testid="guess-reject"
            onClick={onReject}
            className={[
              'w-full rounded-control border border-border bg-surface px-5 py-3 text-option font-option text-text-primary',
              'transition-colors hover:bg-surface-raised focus-visible:outline focus-visible:outline-2',
              'focus-visible:outline-offset-2 focus-visible:outline-accent',
            ].join(' ')}
          >
            いいえ、違います
          </button>
        </div>

        <button
          type="button"
          data-testid="restart"
          onClick={onRestart}
          className={[
            'mt-6 text-label text-text-tertiary underline-offset-4',
            'hover:text-text-secondary hover:underline focus-visible:outline focus-visible:outline-2',
            'focus-visible:outline-offset-2 focus-visible:outline-accent',
          ].join(' ')}
        >
          最初からやり直す
        </button>
      </div>
    </div>
  );
}
