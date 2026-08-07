import { describe, expect, it } from 'vitest';

import likelihoodsData from '../data/bayes/likelihoods.json';
import questionsRuntimeData from '../data/bayes/questions.runtime.json';
import { initBayesData, type LikelihoodsFile, type QuestionsRuntimeFile } from '../src/engine/bayes';
import type { Dataset } from '../src/engine/recommend';
import * as bayesHook from '../src/hooks/useBayesInterview';
import * as classicHook from '../src/hooks/useInterview';
import { readJson } from './helpers/data';

/**
 * useBayesInterview.ts / useInterview.ts の undo バグの回帰テスト。
 *
 * 症状（サイト側ユーザー報告）: 「一つ前の回答に戻る」を押すと、undo前に
 * 表示されていた質問ではなく別の質問が表示される。
 *
 * 原因: 表示中の質問(probe)を `answers`/`askedKeys` から毎回
 * `nextProbe(..., { rng: Math.random })` で再導出していたため、undoで
 * 「以前訪れたのと同じ answers/askedKeys」に巻き戻っても、タイブレークの
 * Math.random が再び振られて別の質問が選ばれることがあった。
 *
 * 修正: probe を state（Snapshot）へ一度だけ確定させ、undo はそれをそのまま
 * 復元する（再導出しない）ようにした。ここでは reducer を直接叩き、
 * 「answer → answer → undo」で undo直後のprobeが直前の答え時点のprobeと
 * 一致することを確認する。
 */

initBayesData(likelihoodsData as unknown as LikelihoodsFile, questionsRuntimeData as unknown as QuestionsRuntimeFile);

const characters = readJson('data/characters.json') as Dataset['characters'];
const supply = readJson('data/supply.json') as Dataset['supply'];
const dataset: Dataset = { characters, supply };

describe('useBayesInterview の reducer: undoの決定性', () => {
  it('answer→answer→undo で、undo直後のprobeが直前(1問目回答後)のprobeと一致する', () => {
    const s0 = bayesHook.init(dataset);
    expect(s0.probe).not.toBeNull();
    const firstProbeKey = s0.probe!.key;

    const s1 = bayesHook.reducer(s0, {
      type: 'answer',
      key: firstProbeKey,
      confidence: 'probably_yes',
      recentGuessIds: [],
      dataset,
    });
    // 1問目回答後、2問目が出ているはず（全滅・即推測でない前提。実データなら通常はここ）。
    if (s1.probe === null) return; // データの偶然でここに来ても回帰対象外（下のケースで別途拾う）
    const secondProbeKey = s1.probe.key;
    expect(secondProbeKey).not.toBe(firstProbeKey);

    const s2 = bayesHook.reducer(s1, {
      type: 'answer',
      key: secondProbeKey,
      confidence: 'probably_no',
      recentGuessIds: [],
      dataset,
    });

    const s3 = bayesHook.reducer(s2, { type: 'undo' });
    // undo直後は「2問目回答直前」の状態に戻るはずなので、probeはsecondProbeKeyと一致する。
    expect(s3.probe?.key).toBe(secondProbeKey);
    expect(s3.askedKeys).toEqual([firstProbeKey]);
  });

  it('複数回試行しても非決定性が再発しない(20回)', () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const s0 = bayesHook.init(dataset);
      if (s0.probe === null) continue;
      const key0 = s0.probe.key;
      const s1 = bayesHook.reducer(s0, {
        type: 'answer',
        key: key0,
        confidence: 'yes',
        recentGuessIds: [],
        dataset,
      });
      if (s1.probe === null) continue;
      const key1 = s1.probe.key;
      const s2 = bayesHook.reducer(s1, {
        type: 'answer',
        key: key1,
        confidence: 'unknown',
        recentGuessIds: [],
        dataset,
      });
      const s3 = bayesHook.reducer(s2, { type: 'undo' });
      expect(s3.probe?.key).toBe(key1);
    }
  });
});

describe('useInterview(classic) の reducer: undoの決定性', () => {
  it('answer→answer→undo で、undo直後のprobeが直前(1問目回答後)のprobeと一致する', () => {
    const s0 = classicHook.init();
    expect(s0.probe).not.toBeNull();
    const firstProbeKey = s0.probe!.key;

    const s1 = classicHook.reducer(s0, {
      type: 'answer',
      key: firstProbeKey,
      confidence: 'probably_yes',
      recentGuessIds: [],
    });
    if (s1.probe === null) return;
    const secondProbeKey = s1.probe.key;

    const s2 = classicHook.reducer(s1, {
      type: 'answer',
      key: secondProbeKey,
      confidence: 'probably_no',
      recentGuessIds: [],
    });

    const s3 = classicHook.reducer(s2, { type: 'undo' });
    expect(s3.probe?.key).toBe(secondProbeKey);
    expect(s3.askedKeys).toEqual([firstProbeKey]);
  });
});
