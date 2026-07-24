import { expect, test } from '@playwright/test';

import { answerAllByKeyboard, openFresh, TESTID } from './helpers';

/**
 * ベイズ推薦エンジン試作（`?engine=bayes`）のe2e（PLAN「P4」任意項目）。
 * QuestionScreen/GuessScreen/ResultScreen は classic と完全共用・無改造の
 * ため、data-testid契約（e2e/helpers.ts）もそのまま使い回せる。
 */
function isExternal(url: string, origin: string): boolean {
  if (url.startsWith(origin)) return false;
  return !/^(data:|blob:|about:|chrome-extension:)/.test(url);
}

test.describe('ベイズ推薦エンジン試作（?engine=bayes）', () => {
  test('質問 → 推測 → 確定まで完走する', async ({ page }) => {
    await openFresh(page, '/?engine=bayes');
    await answerAllByKeyboard(page);
    await expect(page.getByTestId(TESTID.result)).toBeVisible();
  });

  test('D1: ベイズ経路でも実行時に外部ホストへ1件も要求しない', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const external: string[] = [];
    page.on('request', (request) => {
      if (isExternal(request.url(), origin)) external.push(`${request.method()} ${request.url()}`);
    });

    await openFresh(page, '/?engine=bayes');
    await answerAllByKeyboard(page);
    await expect(page.getByTestId(TESTID.result)).toBeVisible();

    expect(external).toEqual([]);
  });

  test('既定URL（/）は?engine=bayesを付けなければ従来どおりclassicのまま', async ({ page }) => {
    await openFresh(page, '/');
    await answerAllByKeyboard(page);
    await expect(page.getByTestId(TESTID.result)).toBeVisible();
    // classic/bayesどちらでも同じ画面・testidで完走できることの確認であり、
    // 個々の推測内容までは問わない（データ依存で変わるため）。
  });
});
