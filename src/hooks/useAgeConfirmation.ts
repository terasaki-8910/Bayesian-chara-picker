import { useCallback, useState } from 'react';

/** e2e/helpers.ts の AGE_STORAGE_KEY と一致必須。 */
export const AGE_STORAGE_KEY = 'chara-picker:age-confirmed';

function readConfirmed(): boolean {
  try {
    return window.localStorage.getItem(AGE_STORAGE_KEY) === 'true';
  } catch {
    // プライベートブラウジング等で localStorage が使えない環境でも
    // アプリ全体がクラッシュしないようにする（未確認として扱う）。
    return false;
  }
}

export function useAgeConfirmation(): {
  confirmed: boolean;
  dismissed: boolean;
  confirm(): void;
  dismiss(): void;
} {
  const [confirmed, setConfirmed] = useState(readConfirmed);
  const [dismissed, setDismissed] = useState(false);

  const confirm = useCallback(() => {
    try {
      window.localStorage.setItem(AGE_STORAGE_KEY, 'true');
    } catch {
      // 保存できなくても today のセッションでは確認済みとして進める。
    }
    setConfirmed(true);
  }, []);

  // 閉じただけでは localStorage に書かない（F4 / F5 が縛る）。
  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  return { confirmed, dismissed, confirm, dismiss };
}
