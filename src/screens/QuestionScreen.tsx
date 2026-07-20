import type { Question } from '../engine/questions';

/**
 * Stage 2 design gate で承認した見た目（1 問 1 画面・縦リスト左揃え・
 * 選択中のみアクセント）を維持しつつ、wave 3 の `nextQuestion` が動的に選ぶ
 * 質問を props で受け取る型に作り替えた（旧: 固定 `QUESTIONS` 配列 + 自前
 * useState）。純粋なプレゼンテーション層 — 質問選択のロジックは持たない。
 */
export function QuestionScreen(props: {
  question: Question;
  index: number;
  total: number;
  selected: string | null;
  onAnswer(value: string | null): void;
  onOmakase(): void;
}) {
  const { question, index, total, selected, onAnswer, onOmakase } = props;

  return (
    <div data-testid="question" className="min-h-dvh bg-bg text-text-primary">
      <div className="mx-auto flex w-full max-w-(--layout-content-width) flex-col px-(--layout-page-padding) py-16">
        <p className="text-label tracking-label text-text-secondary tabular-nums uppercase">
          質問 {index} / {total}
        </p>

        <h1 className="mt-4 text-question font-question text-text-primary">{question.prompt}</h1>

        <div role="radiogroup" aria-label={question.label} className="mt-10 flex flex-col gap-2">
          {question.options.map((option) => {
            const isSelected = selected === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={isSelected}
                data-testid="answer-option"
                onClick={() => onAnswer(option.value)}
                className={[
                  'w-full rounded-control border-l-[3px] px-5 py-4 text-left text-option font-option',
                  'transition-colors focus-visible:outline focus-visible:outline-2',
                  'focus-visible:outline-offset-2 focus-visible:outline-accent',
                  isSelected
                    ? 'border-l-accent bg-accent/10 text-text-primary'
                    : 'border-l-transparent bg-surface text-text-primary hover:bg-surface-raised',
                ].join(' ')}
              >
                {option.label}
              </button>
            );
          })}

          <button
            type="button"
            role="radio"
            aria-checked={selected === null}
            data-testid="answer-no-preference"
            onClick={() => onAnswer(null)}
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

        <button
          type="button"
          data-testid="omakase"
          onClick={onOmakase}
          className={[
            'mt-10 self-start text-label text-text-tertiary underline-offset-4',
            'hover:text-text-secondary hover:underline focus-visible:outline focus-visible:outline-2',
            'focus-visible:outline-offset-2 focus-visible:outline-accent',
          ].join(' ')}
        >
          おまかせで見る
        </button>
      </div>
    </div>
  );
}
