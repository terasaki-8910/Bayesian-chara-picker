import { CharacterImage } from './CharacterImage';
import { profileEntriesFor } from '../engine/questions';
import type { AxisKey } from '../data/schema';
import type { Reason, Scored } from '../engine/recommend';

/**
 * 「このキャラを見せる」画面（推測確認・確定結果・おまかせ結果）に共通する中身。
 * GuessScreen と ResultScreen は枠（見出し・下部ボタン）だけが異なり、画像から
 * 根拠までの構成は同一のため、ここに一本化する（旧 wave 5 の
 * TopResult/OtherResult 分割がここでは不要になった — 単一結果になったため）。
 *
 * DLsite外部リンクと供給量表示は 2026-07-20 の指示で UI から削除した。
 * `reasons` はエンジン側では引き続き `kind:'supply'` を含むが、ここでは
 * `kind:'trait'` のみを表示する（供給量そのもの＝ハードフィルタ/タイブレークは
 * 変更なし。あくまで見せる/見せないの話。SPEC 2.5「UI に出さない情報」）。
 *
 * 表示は2段構成にする（2026-08-03）:
 *   1. 「はい」で一致した根拠 — なぜこのキャラが出たか
 *   2. プロフィール — 回答した質問に関係なく、そのキャラに格納されている属性
 * 2は「結局このキャラはどんなデータを持っているのか」が知りたい、という要望に
 * 応えるもの。1で既に見せた軸は2から除いて重複を避ける。
 */
export function CharacterReveal(props: { scored: Scored; imageTestId: string }) {
  const { character, reasons } = props.scored;
  const traitReasons = reasons.filter((r): r is Extract<Reason, { kind: 'trait' }> => r.kind === 'trait');
  const shownAxes = new Set<AxisKey>(traitReasons.map((r) => r.axis));
  const profile = profileEntriesFor(character, { exclude: shownAxes });

  return (
    <>
      <CharacterImage
        imagePath={character.imagePath}
        imageApproved={character.imageApproved}
        name={character.name}
        testId={props.imageTestId}
        className="mt-6"
      />

      <h1 className="mt-6 text-question font-question text-text-primary">{character.name}</h1>
      <p className="mt-1 text-option text-text-secondary">{character.series}</p>

      {traitReasons.length > 0 && (
        <ul
          data-testid="reveal-reasons"
          className="mt-4 flex flex-wrap justify-center gap-x-3 gap-y-1 text-label text-text-primary"
        >
          {traitReasons.map((reason, i) => (
            <li key={i}>
              {reason.label}: {reason.value}
            </li>
          ))}
        </ul>
      )}

      {profile.length > 0 && (
        <ul
          data-testid="reveal-profile"
          className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1 text-label text-text-secondary"
        >
          {profile.map((entry) => (
            <li key={entry.axis}>
              {entry.label}: {entry.values.join('・')}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
