import { useEffect, useRef, type KeyboardEvent } from 'react';

/**
 * 初回起動時の年齢確認。design_brief: 凝らない。単純・一度きり。
 * 唯一の操作は「はい」ボタン1つ。Escape・背景クリックの両方で軽い離脱ができる
 * （.claude/rules/ui.md のモーダル規約）。
 */
export function AgeGate(props: { open: boolean; onConfirm(): void; onDismiss(): void }) {
  const acceptRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (props.open) acceptRef.current?.focus();
  }, [props.open]);

  if (!props.open) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      props.onDismiss();
      return;
    }
    if (event.key === 'Tab') {
      // フォーカス対象がボタン1つだけなので、Tab / Shift+Tab のどちらでも
      // そこに留まらせる（凝らないフォーカストラップ）。
      event.preventDefault();
      acceptRef.current?.focus();
    }
  }

  return (
    // role="dialog" は jsx-a11y 上「非インタラクティブ」ロール扱いだが、
    // Escape で閉じる処理は正当な標準パターンなのでこの行だけ明示的に許可する。
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      data-testid="age-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="age-gate-title"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center p-(--layout-page-padding)"
    >
      {/* 背景クリックはマウスユーザー向けの軽い離脱手段。キーボード側は
          Escape（上の onKeyDown）と明示ボタンで既に担保している。この要素は
          意図的に非インタラクティブな装飾要素のままにする（フォーカス対象にしない）。 */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div data-testid="age-gate-backdrop" onClick={props.onDismiss} className="absolute inset-0 bg-bg/85" />

      <div className="relative w-full max-w-sm rounded-control bg-surface p-6">
        <h1 id="age-gate-title" className="text-question font-question text-text-primary">
          年齢確認
        </h1>
        <p className="mt-3 text-option text-text-secondary">18歳以上ですか?</p>

        <button
          ref={acceptRef}
          type="button"
          data-testid="age-gate-accept"
          onClick={props.onConfirm}
          className={[
            'mt-6 w-full rounded-control bg-accent px-5 py-3 text-option font-option text-(--color-accent-on)',
            'transition-colors hover:bg-accent-strong focus-visible:outline focus-visible:outline-2',
            'focus-visible:outline-offset-2 focus-visible:outline-accent',
          ].join(' ')}
        >
          はい、18歳以上です
        </button>
      </div>
    </div>
  );
}
