import type { Page } from '@playwright/test';

/**
 * UI 側の DOM 契約。ACCEPTANCE F1-F6 / D1 を機械判定するために、
 * 実装はこの data-testid を必ず備えること。
 */
export const TESTID = {
  ageGate: 'age-gate',
  ageGateAccept: 'age-gate-accept',
  ageGateBackdrop: 'age-gate-backdrop',
  question: 'question',
  answerOption: 'answer-option',
  answerNoPreference: 'answer-no-preference',
  results: 'results',
  resultItem: 'result-item',
  resultTop: 'result-top',
  omakase: 'omakase',
} as const;

/** 年齢確認の localStorage キー（SPEC 2.5）。 */
export const AGE_STORAGE_KEY = 'chara-picker:age-confirmed';

/** localStorage を空にした状態でトップを開く（初回起動の再現）。 */
export async function openFresh(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
}

/** Tab だけで目的の要素までフォーカスを進める。到達できなければ F3 違反として落とす。 */
export async function tabTo(page: Page, selector: string, maxTabs = 80): Promise<void> {
  for (let i = 0; i < maxTabs; i += 1) {
    const onTarget = await page.evaluate(
      (sel) => document.activeElement?.matches(sel) ?? false,
      selector,
    );
    if (onTarget) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab のみで ${selector} に到達できません（F3 違反）`);
}

/** 年齢確認をキーボードだけで通す。 */
export async function acceptAgeGateByKeyboard(page: Page): Promise<void> {
  await tabTo(page, `[data-testid="${TESTID.ageGateAccept}"]`);
  await page.keyboard.press('Enter');
  await page.getByTestId(TESTID.ageGate).waitFor({ state: 'hidden' });
}

/**
 * 質問をキーボードだけで最後まで回答する。
 * 質問数は 6〜8 問（SPEC 2.4）なので上限に余裕を持たせる。
 */
export async function answerAllByKeyboard(page: Page, maxQuestions = 12): Promise<void> {
  for (let i = 0; i < maxQuestions; i += 1) {
    if (await page.getByTestId(TESTID.results).isVisible().catch(() => false)) return;
    if (!(await page.getByTestId(TESTID.question).isVisible().catch(() => false))) break;

    await tabTo(page, `[data-testid="${TESTID.answerOption}"]`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
  }
  await page.getByTestId(TESTID.results).waitFor({ state: 'visible' });
}
