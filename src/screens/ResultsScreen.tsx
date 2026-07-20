import { SupplyMeter } from '../components/SupplyMeter';
import type { Reason, Result } from '../engine/recommend';
import { dlsiteSearchUrl } from '../lib/dlsite-link';

function reasonText(reason: Reason): string {
  if (reason.kind === 'supply') return reason.label;
  return `${reason.label}: ${reason.value}`;
}

function ResultLink(props: { query: string | null }) {
  if (props.query === null) return null;
  return (
    <a
      href={dlsiteSearchUrl(props.query)}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 text-label text-accent underline-offset-4 hover:text-(--color-accent-strong) hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      DLsiteで見る
    </a>
  );
}

function ReasonList(props: { reasons: readonly Reason[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-label text-text-secondary">
      {props.reasons.map((reason, i) => (
        <li key={i}>{reasonText(reason)}</li>
      ))}
    </ul>
  );
}

/** 1位。主役として大きく扱う（design_brief: 順位に意味がある以上、視覚的重さも従わせる）。 */
function TopResult(props: { result: Result; rank: number }) {
  const { result, rank } = props;
  return (
    <div data-testid="result-top" className="rounded-control bg-surface p-6">
      <div data-testid="result-item" className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-label tabular-nums text-text-tertiary">{rank}</p>
          <h2 className="mt-1 text-question font-question text-text-primary">{result.character.name}</h2>
          <p className="mt-1 text-option text-text-secondary">{result.character.series}</p>
          <ReasonList reasons={result.reasons} />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-3">
          <ResultLink query={result.character.dlsiteQuery} />
          <SupplyMeter rank={result.supplyRank} />
        </div>
      </div>
    </div>
  );
}

/** 2位以下。簡素な行（design_brief）。 */
function OtherResult(props: { result: Result; rank: number }) {
  const { result, rank } = props;
  return (
    <div
      data-testid="result-item"
      className="flex items-start justify-between gap-4 border-t border-border py-4 first:border-t-0"
    >
      <div className="min-w-0">
        <p className="text-label tabular-nums text-text-tertiary">{rank}</p>
        <p className="mt-1 text-option font-option text-text-primary">{result.character.name}</p>
        <p className="text-label text-text-tertiary">{result.character.series}</p>
        <ReasonList reasons={result.reasons} />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <ResultLink query={result.character.dlsiteQuery} />
        <SupplyMeter rank={result.supplyRank} />
      </div>
    </div>
  );
}

export function ResultsScreen(props: { results: Result[]; onRestart(): void }) {
  const { results, onRestart } = props;
  const [top, ...rest] = results;

  return (
    <div data-testid="results" className="min-h-dvh bg-bg text-text-primary">
      <div className="mx-auto flex w-full max-w-(--layout-content-width) flex-col px-(--layout-page-padding) py-16">
        {results.length === 0 ? (
          <p className="text-option text-text-secondary">条件に合うキャラが見つかりませんでした。</p>
        ) : (
          <div className="flex flex-col gap-6">
            <TopResult result={top} rank={1} />
            {rest.length > 0 && (
              <div className="rounded-control bg-surface px-6">
                {rest.map((result, i) => (
                  <OtherResult key={result.character.id} result={result} rank={i + 2} />
                ))}
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onRestart}
          className={[
            'mt-10 self-start rounded-control bg-accent px-5 py-3 text-option font-option text-(--color-accent-on)',
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
