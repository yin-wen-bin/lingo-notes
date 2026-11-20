type Area = {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};

/** Signed image URLs are short-lived credentials. Keep them in memory and renew before opening a full image. */
export class PrivateImageUrls {
  private fetchUrl: (recordId: string) => Promise<{url: string; expires_in: number}>;
  private origin: string;
  private now: () => number;
  private generation = 0;
  private cached: { recordId: string; url: string; expires: number } | null = null;
  constructor(fetchUrl: (recordId: string) => Promise<{url: string; expires_in: number}>, origin: string, now = Date.now) { this.fetchUrl = fetchUrl; this.origin = new URL(origin).origin; this.now = now; }
  clear() { ++this.generation; this.cached = null; }
  async get(recordId: string) {
    if (this.cached?.recordId === recordId && this.cached.expires > this.now() + 5000) return this.cached.url;
    const generation = this.generation, started = this.now(), result = await this.fetchUrl(recordId);
    if (generation !== this.generation) throw Error('SESSION_CHANGED');
    const url = new URL(result.url);
    if (url.origin !== this.origin || url.protocol !== 'https:') throw Error('IMAGE_URL_INVALID');
    const lifetime = Number.isFinite(result.expires_in) ? Math.max(0, Math.min(result.expires_in, 60)) : 0;
    this.cached = { recordId, url: url.href, expires: started + lifetime * 1000 }; return url.href;
  }
}

/** Browser-session drafts only. Serial writes prevent delayed context results from restoring a signed-out user's draft. */
export class PanelSessionState {
  private area: Area;
  private owner = 'guest';
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  constructor(area: Area) { this.area = area; }
  async switchOwner(owner: string | null, discardPrevious: boolean) {
    const previous = `panel:${this.owner}`; this.owner = owner ?? 'guest'; ++this.generation;
    const cleanup = this.pending.catch(() => {}).then(async () => { if (discardPrevious) await this.area.remove(previous); });
    this.pending = cleanup; await cleanup;
  }
  async get(keys?: string | string[]): Promise<Record<string, any>> {
    const key = `panel:${this.owner}`, generation = this.generation;
    await this.pending;
    const state = ((await this.area.get(key))[key] ?? {}) as Record<string, any>;
    if (generation !== this.generation) throw Error('SESSION_CHANGED');
    return keys ? Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(name => [name, state[name]])) : state;
  }
  private update(change: (state: Record<string, unknown>) => void) {
    const key = `panel:${this.owner}`, generation = this.generation;
    const task = this.pending.catch(() => {}).then(async () => {
      if (generation !== this.generation) return;
      const state = { ...((await this.area.get(key))[key] ?? {}) as Record<string, unknown> };
      if (generation !== this.generation) return;
      change(state); await this.area.set({ [key]: state });
    });
    this.pending = task; return task;
  }
  set(values: Record<string, unknown>) { return this.update(state => Object.assign(state, values)); }
  remove(keys: string | string[]) { return this.update(state => { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; }); }
}
