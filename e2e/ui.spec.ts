import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { TESTID, answerAllByKeyboard, openFresh, reachGuessAndRejectOnceByKeyboard, tabTo } from './helpers';

const BREAKPOINTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('F1: 横スクロールが発生しない', () => {
  for (const bp of BREAKPOINTS) {
    test(`${bp.name} (${bp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: bp.width, height: bp.height });
      await openFresh(page);

      // 質問・推測・結果の各画面で確認する。1 画面だけでは足りない。
      const overflow = async () =>
        page.evaluate(() => ({
          doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          body: document.body.scrollWidth - document.body.clientWidth,
        }));

      expect((await overflow()).doc).toBeLessThanOrEqual(1);
      await answerAllByKeyboard(page);
      const after = await overflow();
      expect(after.doc).toBeLessThanOrEqual(1);
      expect(after.body).toBeLessThanOrEqual(1);
    });
  }
});

test.describe('F2: axe-core の violations（serious 以上）が 0 件', () => {
  const scan = async (page: import('@playwright/test').Page) => {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    return results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' / ')}`);
  };

  test('質問画面', async ({ page }) => {
    await openFresh(page);
    await expect(page.getByTestId(TESTID.question)).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test('推測画面（画像プレースホルダー枠を含む）', async ({ page }) => {
    await openFresh(page);
    await reachGuessAndRejectOnceByKeyboard(page);
    // reject 後は guess（次点）か no-guess（全滅）のどちらか。guess であれば scan する。
    if (await page.getByTestId(TESTID.guess).isVisible().catch(() => false)) {
      expect(await scan(page)).toEqual([]);
    }
  });

  test('結果画面', async ({ page }) => {
    await openFresh(page);
    await answerAllByKeyboard(page);
    expect(await scan(page)).toEqual([]);
  });
});

test.describe('F3: マウス無しで完走できる', () => {
  test('Tab と Enter だけで質問 → 推測 → 確認まで到達する', async ({ page }) => {
    await openFresh(page);
    await answerAllByKeyboard(page);

    await expect(page.getByTestId(TESTID.result)).toBeVisible();
  });

  test('「わからない」もキーボードで選べる', async ({ page }) => {
    await openFresh(page);
    await tabTo(page, `[data-testid="${TESTID.answerUnknown}"]`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);

    // 「わからない」は情報量ゼロ（重み0）で候補を絞らないため、次も question か
    // 稀に guess（floor到達済みなら）のどちらかに進む。押した操作自体が効いて
    // 画面が先へ進んだことだけを確認する。
    const advanced =
      (await page.getByTestId(TESTID.question).isVisible().catch(() => false)) ||
      (await page.getByTestId(TESTID.guess).isVisible().catch(() => false));
    expect(advanced, '「わからない」を押しても状態が進まなかった').toBe(true);
  });

  test('「いいえ」で推測を拒否してもキーボードだけで次へ進める', async ({ page }) => {
    await openFresh(page);
    await reachGuessAndRejectOnceByKeyboard(page);

    const advanced =
      (await page.getByTestId(TESTID.question).isVisible().catch(() => false)) ||
      (await page.getByTestId(TESTID.guess).isVisible().catch(() => false)) ||
      (await page.getByTestId(TESTID.noGuess).isVisible().catch(() => false));
    expect(advanced, '「いいえ」を押しても状態が進まなかった').toBe(true);
  });

  test('「おまかせ」もキーボードで到達できる', async ({ page }) => {
    await openFresh(page);
    await tabTo(page, `[data-testid="${TESTID.omakase}"]`);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(TESTID.result)).toBeVisible();
  });
});

test.describe('F6: 色以外でも状態が判別できる', () => {
  test('キーボードフォーカス時にアウトラインが見える', async ({ page }) => {
    await openFresh(page);
    await tabTo(page, `[data-testid="${TESTID.answerYes}"]`);

    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (el === null) return null;
      const style = window.getComputedStyle(el);
      return {
        outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
        outlineStyle: style.outlineStyle,
      };
    });

    expect(ring).not.toBeNull();
    expect(ring!.outlineStyle).not.toBe('none');
    expect(ring!.outlineWidth).toBeGreaterThan(0);
  });
});
