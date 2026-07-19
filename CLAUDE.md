# Project: random-chara-picker 

## What this is
抜けるキャラ、おかずになるキャラをユーザに提供し、今日のおかずを決める材料にする。ランダムと言いつつもアキネーター風にいくつかの質問を答えておすすめのキャラを聞けるようにしたい。例えば、女？おとこの娘?大人の女性？など。あくまで紳士向けのサイトを装いたいので、R18を連想する用語は控えるようにしたい。だが、用途としては今日おかずにするキャラを見つけるため。randomではないかも。あと、抜けるキャラを見つけるからもちろんおかずがないといけない。DLサイトとかにあるものが0だと意味がない。pixivを指標にするのはアリだけど基本pixivのR18数とDLSiteのR18数を比べるとDLSiteの方が少ないしDLSiteを基本みんな見る。将来的には、React 18 + Vite 5、スタイリングはTailwind CSSのwebサイトに移植できるようにする（正し、これに縛るわけではなくあなたが最良のものを使ってください。）。. Scope in SPEC.md; pass/fail criteria in ACCEPTANCE.md.

## Workflow
Driven by scripts/run.sh through gated stages (see pipeline.yaml). Do NOT skip gates.
Intake proposes per-project tools (MCP/plugins/skills): Claude proposes, I approve, I
run state/init-tools.sh myself. Never auto-install or enable tools.

## Language
Generated artifacts (code, comments, docs, commit messages, UI copy) default to 日本語.
Change here to override per project. The language I chat in is separate and unaffected.

## Commands
- Tests: npm test                    (Vitest — データ検証 / 収集パーサ / エンジン)
- Lint:  npm run lint                (ESLint + Stylelint + tsc --noEmit)
                                     no-emoji / design-tokens-only / a11y / 禁止語
- UI:    scripts/ui-check.sh         (Playwright + axe — レスポンシブ/コントラスト/キーボード操作)
- 収集:  npm run collect             (DLsite 収集バッチ。手動実行。ゲートには含めない —
                                     外部サイト依存をCIゲートに入れると DLsite 側の都合で
                                     ビルドが落ちるようになり、リペアループが自分では直せ
                                     ない失敗を延々と叩く。データはコミットして運用する。)

## UI rules
IMPORTANT: colors ONLY via design tokens; never hardcode hex. No emoji in UI or source.
Shared personal UI direction: @~/.claude/rules/ui.md

## Stack recipes
If the chosen stack matches a doc under docs/recipes/ (e.g. docs/recipes/
tauri-desktop-app.md for a Tauri + pnpm desktop app), read it during intake/design and
follow its documented patterns/gotchas -- each one there cost real debugging time on a
prior project, not guessed in advance. If personal shared-infrastructure notes exist at
~/.claude/rules/infra.md (e.g. a self-hosted DB server reused across projects), check
there too -- it stays out of this repo, never committed, since this template is public.

## Do not touch
state/ (runtime), design tokens (change only via the design gate), auto-generated files.

## Git
Local only by default; do NOT push unless asked. Feature branches merge to main with --no-ff.
