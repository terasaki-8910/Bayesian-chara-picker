import { CharacterImage } from './CharacterImage';
import { SupplyMeter } from './SupplyMeter';
import type { Reason, Scored } from '../engine/recommend';
import { dlsiteSearchUrl } from '../lib/dlsite-link';

function reasonText(reason: Reason): string {
  if (reason.kind === 'supply') return reason.label;
  return `${reason.label}: ${reason.value}`;
}

/**
 * 「このキャラを見せる」画面（推測確認・確定結果・おまかせ結果）に共通する中身。
 * GuessScreen と ResultScreen は枠（見出し・下部ボタン）だけが異なり、画像から
 * DLsiteリンクまでの構成は同一のため、ここに一本化する（旧 wave 5 の
 * TopResult/OtherResult 分割がここでは不要になった — 単一結果になったため）。
 */
export function CharacterReveal(props: { scored: Scored; imageTestId: string }) {
  const { character, reasons, supplyRank } = props.scored;

  return (
    <>
      <CharacterImage
        imagePath={character.imagePath}
        imageApproved={character.imageApproved}
        name={character.name}
        testId={props.imageTestId}
        className="mt-6"
      />

      <h1 className="mt-6 text-question font-question text-text-primary">{character.name}</h1>
      <p className="mt-1 text-option text-text-secondary">{character.series}</p>

      {reasons.length > 0 && (
        <ul className="mt-4 flex flex-wrap justify-center gap-x-3 gap-y-1 text-label text-text-secondary">
          {reasons.map((reason, i) => (
            <li key={i}>{reasonText(reason)}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-3">
        <SupplyMeter rank={supplyRank} />
        {character.dlsiteQuery !== null && (
          <a
            href={dlsiteSearchUrl(character.dlsiteQuery)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-label text-accent underline-offset-4 hover:text-(--color-accent-strong) hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            DLsiteで見る
          </a>
        )}
      </div>
    </>
  );
}
