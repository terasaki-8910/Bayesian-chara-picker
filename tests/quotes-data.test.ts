import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { readJson } from './helpers/data';
import type { Character } from '../src/data/schema';

/**
 * 名台詞のデータ（data/quotes.json）の形と決まり。
 * サイトの同期スクリプトも同じ決まりで止まるので、ここで先に落とす（SPEC 2.7）。
 * ここに入っている台詞は、すべて公開してよいもの（確かめ中・保留の台詞は入れない）。
 */

/** 画面に大きく出すので、これを超える台詞は入れない。 */
const MAX_LENGTH = 60;
/** 1キャラあたりの上限。 */
const MAX_PER_CHARACTER = 3;
/** memory は記憶だけで入れた台詞（R13-1）。値を増やすときはサイトに伝える。 */
const CHECKED = ['verified', 'corrected', 'memory'] as const;

const quoteSchema = z
  .object({
    text: z.string().min(1),
    source: z.array(z.string().url()),
    checked: z.enum(CHECKED),
    // 強い言葉（殺す等）を含む台詞の印（R13-3）。サイトが後から出し分けに使う。
    harsh: z.literal(true).optional(),
  })
  .strict();

const quotesFileSchema = z
  .object({
    version: z.literal(1),
    characters: z.record(z.string(), z.array(quoteSchema).min(1).max(MAX_PER_CHARACTER)),
  })
  .strict();

type QuotesFile = z.infer<typeof quotesFileSchema>;

const characters = readJson<Character[]>('data/characters.json');
const quotes = readJson<QuotesFile>('data/quotes.json');

function eachQuote(fn: (id: string, q: QuotesFile['characters'][string][number]) => void) {
  for (const [id, list] of Object.entries(quotes.characters)) {
    for (const q of list) fn(id, q);
  }
}

describe('A18. 名台詞のデータ', () => {
  it('A18: スキーマ検証を通る（1体1〜3個、checked の値、余計な項目なし）', () => {
    const result = quotesFileSchema.safeParse(quotes);
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([]);
  });

  it('A18: キャラの id がすべて characters.json にある', () => {
    const ids = new Set(characters.map((c) => c.id));
    expect(Object.keys(quotes.characters).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('A18: キャラの id が昇順に並んでいる（差分を読みやすくするため）', () => {
    const keys = Object.keys(quotes.characters);
    expect(keys).toEqual([...keys].sort());
  });

  it(`A18: 台詞は前後の空白なし・${MAX_LENGTH}字まで・「」と改行と名前の穴（○○）を含まない・NFC`, () => {
    const bad: string[] = [];
    eachQuote((id, q) => {
      const t = q.text;
      if (t !== t.trim()) bad.push(`${id}: 前後に空白 "${t}"`);
      if ([...t].length > MAX_LENGTH) bad.push(`${id}: ${[...t].length}字 "${t}"`);
      if (/[「」\r\n]/.test(t)) bad.push(`${id}: 「」か改行を含む "${t}"`);
      // ゲームでプレイヤー名が入る穴（「○○P」など）はそのままでは台詞にならない。
      if (/[○〇●◯]{2}/.test(t)) bad.push(`${id}: 名前の穴を含む "${t}"`);
      if (t !== t.normalize('NFC')) bad.push(`${id}: NFC でない "${t}"`);
    });
    expect(bad).toEqual([]);
  });

  it('A18: 同じキャラに同じ台詞が重ならない', () => {
    const dup: string[] = [];
    for (const [id, list] of Object.entries(quotes.characters)) {
      const seen = new Set<string>();
      for (const q of list) {
        if (seen.has(q.text)) dup.push(`${id}: "${q.text}"`);
        seen.add(q.text);
      }
    }
    expect(dup).toEqual([]);
  });

  it('A18: Web で確かめた台詞（verified / corrected）は https の出どころを1つ以上持つ', () => {
    const bad: string[] = [];
    eachQuote((id, q) => {
      if (q.checked === 'memory') return;
      if (q.source.length === 0) bad.push(`${id}: 出どころが無い "${q.text}"`);
      for (const url of q.source) {
        if (!url.startsWith('https://')) bad.push(`${id}: https でない ${url}`);
        // 検索結果のページは、何が書いてあったか後から辿れないので出どころにしない。
        if (/^https:\/\/([a-z0-9-]+\.)*(google\.[a-z.]+\/search|bing\.com\/search|search\.yahoo\.co\.jp|duckduckgo\.com)/i.test(url)) {
          bad.push(`${id}: 検索結果のページ ${url}`);
        }
      }
    });
    expect(bad).toEqual([]);
  });
});
