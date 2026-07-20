import type { Scored } from '../engine/recommend';

/**
 * 全滅画面（PLAN 規則5）。「いいえ」を繰り返し、非拒否キャラが尽きた状態。
 * 「見つかりませんでした」で正直に伝えつつ、参考として近かった候補
 * （score上位。拒否済みキャラも含む）を簡易リストで示す — 確定案内ではない。
 */
export function NoGuessScreen(props: { nearMisses: readonly Scored[]; onRestart(): void }) {
  const { nearMisses, onRestart } = props;

  return (
    <div data-testid="no-guess" className="min-h-dvh bg-bg text-text-primary">
      <div className="mx-auto flex w-full max-w-(--layout-content-width) flex-col px-(--layout-page-padding) py-16">
        <h1 className="text-question font-question text-text-primary">見つかりませんでした</h1>
        <p className="mt-3 text-option text-text-secondary">
          回答に合うキャラを絞り込めませんでした。参考までに近かった候補です。
        </p>

        {nearMisses.length > 0 && (
          <div className="mt-8 rounded-control bg-surface px-6">
            {nearMisses.map((scored, i) => (
              <div
                key={scored.character.id}
                data-testid="no-guess-candidate"
                className="flex items-baseline justify-between gap-4 border-t border-border py-4 first:border-t-0"
              >
                <div className="min-w-0">
                  <p className="text-option font-option text-text-primary">{scored.character.name}</p>
                  <p className="text-label text-text-tertiary">{scored.character.series}</p>
                </div>
                <p className="shrink-0 text-label text-text-tertiary tabular-nums">{i + 1}</p>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          data-testid="restart"
          onClick={onRestart}
          className={[
            'mt-10 self-start rounded-control bg-accent px-5 py-3 text-option font-option text-(--color-accent-on)',
            'transition-colors hover:bg-accent-strong focus-visible:outline focus-visible:outline-2',
            'focus-visible:outline-offset-2 focus-visible:outline-accent',
          ].join(' ')}
        >
          最初からやり直す
        </button>
      </div>
    </div>
  );
}
