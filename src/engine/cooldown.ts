import { MARGIN_STOP, topGuess, type Scored } from './recommend';

/**
 * 「同じキャラばかり出る」という体感上の繰り返しを避けるための、topGuess の
 * ラッパー。エンジンのスコアリング自体（contribution 等）には一切触れない —
 * 純粋にどのタイ候補を採用するかだけを調整する。
 *
 * 安全性の要: 1位が MARGIN_STOP 以上リードしている（= shouldGuess が確信度十分と
 * 判断する差）場合は素通しで topGuess と同じ結果を返す。クールダウンは
 * 「僅差でどちらでもおかしくない」状況でだけ効かせ、確信度の高い推測を隠さない。
 */
export function pickGuessWithCooldown(
  scored: readonly Scored[],
  recentGuessIds: readonly string[],
  rng: () => number = Math.random,
): Scored {
  if (scored.length === 0) {
    throw new Error('pickGuessWithCooldown: scored は空にできない（survivors が空ならデータ不整合）');
  }

  const top = scored[0];
  // 僅差集団: 1位との差が MARGIN_STOP 未満の全員（1位自身を含む）。
  // 1位が独走している（誰も僅差圏内にいない）場合はここが1件だけになる。
  const band = scored.filter((s) => top.score - s.score < MARGIN_STOP);
  if (band.length <= 1) return topGuess(scored, rng);

  // 僅差集団の中でだけ、直近に見せたキャラを後回しにする。
  // 僅差集団全員が直近ガチャ済みなら、後回しにする意味がないので素直に選ぶ。
  const fresh = band.filter((s) => !recentGuessIds.includes(s.character.id));
  const pool = fresh.length > 0 ? fresh : band;

  return topGuess(pool, rng);
}
