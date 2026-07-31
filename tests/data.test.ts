import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { charactersSchema, supplyFileSchema } from '../src/data/schema';
import { combinedSupplyRank, hitomiSupplyRank, supplyRank } from '../src/engine/supply';
import {
  AXIS_VALUES,
  MULTI_AXES,
  REQUIRED_AXES,
  readJson,
  type AxisKey,
} from './helpers/data';
import type { Character, SupplyFile } from '../src/data/schema';

const characters = readJson<Character[]>('data/characters.json');
const supply = readJson<SupplyFile>('data/supply.json');

describe('A. データ品質', () => {
  it('A1: characters.json の全レコードが zod スキーマ検証を通る', () => {
    const result = charactersSchema.safeParse(characters);
    // 失敗時にどのレコードのどの項目かが分かるようにする。
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([]);
  });

  it('A1: supply.json がスキーマ検証を通る', () => {
    const result = supplyFileSchema.safeParse(supply);
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([]);
  });

  it('A2: reviewed:false のレコードが 0 件（provisional は対象外）', () => {
    // provisional（公式デザイン未確定などで恒久的に reviewed:false のキャラ）は
    // 意図的な例外なので A2 では見ない。推薦から除外されることは C7 相当の
    // テストで別途縛る（SPEC 2.4 のハードフィルタ）。
    const unreviewed = characters.filter((c) => c.reviewed !== true && c.provisional !== true).map((c) => c.id);
    expect(unreviewed).toEqual([]);
  });

  it('A12: provisional なレコードは reviewed:false のまま（true と同時に立てない）', () => {
    // provisional は「レビューを保留する」宣言であって、reviewed:true と
    // 同時に立つと A2 の抜け穴として悪用できてしまう（review せずに出荷する手段になる）。
    const contradictions = characters.filter((c) => c.provisional === true && c.reviewed === true).map((c) => c.id);
    expect(contradictions).toEqual([]);
  });

  it('A3: id が一意', () => {
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const c of characters) {
      if (seen.has(c.id)) duplicated.push(c.id);
      seen.add(c.id);
    }
    expect(duplicated).toEqual([]);
  });

  it('A4: 全レコードに必須 4 軸が埋まっている', () => {
    const missing: string[] = [];
    for (const c of characters) {
      for (const axis of REQUIRED_AXES) {
        const value = c.axes[axis];
        if (value === null || value === undefined || value === '') {
          missing.push(`${c.id}.${axis}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('A5: 全軸の値が SPEC 2.3 の許容値リストに含まれる', () => {
    const invalid: string[] = [];
    const multi = new Set<string>(MULTI_AXES);
    for (const c of characters) {
      for (const axis of Object.keys(AXIS_VALUES) as AxisKey[]) {
        const allowed = AXIS_VALUES[axis] as readonly string[];
        const value = c.axes[axis];
        if (value === null || value === undefined) continue;
        if (multi.has(axis)) {
          expect(Array.isArray(value), `${c.id}.${axis} は配列であるべき`).toBe(true);
          for (const v of value as string[]) {
            if (!allowed.includes(v)) invalid.push(`${c.id}.${axis}="${v}"`);
          }
        } else {
          if (!allowed.includes(value as string)) invalid.push(`${c.id}.${axis}="${value}"`);
        }
      }
    }
    expect(invalid).toEqual([]);
  });

  it('A6: dlsiteQuery が null でないレコードは supply.json に対応エントリを持つ', () => {
    const orphans = characters
      .filter((c) => c.dlsiteQuery !== null)
      .filter((c) => supply[c.id] === undefined)
      .map((c) => c.id);
    expect(orphans).toEqual([]);
  });

  it('A6: hitomiQuery が null でないレコードは supply.json の対応エントリに hitomi 情報を持つ', () => {
    const orphans = characters
      .filter((c) => c.hitomiQuery !== null)
      .filter((c) => supply[c.id]?.hitomi == null)
      .map((c) => c.id);
    expect(orphans).toEqual([]);
  });

  it('A7: 出荷データに供給量ランク「なし」のキャラが 0 件（DLsite と hitomi.la の高い方で判定）', () => {
    const empty = characters
      .filter((c) => {
        const entry = supply[c.id];
        const dlsiteRank = supplyRank(entry?.pageCount ?? 0);
        const hitomiRank = entry?.hitomi ? hitomiSupplyRank(entry.hitomi.galleryCount) : 'なし';
        return combinedSupplyRank([dlsiteRank, hitomiRank]) === 'なし';
      })
      .map((c) => c.id);
    expect(empty).toEqual([]);
  });

  it('A8: supply.json の全エントリが ISO 8601 として解釈可能な fetchedAt を持つ', () => {
    const bad: string[] = [];
    for (const [id, entry] of Object.entries(supply)) {
      const at = entry.fetchedAt;
      if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
        bad.push(`${id}: ${String(at)}`);
        continue;
      }
      // Date.parse は "2026/07/20" 等も通すため、ISO 8601 の形も明示的に縛る。
      expect(at, `${id} の fetchedAt が ISO 8601 でない`).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
      );
    }
    expect(bad).toEqual([]);
  });

  it('段階 1 の完了条件: 実データが 30 体以上ある（SPEC 6）', () => {
    expect(characters.length).toBeGreaterThanOrEqual(30);
  });

  it('A9: 軸の値が NFC 正規化されている', () => {
    // 「グラマー」のような濁点付きカナは NFC と NFD で見た目が同じでもコードポイントが
    // 違い、片方が混入すると enum チェックが不可解に落ちる。入口で縛る。
    const denormalized: string[] = [];
    for (const c of characters) {
      for (const [axis, value] of Object.entries(c.axes)) {
        for (const s of Array.isArray(value) ? value : [value]) {
          if (typeof s === 'string' && s !== s.normalize('NFC')) {
            denormalized.push(`${c.id}.${axis}="${s}"`);
          }
        }
      }
    }
    expect(denormalized).toEqual([]);
  });

  it('A11: 各キャラが任意軸のうち 4 つ以上埋まっている', () => {
    // 必須 8 軸だけ埋めた薄いレコードで数だけ増やせないようにする歯止め。
    //
    // 「平均充足率」ではなく「1 体あたりの下限」にしているのは、平均だと
    // 濃い 36 体が薄い 500 体を覆い隠せてしまうため。下限なら 1 体でも
    // 薄ければ落ちる。
    //
    // 4 は現行 36 体の実測最小値（分布は 4:4件 / 5:10件 / 6:13件 / 7:9件）。
    // 到達不能な理想値ではなく、いま維持できている密度をそのまま床にしている。
    const OPTIONAL_AXES = [
      'roles',
      'distance',
      'looks',
      'skinTone',
      'outfit',
      'species',
      'mood',
      'affiliationName',
      'stature',
      'occupation',
    ] as const;
    const MIN_FILLED = 4;

    const thin: string[] = [];
    for (const c of characters) {
      const filled = OPTIONAL_AXES.filter((axis) => {
        const value = c.axes[axis];
        return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '';
      }).length;
      if (filled < MIN_FILLED) thin.push(`${c.id}(${filled})`);
    }
    expect(thin).toEqual([]);
  });

  it('A10: 男性キャラを新規追加していない（既存 2 件のみ許可）', () => {
    // SPEC 3: 男性キャラは推薦対象外。既存の 2 件はデータとしては残すが、
    // ここから増やさない（削除ではなくラチェットで縛る）。
    const GRANDFATHERED = ['aot-levi', 'onepiece-zoro'];
    const males = characters.filter((c) => c.axes.genderExpression === '男性').map((c) => c.id);
    expect(males.slice().sort()).toEqual(GRANDFATHERED.slice().sort());
  });

  it('A13: imagePath が設定されたレコードは public/character-images/ に実ファイルを持つ', () => {
    // ユーザーが手動で置く運用（SPEC 3）。パスだけ書いてファイルを置き忘れる事故を防ぐ。
    const missing: string[] = [];
    for (const c of characters) {
      if (c.imagePath === null) continue;
      const abs = fileURLToPath(new URL(`../public${c.imagePath}`, import.meta.url));
      if (!existsSync(abs)) missing.push(`${c.id}: ${c.imagePath}`);
    }
    expect(missing).toEqual([]);
  });

  it('A14: imageApproved:true は imagePath が設定されているときのみ成立する', () => {
    // zod の refine と二重化。ここが落ちたら refine 側の実装ミスも疑う。
    const contradictions = characters
      .filter((c) => c.imageApproved === true && c.imagePath === null)
      .map((c) => c.id);
    expect(contradictions).toEqual([]);
  });
});
