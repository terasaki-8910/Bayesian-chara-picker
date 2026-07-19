import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  AGE_STORAGE_KEY,
  TESTID,
  acceptAgeGateByKeyboard,
  answerAllByKeyboard,
  openFresh,
  tabTo,
} from './helpers';

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

      // 年齢確認・質問・結果の各画面で確認する。1 画面だけでは足りない。
      const overflow = async () =>
        page.evaluate(() => ({
          doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          body: document.body.scrollWidth - document.body.clientWidth,
        }));

      expect((await overflow()).doc).toBeLessThanOrEqual(1);
      await acceptAgeGateByKeyboard(page);
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

  test('年齢確認画面', async ({ page }) => {
    await openFresh(page);
    expect(await scan(page)).toEqual([]);
  });

  test('質問画面', async ({ page }) => {
    await openFresh(page);
    await acceptAgeGateByKeyboard(page);
    await expect(page.getByTestId(TESTID.question)).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test('結果画面', async ({ page }) => {
    await openFresh(page);
    await acceptAgeGateByKeyboard(page);
    await answerAllByKeyboard(page);
    expect(await scan(page)).toEqual([]);
  });
});

test.describe('F3: マウス無しで完走できる', () => {
  test('Tab と Enter だけで質問から結果まで到達する', async ({ page }) => {
    await openFresh(page);
    await acceptAgeGateByKeyboard(page);
    await answerAllByKeyboard(page);

    await expect(page.getByTestId(TESTID.results)).toBeVisible();
    await expect(page.getByTestId(TESTID.resultItem).first()).toBeVisible();
  });

  test('「こだわらない」もキーボードで選べる', async ({ page }) => {
    await openFresh(page);
    await acceptAgeGateByKeyboard(page);
    await tabTo(page, `[data-testid="${TESTID.answerNoPreference}"]`);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(TESTID.question)).toBeVisible();
  });

  test('「おまかせ」もキーボードで到達できる', async ({ page }) => {
    await openFresh(page);
    await acceptAgeGateByKeyboard(page);
    await tabTo(page, `[data-testid="${TESTID.omakase}"]`);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(TESTID.results)).toBeVisible();
  });
});

test.describe('F4: モーダルが Escape と背景クリックの両方で閉じる', () => {
  test('Escape で閉じる', async ({ page }) => {
    await openFresh(page);
    await expect(page.getByTestId(TESTID.ageGate)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(TESTID.ageGate)).toBeHidden();
  });

  test('背景クリックで閉じる', async ({ page }) => {
    await openFresh(page);
    await expect(page.getByTestId(TESTID.ageGate)).toBeVisible();
    await page.getByTestId(TESTID.ageGateBackdrop).click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId(TESTID.ageGate)).toBeHidden();
  });

  test('閉じただけでは確認済みにならない（F5 との整合）', async ({ page }) => {
    await openFresh(page);
    await page.keyboard.press('Escape');
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), AGE_STORAGE_KEY);
    expect(stored).not.toBe('true');
  });
});

test.describe('F5: 年齢確認を通さずに結果画面へ到達できない', () => {
  test('未確認では結果が表示されない', async ({ page }) => {
    await openFresh(page);
    await expect(page.getByTestId(TESTID.ageGate)).toBeVisible();
    await expect(page.getByTestId(TESTID.results)).toBeHidden();
    await expect(page.getByTestId(TESTID.question)).toBeHidden();
  });

  test('モーダルを閉じてから操作しても結果へ抜けられない', async ({ page }) => {
    await openFresh(page);
    await page.keyboard.press('Escape');
    for (let i = 0; i < 30; i += 1) await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(TESTID.results)).toBeHidden();
  });

  test('確認済みフラグは localStorage に保持される', async ({ page }) => {
    await openFresh(page);
    await acceptAgeGateByKeyboard(page);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), AGE_STORAGE_KEY)).toBe('true');

    await page.reload();
    await expect(page.getByTestId(TESTID.ageGate)).toBeHidden();
  });
});

test.describe('F6: 色以外でも状態が判別できる', () => {
  test('キーボードフォーカス時にアウトラインが見える', async ({ page }) => {
    await openFresh(page);
    await tabTo(page, `[data-testid="${TESTID.ageGateAccept}"]`);

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

  test('選択中の回答が色以外の手段でも示される', async ({ page }) => {
    await openFresh(page);
    await acceptAgeGateByKeyboard(page);
    // 選択状態は aria-checked / aria-pressed / aria-selected のいずれかで表明すること。
    const option = page.getByTestId(TESTID.answerOption).first();
    const exposed = await option.evaluate((el) =>
      ['aria-checked', 'aria-pressed', 'aria-selected'].some((attr) => el.hasAttribute(attr)),
    );
    expect(exposed, '選択状態が支援技術に伝わらない（色だけで表現されている）').toBe(true);
  });
});
