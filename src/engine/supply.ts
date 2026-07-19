export const SUPPLY_RANKS = ['なし', '僅少', '少ない', '十分', '豊富'] as const;

export type SupplyRank = (typeof SUPPLY_RANKS)[number];

export function supplyRank(pageCount: number): SupplyRank {
  if (pageCount <= 0) return 'なし';
  if (pageCount === 1) return '僅少';
  if (pageCount <= 5) return '少ない';
  if (pageCount <= 20) return '十分';
  return '豊富';
}

export function supplyRankIndex(rank: SupplyRank): number {
  return SUPPLY_RANKS.indexOf(rank);
}
