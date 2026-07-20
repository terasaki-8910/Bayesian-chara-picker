import { supplyRankIndex, type SupplyRank } from '../engine/supply';

/** 表示上あり得る最大レベル。「なし」はハードフィルタで結果に出ないため、
 * 実質 僅少(1)〜豊富(4) の4段階しか見えない。 */
const MAX_LEVEL = 4;

/**
 * 供給量の視覚的な目盛り。アクセント色を使う3箇所のうちの1つ（design_brief）。
 * ランクは reasons に文言でも出るため、ここは完全に装飾（aria-hidden）にして
 * 二重に読み上げさせない。嗜好の一致より目立たせないよう、小さく地味に保つ。
 */
export function SupplyMeter(props: { rank: SupplyRank }) {
  const level = supplyRankIndex(props.rank);
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-0.5">
      {Array.from({ length: MAX_LEVEL }, (_, i) => (
        <span
          key={i}
          className={['h-1.5 w-3 rounded-full', i < level ? 'bg-accent' : 'bg-border'].join(' ')}
        />
      ))}
    </span>
  );
}
