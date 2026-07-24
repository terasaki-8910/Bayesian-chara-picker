import type { Page } from '@playwright/test';

/**
 * UI 側の DOM 契約。ACCEPTANCE F1-F3/F6 / D1 を機械判定するために、
 * 実装はこの data-testid を必ず備えること。
 *
 * 質問1問1回答（answer-yes 等）・単一推測（guess）・確定/おまかせ結果（result）・
 * 全滅（no-guess）という Akinator 方式への転換に伴い、旧
 * `answerOption`/`answerNoPreference`/`results`/`resultItem`/`resultTop` は廃止した
 * （SPEC 2.4 の全面書き換えに追従）。年齢確認は 2026-07-20 に廃止したため
 * `ageGate`/`ageGateAccept`/`ageGateBackdrop` も無い（SPEC 2.5）。
 */
export const TESTID = {
  question: 'question',
  answerYes: 'answer-yes',
  answerProbablyYes: 'answer-probably-yes',
  answerUnknown: 'answer-unknown',
  answerProbablyNo: 'answer-probably-no',
  answerNo: 'answer-no',
  omakase: 'omakase',
  guess: 'guess',
  guessConfirm: 'guess-confirm',
  guessReject: 'guess-reject',
  guessImage: 'guess-image',
  guessImageUnapprovedBadge: 'guess-image-unapproved-badge',
  result: 'result',
  resultImage: 'result-image',
  noGuess: 'no-guess',
  noGuessCandidate: 'no-guess-candidate',
  restart: 'restart',
} as const;

/**
 * localStorage を空にした状態でトップを開く（初回起動の再現）。
 * `path` 省略時は既定エンジン（classic）の `/`。ベイズ試作の
 * `/?engine=bayes` を開く呼び出しにも同じヘルパーを使えるよう追加した引数
 * （既存呼び出しは無変更で動く）。
 */
export async function openFresh(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
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

/**
 * 質問に「はい」をキーボードだけで連打し、推測画面に到達したら「はい、この子
 * です」で確定して result 画面まで完走する。質問数は 6〜10 問
 * （SPEC 2.4 の MIN_QUESTIONS/HARD_CAP）なので上限に余裕を持たせる。
 */
export async function answerAllByKeyboard(page: Page, maxQuestions = 15): Promise<void> {
  for (let i = 0; i < maxQuestions; i += 1) {
    if (await page.getByTestId(TESTID.guess).isVisible().catch(() => false)) break;
    if (!(await page.getByTestId(TESTID.question).isVisible().catch(() => false))) break;

    await tabTo(page, `[data-testid="${TESTID.answerYes}"]`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
  }
  await page.getByTestId(TESTID.guess).waitFor({ state: 'visible' });

  await tabTo(page, `[data-testid="${TESTID.guessConfirm}"]`);
  await page.keyboard.press('Enter');
  await page.getByTestId(TESTID.result).waitFor({ state: 'visible' });
}

/**
 * 推測画面まで到達し、「いいえ、違います」で1回だけ拒否する（拒否ループの検証用）。
 * 拒否後は次点の推測（guess）か全滅（no-guess）のどちらかに遷移する —
 * データ依存でどちらに転ぶか一定でないため、呼び出し側が状態を見て判定する。
 */
export async function reachGuessAndRejectOnceByKeyboard(page: Page, maxQuestions = 15): Promise<void> {
  for (let i = 0; i < maxQuestions; i += 1) {
    if (await page.getByTestId(TESTID.guess).isVisible().catch(() => false)) break;
    if (!(await page.getByTestId(TESTID.question).isVisible().catch(() => false))) break;

    await tabTo(page, `[data-testid="${TESTID.answerYes}"]`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
  }
  await page.getByTestId(TESTID.guess).waitFor({ state: 'visible' });

  await tabTo(page, `[data-testid="${TESTID.guessReject}"]`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
}
