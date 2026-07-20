import { CONFIDENCE_LABEL, type Confidence, type Probe } from '../engine/questions';

/** Akinator実機の並び（はい→たぶんそう→わからない→たぶん違う→いいえ）をそのまま踏襲する。 */
const CONFIDENCE_ORDER: readonly Confidence[] = ['yes', 'probably_yes', 'unknown', 'probably_no', 'no'];

const TESTID_BY_CONFIDENCE: Record<Confidence, string> = {
  yes: 'answer-yes',
  probably_yes: 'answer-probably-yes',
  unknown: 'answer-unknown',
  probably_no: 'answer-probably-no',
  no: 'answer-no',
};

/**
 * 1プローブ1画面・回答は常に5段階（PLAN）。旧設計の「軸の選択肢を並べて1つ選ぶ」
 * 方式（`role="radiogroup"`で選択状態を持つ）から、「都度1問答えたら即座に次へ
 * 進む」一発アクション方式に変わったため、選択永続状態や`aria-checked`は持たない
 * （5つとも常に等価な操作ボタン。design_brief のアクセント使用箇所3限定を
 * 超えて拡張しない — 5択それぞれをホバー/フォーカス以外で強調しない）。
 */
export function QuestionScreen(props: {
  probe: Probe;
  askedCount: number;
  onAnswer(confidence: Confidence): void;
  onOmakase(): void;
  onRestart(): void;
}) {
  const { probe, askedCount, onAnswer, onOmakase, onRestart } = props;

  return (
    <div data-testid="question" className="min-h-dvh bg-bg text-text-primary">
      <div className="mx-auto flex w-full max-w-(--layout-content-width) flex-col px-(--layout-page-padding) py-16">
        <p className="text-label tracking-label text-text-secondary tabular-nums uppercase">
          {askedCount + 1}問目
        </p>

        <h1 className="mt-4 text-question font-question text-text-primary">{probe.prompt}</h1>

        <div role="group" aria-label="回答" className="mt-10 flex flex-col gap-2">
          {CONFIDENCE_ORDER.map((confidence) => (
            <button
              key={confidence}
              type="button"
              data-testid={TESTID_BY_CONFIDENCE[confidence]}
              onClick={() => onAnswer(confidence)}
              className={[
                'w-full rounded-control border-l-[3px] border-l-transparent bg-surface px-5 py-4',
                'text-left text-option font-option text-text-primary transition-colors',
                'hover:border-l-accent hover:bg-surface-raised focus-visible:outline focus-visible:outline-2',
                'focus-visible:outline-offset-2 focus-visible:outline-accent',
              ].join(' ')}
            >
              {CONFIDENCE_LABEL[confidence]}
            </button>
          ))}
        </div>

        <div className="mt-10 flex items-center gap-5">
          <button
            type="button"
            data-testid="omakase"
            onClick={onOmakase}
            className={[
              'text-label text-text-tertiary underline-offset-4',
              'hover:text-text-secondary hover:underline focus-visible:outline focus-visible:outline-2',
              'focus-visible:outline-offset-2 focus-visible:outline-accent',
            ].join(' ')}
          >
            おまかせで見る
          </button>
          <button
            type="button"
            data-testid="restart"
            onClick={onRestart}
            className={[
              'text-label text-text-tertiary underline-offset-4',
              'hover:text-text-secondary hover:underline focus-visible:outline focus-visible:outline-2',
              'focus-visible:outline-offset-2 focus-visible:outline-accent',
            ].join(' ')}
          >
            最初からやり直す
          </button>
        </div>
      </div>
    </div>
  );
}
