import { describe, expect, it } from 'vitest';

import { pickGuessWithCooldown } from '../src/engine/cooldown';
import { MARGIN_STOP, topGuess, type Scored } from '../src/engine/recommend';
import type { Character } from '../src/data/schema';

/** cooldown は character.id と score/supplyRank しか見ないため、最小限のスタブでよい。 */
function stub(id: string, score: number, supplyRank: Scored['supplyRank'] = '豊富'): Scored {
  return {
    character: { id } as unknown as Character,
    score,
    supplyRank,
    reasons: [],
  };
}

describe('pickGuessWithCooldown', () => {
  it('僅差（MARGIN_STOP未満）で直近ガチャ済みキャラと非直近キャラが並ぶ場合、非直近が選ばれる', () => {
    const scored = [stub('recent', 100), stub('fresh', 100 - (MARGIN_STOP - 1))];
    const result = pickGuessWithCooldown(scored, ['recent']);
    expect(result.character.id).toBe('fresh');
  });

  it('1位が MARGIN_STOP 以上リードしている場合、直近ガチャ済みでもそのまま選ばれる（確信度がクールダウンに勝つ）', () => {
    const scored = [stub('recent-leader', 100), stub('other', 100 - MARGIN_STOP)];
    const result = pickGuessWithCooldown(scored, ['recent-leader']);
    expect(result.character.id).toBe('recent-leader');
  });

  it('recentGuessIds が空なら topGuess と同じ結果になる', () => {
    const scored = [stub('a', 100), stub('b', 100 - (MARGIN_STOP - 5)), stub('c', 10)];
    const rng = () => 0.5;
    expect(pickGuessWithCooldown(scored, [], rng)).toEqual(topGuess(scored, rng));
  });

  it('僅差集団の全員が直近ガチャ済みでも、フォールバックして必ず何かを返す', () => {
    const scored = [stub('a', 100), stub('b', 100 - (MARGIN_STOP - 1))];
    expect(() => pickGuessWithCooldown(scored, ['a', 'b'])).not.toThrow();
    const result = pickGuessWithCooldown(scored, ['a', 'b']);
    expect(['a', 'b']).toContain(result.character.id);
  });

  it('scored が空なら例外を投げる', () => {
    expect(() => pickGuessWithCooldown([], [])).toThrow();
  });
});
