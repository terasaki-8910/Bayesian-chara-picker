import { expect, test } from '@playwright/test';

import { acceptAgeGateByKeyboard, answerAllByKeyboard, openFresh, TESTID } from './helpers';

/** 自オリジンおよびブラウザ内で完結するスキームは外部アクセスではない。 */
function isExternal(url: string, origin: string): boolean {
  if (url.startsWith(origin)) return false;
  return !/^(data:|blob:|about:|chrome-extension:)/.test(url);
}

test.describe('D1: 実行時の外部ネットワークアクセスが 0 件', () => {
  test('起動から結果表示まで外部ホストへ 1 件も要求しない', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const external: string[] = [];

    page.on('request', (request) => {
      if (isExternal(request.url(), origin)) external.push(`${request.method()} ${request.url()}`);
    });

    await openFresh(page);
    await acceptAgeGateByKeyboard(page);
    await answerAllByKeyboard(page);
    await expect(page.getByTestId(TESTID.result)).toBeVisible();

    expect(external).toEqual([]);
  });

  test('結果画面の外部リンクは href のみで、遷移も取得もしない', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const external: string[] = [];
    page.on('request', (request) => {
      if (isExternal(request.url(), origin)) external.push(request.url());
    });

    await openFresh(page);
    await acceptAgeGateByKeyboard(page);
    await answerAllByKeyboard(page);

    const links = page.getByTestId(TESTID.result).locator('a[href^="http"]');
    const count = await links.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const link = links.nth(i);
      // 外部リンクは新規タブ + rel 指定。クリックしても現在の文脈は汚さない。
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
      // 検索結果ページのみ。作品詳細ページは同梱も参照もしない（SPEC 3）。
      const href = await link.getAttribute('href');
      expect(href).toContain('/fsr/');
      expect(href).not.toContain('/product_id/');
    }

    expect(external).toEqual([]);
  });
});
