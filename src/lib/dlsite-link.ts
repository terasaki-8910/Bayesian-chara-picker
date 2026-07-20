/**
 * DLsite 検索結果ページの URL を組み立てる。作品詳細ページ（`/product_id/`）は
 * 生成しない（SPEC 3: 著作物のサムネイル・タイトルへ直接誘導しない。
 * 検索結果一覧に留め、選ぶのはユーザー自身）。
 *
 * scripts/collect.mjs の buildSearchUrl とは実装を共有しない — アプリと
 * バッチは別プロセス（SPEC 2.2）。ただし同じ罠は独立に踏まえておく必要がある:
 * スペースは %20 ではなく + でエンコードする。このURLパス位置の %20 は
 * Cloudflare に 403 にされる（scripts/collect.mjs の既知の罠2と同一。実測済み）。
 * これを怠ると、ユーザー自身がリンクをクリックした瞬間に弾かれる。
 */
const SEARCH_BASE = 'https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male';

export function dlsiteSearchUrl(query: string): string {
  const encodedQuery = encodeURIComponent(query).replace(/%20/g, '+');
  return `${SEARCH_BASE}/keyword/${encodedQuery}/order/trend/per_page/30/page/1/`;
}
