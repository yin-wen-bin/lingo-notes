import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, canReadOnDevice } from './cloud';
import { clearStoredReading, readStoredReading, READING_RETENTION_MS, writeStoredReading } from './readingDisk';
import type { StoredReading } from './readingDisk';
import { mergeReviewState } from './useReviewActions';
import type { LearningRecord, RecordItem, ReviewBatch, ReviewState, Settings } from './types';

const FRESH_MS = 60_000;
export type HistoryWindow = { items: RecordItem[]; has_more: boolean; nextOffset: number };
type Entry<T = unknown> = {
  value?: T;
  checkedAt?: number;
  savedAt?: number;
  loading?: boolean;
  error?: unknown;
};

export const historyKey = (query: string) => `history:${query}`;
export const recordKey = (recordId: string) => `record:${recordId}`;
export const pointKey = (recordId: string, revision: number) => `points:${recordId}:${revision}`;
export const reviewKey = (batchId: string | null, day: string) => batchId ? `batch:${batchId}` : `today:${day}`;
const durable = (key: string) => !key.startsWith('points:') && key !== 'settings';

export function beijingDate(time = Date.now()) {
  return new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
}
function safeRecord(value: LearningRecord): LearningRecord {
  const {record_id, revision, local_date, text, input_type, status, original_text, corrected_text, recognized_text, context, source, image, result} = value;
  return {
    record_id, revision, local_date, text, input_type, status, original_text, corrected_text, recognized_text, context, source, result,
    image: image ? { mime_type: image.mime_type, width: image.width, height: image.height } : null
  };
}
export async function readRecord(recordId: string) {
  const record = await api<LearningRecord | null>('records.get', { record_id: recordId });
  return record ? safeRecord(record) : null;
}
export async function readReview(batchId: string | null, day: string) {
  const {batch} = await api<{batch: ReviewBatch | null}>(batchId ? 'review.get' : 'review.today', batchId ? {batch_id:batchId} : {});
  if (!batch || (!batchId && batch.local_date !== day)) return null;
  const {id, local_date, cards, opened_at} = batch;
  return {id, local_date, cards, opened_at};
}
export async function readHistory(query: string, before?: HistoryWindow, more = false): Promise<HistoryWindow> {
  const items = new Map((more ? before?.items ?? [] : []).map(item => [item.record_id, item]));
  let nextOffset = more ? before?.nextOffset ?? 0 : 0;
  let has_more: boolean;
  do {
    const page = await api<{items:RecordItem[];has_more:boolean}>('records.history', {query, offset:nextOffset});
    for (const {record_id, revision, local_date, text, input_type, status, has_image} of page.items) {
      items.set(record_id,{record_id, revision, local_date, text, input_type, status, has_image});
    }
    nextOffset += page.items.length;
    has_more = Boolean(page.has_more && page.items.length);
  } while (!more && has_more && nextOffset < (before?.nextOffset ?? 0));
  return {items:[...items.values()], has_more, nextOffset};
}

export class ReadingCache {
  private readonly entries = new Map<string, Entry>();
  private readonly readers = new Set<() => void>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly opened = new Set<string>();
  private hydration?: Promise<void>;
  private closed = false;

  constructor(private readonly owner: string) {}

  private allowed = () => !this.closed && canReadOnDevice(this.owner);
  subscribe = (reader: () => void) => {
    this.readers.add(reader);
    return () => { this.readers.delete(reader); };
  };
  private emit() { for (const reader of this.readers) reader(); }
  view<T>(key: string) { return this.allowed() ? this.entries.get(key) as Entry<T> | undefined : undefined; }

  private restore() {
    this.hydration ??= readStoredReading(this.owner, this.allowed).then(rows => {
      if (!this.allowed()) return;
      for (const {key, value, savedAt} of rows) {
        if (!this.entries.has(key)) this.entries.set(key, {value, checkedAt:0, savedAt});
      }
      this.emit();
    }).catch(() => { /* Unavailable storage leaves the in-memory and online reading paths intact. */ });
    return this.hydration;
  }

  private persist(keys: string[], removed: string[] = []) {
    const rows: StoredReading[] = [];
    for (const key of keys) {
      if (!durable(key)) continue;
      const row = this.entries.get(key);
      if (row?.savedAt && row.value != null) {
        rows.push({owner:this.owner, key, savedAt:row.savedAt, checkedAt:row.checkedAt ?? 0, value:row.value});
      } else removed.push(key);
    }
    if (rows.length || removed.length) {
      void writeStoredReading(this.owner, rows, removed, this.allowed).catch(() => {});
    }
  }

  read<T>(key: string, loader: () => Promise<T>, force = false): Promise<void> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    let work!: Promise<void>;
    work = (async () => {
      await this.restore();
      if (!this.allowed() || this.pending.get(key) !== work) return;
      let earlier = this.view<T>(key);
      const now = Date.now();
      if (earlier?.savedAt && now - earlier.savedAt >= READING_RETENTION_MS) {
        earlier = undefined;
        this.entries.delete(key);
        this.persist([], [key]);
        this.emit();
      }
      if (!navigator.onLine) {
        if (!earlier) { this.entries.set(key, {error:new Error('NETWORK_ERROR')}); this.emit(); }
        return;
      }
      if (!force && earlier?.checkedAt && now - earlier.checkedAt < FRESH_MS) return;
      this.entries.set(key, {...earlier, loading:true, error:undefined});
      this.emit();
      try {
        const received = await loader();
        if (!this.allowed() || this.pending.get(key) !== work) return;
        if (key.startsWith('record:') && received === null) this.removeRecord(key.slice('record:'.length));
        const stamp = Date.now();
        // JSON responses may be new objects while the reading surface is unchanged.
        const value = JSON.stringify(earlier?.value) === JSON.stringify(received) ? earlier?.value : received;
        this.entries.set(key, {value, savedAt:stamp, checkedAt:stamp});
        this.persist([key]);
      } catch (error) {
        if (this.allowed() && this.pending.get(key) === work) {
          this.entries.set(key, {...earlier, loading:false, error});
        }
      } finally { this.emit(); }
    })();
    this.pending.set(key, work);
    void work.then(() => { if (this.pending.get(key) === work) this.pending.delete(key); });
    return work;
  }

  async closeAndClear() {
    this.closed = true;
    this.pending.clear();
    this.entries.clear();
    this.emit();
    await clearStoredReading(this.owner).catch(() => {});
  }

  markOpened(batch: ReviewBatch) {
    if (batch.opened_at || this.opened.has(batch.id) || !navigator.onLine || !this.allowed()) return;
    this.opened.add(batch.id);
    void api('review.opened', {batch_id:batch.id}).catch(() => { this.opened.delete(batch.id); });
  }

  patchSettings(change: Partial<Settings>) {
    const saved = this.view<Settings>('settings')?.value;
    if (!this.allowed() || !saved) return;
    this.pending.delete('settings');
    this.entries.set('settings', {value:{...saved, ...change}, checkedAt:Date.now()});
    this.emit();
  }

  removeRecord(recordId: string) {
    if (!this.allowed()) return;
    const updated: string[] = [], removed: string[] = [];
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith('history:') || key.startsWith('today:') || key.startsWith('batch:') || key === recordKey(recordId) || key.startsWith(`points:${recordId}:`)) {
        this.pending.delete(key);
      }
    }
    for (const [key, entry] of this.entries) {
      if (key === recordKey(recordId) || key.startsWith(`points:${recordId}:`)) {
        this.entries.delete(key);
        removed.push(key);
      } else if (key.startsWith('history:')) {
        const history = entry.value as HistoryWindow | undefined;
        if (history) {
          const items = history.items.filter(item => item.record_id !== recordId);
          this.entries.set(key, {...entry, value:{...history, items}, checkedAt:0, loading:false});
          updated.push(key);
        } else this.entries.delete(key);
      } else if (key.startsWith('today:') || key.startsWith('batch:')) {
        const batch = entry.value as ReviewBatch | null | undefined;
        if (batch) {
          this.entries.set(key, {...entry, value:{...batch, cards:batch.cards.filter(card => card.record_id !== recordId)}, checkedAt:0, loading:false});
          updated.push(key);
        } else this.entries.delete(key);
      }
    }
    this.persist(updated, removed);
    this.emit();
  }

  applyReview(state: ReviewState, completedBatch?: string) {
    if (!this.allowed()) return;
    const updated: string[] = [];
    for (const key of [...this.pending.keys()]) {
      if (/^(today|batch|points):/.test(key)) this.pending.delete(key);
    }
    for (const [key, entry] of this.entries) {
      if (key.startsWith('today:') || key.startsWith('batch:')) {
        const batch = entry.value as ReviewBatch | null | undefined;
        if (!batch) { if (entry.loading) this.entries.delete(key); continue; }
        const change = completedBatch && completedBatch !== batch.id ? {...state, reviewed:undefined, completed_at:undefined} : state;
        this.entries.set(key, {...entry, value:{...batch, cards:batch.cards.map(card => mergeReviewState(card, change))}, checkedAt:0, loading:false});
        updated.push(key);
      } else if (key.startsWith('points:')) {
        const points = entry.value as Parameters<typeof mergeReviewState>[0][] | undefined;
        if (points) this.entries.set(key, {...entry, value:points.map(card => mergeReviewState(card, state)), checkedAt:0, loading:false});
        else if (entry.loading) this.entries.delete(key);
      }
    }
    this.persist(updated);
    this.emit();
  }
}

export function useReading<T>(cache: ReadingCache, key: string, load: () => Promise<T>, refresh: number, enabled = true) {
  const [retry, setRetry] = useState(0);
  const usedRetry = useRef(0);
  const usedRefresh = useRef(refresh);
  const entry = useSyncExternalStore(cache.subscribe, () => cache.view<T>(key));
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    if (enabled) {
      const force = retry !== usedRetry.current || refresh !== usedRefresh.current;
      usedRetry.current = retry;
      usedRefresh.current = refresh;
      void cache.read(key, latest.current, force);
    }
  }, [cache, key, refresh, retry, enabled]);
  return {entry, retry: useCallback(() => setRetry(value => value + 1), [])};
}

export function useReadingRefresh() {
  const [refresh, setRefresh] = useState(0);
  const changed = useCallback(() => setRefresh(value => value + 1), []);
  useEffect(() => {
    let last = 0;
    let timer: number;
    const visible = () => {
      const now = Date.now();
      if (!document.hidden && now - last >= 500) { last = now; changed(); }
    };
    const reconnect = () => { last = Date.now(); changed(); };
    const schedule = () => {
      const day = beijingDate();
      const morning = Date.parse(day + 'T07:00:00+08:00');
      const midnight = Date.parse(day + 'T00:00:00+08:00') + 86400_000;
      timer = window.setTimeout(() => { changed(); schedule(); }, Math.max(25, (Date.now() < morning ? morning : midnight) - Date.now() + 10));
    };
    schedule();
    window.addEventListener('focus', visible);
    window.addEventListener('pageshow', visible);
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', visible);
      window.removeEventListener('pageshow', visible);
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [changed]);
  return {refresh, changed, day:beijingDate()};
}
