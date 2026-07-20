export const SUPPLY_RANKS = ['なし', '僅少', '少ない', '十分', '豊富'] as const;

export type SupplyRank = (typeof SUPPLY_RANKS)[number];

/** DLsite の pageCount（30件/ページの検索結果ページ数）に対する閾値。 */
export function supplyRank(pageCount: number): SupplyRank {
  if (pageCount <= 0) return 'なし';
  if (pageCount === 1) return '僅少';
  if (pageCount <= 5) return '少ない';
  if (pageCount <= 20) return '十分';
  return '豊富';
}

/**
 * hitomi.la の galleryCount（作品単位の生カウント）に対する閾値。
 * DLsite の pageCount とは単位が違うため、同じ閾値を流用しない
 * （30件/ページ前提の換算根拠がなく、数値の意味が不透明になる）。
 * 実測値（2026-07-20）: 63〜893 件の範囲で分布。
 */
export function hitomiSupplyRank(galleryCount: number): SupplyRank {
  if (galleryCount <= 0) return 'なし';
  if (galleryCount <= 10) return '僅少';
  if (galleryCount <= 50) return '少ない';
  if (galleryCount <= 200) return '十分';
  return '豊富';
}

export function supplyRankIndex(rank: SupplyRank): number {
  return SUPPLY_RANKS.indexOf(rank);
}

/**
 * DLsite と hitomi.la の双方のランクのうち高い方を採用する。
 * どちらか一方に実在する供給が確認できれば「供給がある」とみなす
 * （SPEC: hitomi.la は DLsite で見つからないキャラの補完用途）。
 */
export function combinedSupplyRank(ranks: SupplyRank[]): SupplyRank {
  return ranks.reduce((best, r) => (supplyRankIndex(r) > supplyRankIndex(best) ? r : best), 'なし' as SupplyRank);
}
