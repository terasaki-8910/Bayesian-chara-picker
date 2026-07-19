import { describe, expect, it } from 'vitest';

import { charactersSchema, supplyFileSchema } from '../src/data/schema';
import { supplyRank } from '../src/engine/supply';
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

  it('A2: reviewed:false のレコードが 0 件', () => {
    const unreviewed = characters.filter((c) => c.reviewed !== true).map((c) => c.id);
    expect(unreviewed).toEqual([]);
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

  it('A7: 出荷データに供給量ランク「なし」のキャラが 0 件', () => {
    const empty = characters
      .filter((c) => supplyRank(supply[c.id]?.pageCount ?? 0) === 'なし')
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
});
