import { useState } from 'react';

/**
 * Stage 2 design gate: 質問画面の代表参照画面。
 * 1 問 1 画面 / 縦リスト・左揃え / アクセントは選択中の回答のみ、という
 * design_brief.md の方針をトークンだけで組む。データはダミーではなく
 * SPEC 2.3 の実軸（性格）をそのまま使う。
 */

const AXIS_LABEL = '性格の傾向';
const PROMPT = '性格の傾向は、どれに近いですか。';
const OPTIONS = ['クール', '元気', 'おっとり', '生意気', '内気', '姉御'] as const;

export function QuestionScreen() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div data-testid="question" className="min-h-dvh bg-bg text-text-primary">
      <div className="mx-auto flex w-full max-w-(--layout-content-width) flex-col px-(--layout-page-padding) py-16">
        <p className="text-label tracking-label text-text-secondary tabular-nums uppercase">
          質問 3 / 7
        </p>

        <h1 className="mt-4 text-question font-question text-text-primary">{PROMPT}</h1>

        <div role="radiogroup" aria-label={AXIS_LABEL} className="mt-10 flex flex-col gap-2">
          {OPTIONS.map((option) => {
            const isSelected = selected === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={isSelected}
                data-testid="answer-option"
                onClick={() => setSelected(option)}
                className={[
                  'w-full rounded-control border-l-[3px] px-5 py-4 text-left text-option font-option',
                  'transition-colors focus-visible:outline focus-visible:outline-2',
                  'focus-visible:outline-offset-2 focus-visible:outline-accent',
                  isSelected
                    ? 'border-l-accent bg-accent/10 text-text-primary'
                    : 'border-l-transparent bg-surface text-text-primary hover:bg-surface-raised',
                ].join(' ')}
              >
                {option}
              </button>
            );
          })}

          <button
            type="button"
            role="radio"
            aria-checked={selected === null}
            data-testid="answer-no-preference"
            onClick={() => setSelected(null)}
            className={[
              'mt-2 w-full rounded-control border-l-[3px] border-t px-5 pt-5 pb-4 text-left text-option',
              'border-t-border transition-colors focus-visible:outline focus-visible:outline-2',
              'focus-visible:outline-offset-2 focus-visible:outline-accent',
              selected === null
                ? 'border-l-accent bg-accent/10 text-text-primary'
                : 'border-l-transparent text-text-secondary hover:bg-surface-raised',
            ].join(' ')}
          >
            こだわらない
          </button>
        </div>
      </div>
    </div>
  );
}
