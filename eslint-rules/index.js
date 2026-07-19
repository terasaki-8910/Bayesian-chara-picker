/**
 * プロジェクト固有の ESLint 規則（ACCEPTANCE E1 / E2 / E4）。
 *
 * いずれもソーステキスト全体を走査する。AST ノード（文字列リテラル / JSXText）
 * だけを見る実装にすると、コメントや識別子に紛れた違反を取りこぼすため。
 */

/** 絵文字。© ® ™ は Extended_Pictographic に含まれるが記号として正当なので除外する。 */
const EMOJI_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/gu;
const EMOJI_ALLOW = new Set(['©', '®', '™']);

/** 色リテラル。hex / rgb() / hsl() / oklch() などの関数記法。 */
const COLOR_RE =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/g;

/** ソーステキスト上の絶対 index から報告する共通ヘルパ。 */
function reportAt(context, index, messageId, data) {
  const sourceCode = context.sourceCode;
  context.report({
    loc: sourceCode.getLocFromIndex(index),
    messageId,
    data,
  });
}

/** E1: src/ に絵文字を 1 文字も置かない。 */
const noEmoji = {
  meta: {
    type: 'problem',
    docs: { description: 'ソース中の絵文字を禁止する（ACCEPTANCE E1）' },
    schema: [],
    messages: {
      found: '絵文字は使用できません（U+{{code}}）。テキストまたはアイコンに置き換えてください。',
    },
  },
  create(context) {
    return {
      Program() {
        const text = context.sourceCode.getText();
        for (const match of text.matchAll(EMOJI_RE)) {
          if (EMOJI_ALLOW.has(match[0])) continue;
          const code = match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
          reportAt(context, match.index, 'found', { code });
        }
      },
    };
  },
};

/** E2: デザイントークン以外で色リテラルを書かない。 */
const noLiteralColor = {
  meta: {
    type: 'problem',
    docs: { description: '色リテラルの直書きを禁止する（ACCEPTANCE E2）' },
    schema: [],
    messages: {
      found:
        '色リテラル "{{literal}}" は直書きできません。@theme のデザイントークン経由で参照してください。',
    },
  },
  create(context) {
    return {
      Program() {
        const text = context.sourceCode.getText();
        for (const match of text.matchAll(COLOR_RE)) {
          reportAt(context, match.index, 'found', { literal: match[0] });
        }
      },
    };
  },
};

/** E4: 禁止語リストの語を UI コピー / ソースに出さない。語リストは設定ファイル外出し。 */
const noForbiddenTerms = {
  meta: {
    type: 'problem',
    docs: { description: '禁止語の使用を禁止する（ACCEPTANCE E4）' },
    schema: [
      {
        type: 'object',
        properties: {
          terms: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['terms'],
        additionalProperties: false,
      },
    ],
    messages: {
      found: '禁止語 "{{term}}" は使用できません。事務的な語彙（作品数 / 傾向 / 相性）に置き換えてください。',
    },
  },
  create(context) {
    const terms = context.options[0]?.terms ?? [];
    if (terms.length === 0) return {};
    // 長い語を先に見て、短い語の部分一致で報告位置がぶれるのを防ぐ。
    const sorted = [...terms].sort((a, b) => b.length - a.length);
    return {
      Program() {
        const text = context.sourceCode.getText();
        const haystack = text.toLowerCase();
        for (const term of sorted) {
          const needle = term.toLowerCase();
          let from = 0;
          for (;;) {
            const index = haystack.indexOf(needle, from);
            if (index === -1) break;
            reportAt(context, index, 'found', { term });
            from = index + needle.length;
          }
        }
      },
    };
  },
};

export default {
  meta: { name: 'chara-picker-local' },
  rules: {
    'no-emoji': noEmoji,
    'no-literal-color': noLiteralColor,
    'no-forbidden-terms': noForbiddenTerms,
  },
};
