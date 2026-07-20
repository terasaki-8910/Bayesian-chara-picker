import { expect, test } from '@playwright/test';

import { answerAllByKeyboard, openFresh, TESTID } from './helpers';

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
    await answerAllByKeyboard(page);
    await expect(page.getByTestId(TESTID.result)).toBeVisible();

    expect(external).toEqual([]);
  });
});
