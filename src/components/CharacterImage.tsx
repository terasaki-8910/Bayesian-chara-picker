/**
 * キャラ画像の表示枠。`imagePath` はユーザー本人が合法的に所持・作成した画像への
 * 相対パス（`public/character-images/` に手動配置。DLsite/hitomi 等の第三者画像は
 * 同梱しない方針は不変 — SPEC 3）。
 *
 * 画像が未設定でも枠自体は常に表示する（ユーザー決定事項）。設定済みだが
 * 未承認（`imageApproved !== true`）の場合は、固定位置（右上）に「承認前」
 * バッジを重ねる — 可変高さの行で操作系を相対中央に置くと崩れるため、
 * バッジは常に同じ角に固定する（.claude/rules/ui.md の可変高さ行ルールに合わせる）。
 */
export function CharacterImage(props: {
  imagePath: string | null;
  imageApproved: boolean;
  name: string;
  testId: string;
  badgeTestId?: string;
  className?: string;
}) {
  const { imagePath, imageApproved, name, testId, className } = props;
  const badgeTestId = props.badgeTestId ?? `${testId}-unapproved-badge`;
  const showUnapprovedBadge = imagePath !== null && !imageApproved;

  return (
    <div
      data-testid={testId}
      className={[
        'relative aspect-[3/4] w-full max-w-56 shrink-0 overflow-hidden rounded-control bg-surface',
        className ?? '',
      ].join(' ')}
    >
      {imagePath !== null ? (
        <img src={imagePath} alt={name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center" aria-hidden="true">
          <span className="text-caption text-text-tertiary">画像未設定</span>
        </div>
      )}

      {showUnapprovedBadge && (
        <span
          data-testid={badgeTestId}
          className="absolute top-2 right-2 rounded-control bg-bg/85 px-2 py-1 text-caption text-text-secondary"
        >
          承認前
        </span>
      )}
    </div>
  );
}
