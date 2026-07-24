import { useCallback, useState } from 'react';

import type { Confidence } from '../engine/recommend';

/** e2e から参照する場合はこのキーと一致させること（useAgeConfirmation の作法に倣う）。 */
export const SESSION_LOG_KEY = 'chara-picker:session-log';

/** 保持する直近レコード数の上限。無限に肥大化させない。 */
const LOG_CAP = 100;

/** クールダウン判定に使う「直近」とみなす件数（重複排除後）。 */
const RECENT_COUNT = 5;

export type SessionLogRecord = {
  ts: number;
  /** 'exhausted'（全滅）は提示できるキャラが無いので null。 */
  guessId: string | null;
  outcome: 'confirmed' | 'rejected' | 'exhausted' | 'omakase';
  askedCount: number;
  answers: readonly { key: string; confidence: Confidence }[];
  rejectedIds: readonly string[];
  /** どちらのエンジンが生成したセッションか。省略時は 'classic'（旧レコードとの後方互換）。 */
  engine?: 'classic' | 'bayes';
};

function readLog(): SessionLogRecord[] {
  try {
    const raw = window.localStorage.getItem(SESSION_LOG_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SessionLogRecord[]) : [];
  } catch {
    // プライベートブラウジング等で localStorage が使えない、または保存内容が
    // 壊れている場合でもアプリ全体がクラッシュしないようにする（空履歴扱い）。
    return [];
  }
}

function writeLog(records: SessionLogRecord[]): void {
  try {
    window.localStorage.setItem(SESSION_LOG_KEY, JSON.stringify(records));
  } catch {
    // 保存できなくても today のセッションでは続行する（クールダウンが
    // 効かなくなるだけで、機能停止にはしない）。
  }
}

function recentGuessIdsOf(records: readonly SessionLogRecord[]): string[] {
  const ids: string[] = [];
  for (let i = records.length - 1; i >= 0 && ids.length < RECENT_COUNT; i -= 1) {
    const id = records[i].guessId;
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * ローカル開発中だけ、`state/session-logs/log.jsonl` にもレコードを送る
 * （`vite.config.ts` の `sessionLogDevPlugin` が受け取ってファイルに追記する）。
 * `import.meta.env.DEV` は本番ビルドで静的に `false` に置き換わり、この
 * ブロックごと dead code として消える —— GitHub Pages 等にデプロイした
 * dist には `fetch` 呼び出し自体が存在しない（D1 に影響しない）。
 * 失敗しても無視する（localStorage 側の記録・クールダウン機能は独立して動く）。
 */
function sendToDevLogFile(record: SessionLogRecord): void {
  if (!import.meta.env.DEV) return;
  fetch('/__session-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  }).catch(() => {});
}

export function useSessionLog(): { recentGuessIds: string[]; log(record: SessionLogRecord): void } {
  const [records, setRecords] = useState(readLog);

  // 書き込み直前に localStorage を読み直してからマージする。この hook は
  // useInterview 経由と App.tsx（おまかせ経路）の2箇所から独立に呼ばれるため、
  // 各インスタンスが自分の React state だけを頼りに書き込むと、片方の追記が
  // もう片方の追記を消してしまう（lost update）。ディスクの最新値を常に
  // 起点にすることでこれを避ける。
  const log = useCallback((record: SessionLogRecord) => {
    const next = [...readLog(), record].slice(-LOG_CAP);
    writeLog(next);
    setRecords(next);
    sendToDevLogFile(record);
  }, []);

  return { recentGuessIds: recentGuessIdsOf(records), log };
}
