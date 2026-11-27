import type { CloudEvent, CloudSession, LearningRecord, SessionStorage } from './cloud-types';
export type { CloudEvent, CloudSession, LearningRecord, SessionStorage } from './cloud-types';

export class CloudError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 0) { super(code); this.name = 'CloudError'; this.code = code; this.status = status; }
}

type Options = { url: string; publishableKey: string; storage?: SessionStorage; fetch?: typeof fetch };
const locks = new Map<string, Promise<unknown>>();
const safeCode = (value: unknown, fallback: string) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) ? value : fallback;
const sessionValid = (value: any): value is CloudSession => !!value && typeof value.access_token === 'string' && typeof value.refresh_token === 'string' && Number.isFinite(value.expires_at) && typeof value.user?.id === 'string';

/** Shared browser client. Storage contains sessions and non-secret authentication flow markers,
 * never passwords, recovery token hashes, model keys or learning content.
 * start() is a single billable POST. A dropped stream must be recovered with records.get, never replayed automatically.
 * onEvent is awaited in stream order, including accepted before progress/complete. */
export function cloudSessionKey(url: string) {
  return `lingo-session:${url.replace(/\/$/, '')}`;
}
export function createCloudClient(options: Options) {
  const url = options.url.replace(/\/$/, '');
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const storageKey = cloudSessionKey(url);
  const setupKey = `lingo-password-setup:${url}`;
  const attemptKey = `lingo-auth-attempt:${url}`;
  const memory = new Map<string, string>();
  const storage: SessionStorage = options.storage ?? { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); } };
  const listeners = new Set<(session: CloudSession | null) => void>();
  const active = new Set<AbortController>();
  let epoch = 0;
  function configured() { if (!options.publishableKey || !/^https:\/\//.test(url)) throw new CloudError('CLOUD_NOT_CONFIGURED'); }
  async function readSession(): Promise<CloudSession | null> {
    try { const raw = await storage.getItem(storageKey); const value = raw ? JSON.parse(raw) : null; return sessionValid(value) ? value : null; } catch { return null; }
  }
  async function saveSession(session: CloudSession | null) {
    if (session) await storage.setItem(storageKey, JSON.stringify(session)); else await storage.removeItem(storageKey);
    for (const listener of listeners) { try { listener(session); } catch { /* An observer must not break authentication. */ } }
  }
  async function locked<T>(run: () => Promise<T>, purpose = 'refresh'): Promise<T> {
    const name = `${storageKey}:${purpose}`;
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(name, run);
    const previous = locks.get(name) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run); locks.set(name, next);
    try { return await next; } finally { if (locks.get(name) === next) locks.delete(name); }
  }
  async function auth(path: string, body: unknown, token?: string, method = 'POST') {
    configured();
    let response: Response;
    try { response = await transport(`${url}/auth/v1/${path}`, { method, headers: { apikey: options.publishableKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }); }
    catch { throw new CloudError('NETWORK_ERROR'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new CloudError(response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'AUTH_UNAVAILABLE' : 'AUTH_FAILED', response.status);
    return data;
  }
  async function getSession(): Promise<CloudSession | null> {
    const first = await readSession();
    if (!first || first.expires_at > Date.now() / 1000 + 90) return first;
    return locked(async () => {
      const session = await readSession();
      if (!session || session.expires_at > Date.now() / 1000 + 90) return session;
      const generation = epoch;
      try {
        const data = await auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
        if (generation !== epoch) return null;
        const next = normalizeSession(data);
        return locked(async () => {
          const current = await readSession();
          if (generation !== epoch || !current) return null;
          if (current.user.id !== session.user.id || current.refresh_token !== session.refresh_token) throw new CloudError('SESSION_CHANGED');
          await saveSession(next); return next;
        }, 'identity');
      } catch (error) {
        if (error instanceof CloudError && error.status >= 400 && error.status < 500 && error.status !== 429) await locked(async () => {
          const current = await readSession();
          if (generation === epoch && current?.user.id === session.user.id && current.refresh_token === session.refresh_token) { await storage.removeItem(setupKey); await saveSession(null); }
        }, 'identity');
        throw error;
      }
    });
  }
  function normalizeSession(data: any): CloudSession {
    const session = { ...data, expires_at: data.expires_at ?? Math.floor(Date.now() / 1000) + data.expires_in };
    if (!sessionValid(session)) throw new CloudError('AUTH_INVALID_RESPONSE');
    return { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at, user: { id: session.user.id, email: session.user.email } };
  }
  async function setupRequired(session?: CloudSession | null) {
    const current = session === undefined ? await readSession() : session;
    return !!current && await storage.getItem(setupKey) === current.user.id;
  }
  async function beginIdentityChange() {
    const generation = ++epoch, intent = crypto.randomUUID();
    for (const controller of active) controller.abort();
    await locked(async () => {
      if (generation !== epoch) throw new CloudError('AUTH_CANCELLED');
      await storage.setItem(attemptKey, intent);
      await storage.removeItem(setupKey); await saveSession(null);
    }, 'identity');
    return { generation, intent };
  }
  async function discardAttempt(attempt: { generation: number; intent: string }) {
    return locked(async () => {
      if (attempt.generation !== epoch || await storage.getItem(attemptKey) !== attempt.intent) return false;
      await storage.removeItem(attemptKey); return true;
    }, 'identity');
  }
  async function commitIdentity(session: CloudSession, attempt: { generation: number; intent: string }, setup: boolean) {
    return locked(async () => {
      if (attempt.generation !== epoch || await storage.getItem(attemptKey) !== attempt.intent) throw new CloudError('AUTH_CANCELLED');
      if (setup) await storage.setItem(setupKey, session.user.id); else await storage.removeItem(setupKey);
      await storage.removeItem(attemptKey);
      await saveSession(session); return session;
    }, 'identity');
  }
  async function post(action: string, params: unknown, requestId: string, signal: AbortSignal) {
    configured(); const session = await getSession(); if (!session) throw new CloudError('LOGIN_REQUIRED');
    if (await setupRequired(session)) throw new CloudError('PASSWORD_SETUP_REQUIRED');
    const requestEpoch = epoch;
    let response: Response;
    try { response = await transport(`${url}/functions/v1/app-api`, { method: 'POST', headers: { apikey: options.publishableKey, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' }, body: JSON.stringify({ action, params, request_id: requestId }), signal }); }
    catch { throw new CloudError(signal.aborted ? 'REQUEST_DISCONNECTED' : 'NETWORK_ERROR'); }
    // Do not retry an app POST after a 401: it may already have started a chargeable operation.
    if (response.status === 401) {
      let invalidated = false;
      await locked(async () => {
        const current = await readSession();
        if (epoch === requestEpoch && current?.user.id === session.user.id && current?.access_token === session.access_token) { ++epoch; invalidated = true; await storage.removeItem(setupKey); await saveSession(null); }
      }, 'identity');
      throw new CloudError(invalidated ? 'AUTH_EXPIRED' : 'SESSION_CHANGED', 401);
    }
    return response;
  }
  async function unwrap(response: Response) {
    const data = await response.json().catch(() => { throw new CloudError('INVALID_RESPONSE'); });
    if (!response.ok || !data?.ok) throw new CloudError(safeCode(data?.error?.code ?? data?.error, response.status === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED'), response.status);
    return data.result;
  }
  async function call<T = any>(action: string, params: unknown = {}, requestId: string = crypto.randomUUID()): Promise<T> {
    const controller = new AbortController(), generation = epoch; active.add(controller);
    try { const result = await unwrap(await post(action, params, requestId, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]))); if (generation !== epoch || controller.signal.aborted) throw new CloudError('SESSION_CHANGED'); return result; }
    finally { active.delete(controller); }
  }
  async function start(action: string, params: unknown, requestId: string, onEvent: (event: CloudEvent) => void | Promise<void>, options: { signal?: AbortSignal } = {}): Promise<LearningRecord> {
    const controller = new AbortController(); active.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(130000), ...(options.signal ? [options.signal] : [])]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await post(action, params, requestId, signal);
      if (!response.headers.get('Content-Type')?.includes('text/event-stream')) { const record = await unwrap(response); if (signal.aborted) throw new CloudError('REQUEST_DISCONNECTED'); return record; }
      if (!response.ok || !response.body) throw new CloudError('INVALID_RESPONSE');
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '', complete: LearningRecord | undefined;
      async function dispatch(frame: string) {
        if (signal.aborted) throw new CloudError('REQUEST_DISCONNECTED');
        let type = '', data = '';
        for (const line of frame.split(/\r?\n/)) { if (line.startsWith('event:')) type = line.slice(6).trim(); else if (line.startsWith('data:')) data += `${line.slice(5).trimStart()}\n`; }
        if (!data) return; // Heartbeat comment.
        let payload: any; try { payload = JSON.parse(data); } catch { throw new CloudError('INVALID_STREAM'); }
        type ||= payload.type ?? payload.event;
        if (!['accepted', 'progress', 'complete', 'error'].includes(type)) return;
        if (payload.request_id !== requestId) throw new CloudError('STREAM_REQUEST_MISMATCH');
        const event = { ...payload, type } as CloudEvent;
        await onEvent(event);
        if (signal.aborted) throw new CloudError('REQUEST_DISCONNECTED');
        if (type === 'error') throw new CloudError(safeCode(payload.error?.code ?? payload.error, 'GENERATION_FAILED'));
        if (type === 'complete') { if (!payload.record) throw new CloudError('INVALID_STREAM'); complete = payload.record; }
      }
      while (!complete) {
        const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (buffer.length > 2 * 1024 * 1024) throw new CloudError('INVALID_STREAM');
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) { const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length); await dispatch(frame); if (complete) break; }
        if (chunk.done) { if (!complete) throw new CloudError('STREAM_INTERRUPTED'); break; }
      }
      return complete!;
    } catch (error) { if (error instanceof CloudError) throw error; throw new CloudError(signal.aborted ? 'REQUEST_DISCONNECTED' : 'STREAM_INTERRUPTED'); }
    finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); active.delete(controller); }
  }
  return {
    getSession, call, start,
    isPasswordSetupRequired: setupRequired,
    async signIn(email: string, password: string) {
      if (!email.trim() || !password) throw new CloudError('AUTH_FAILED');
      const attempt = await beginIdentityChange();
      try { return await commitIdentity(normalizeSession(await auth('token?grant_type=password', { email: email.trim(), password })), attempt, false); }
      catch (error) { if (!await discardAttempt(attempt)) throw new CloudError('AUTH_CANCELLED'); throw error; }
    },
    async redeemSetupToken(tokenHash: string) {
      const attempt = await beginIdentityChange();
      try {
        if (!/^[A-Za-z0-9_-]{20,512}$/.test(tokenHash)) throw new CloudError('SETUP_LINK_INVALID');
        const data = await auth('verify', { token_hash: tokenHash, type: 'recovery' });
        return await commitIdentity(normalizeSession(data), attempt, true);
      }
      catch (error) {
        if (!await discardAttempt(attempt)) throw new CloudError('AUTH_CANCELLED');
        if (error instanceof CloudError && error.status >= 400 && error.status < 500 && error.status !== 429) throw new CloudError('SETUP_LINK_INVALID', error.status);
        throw error;
      }
    },
    async setPassword(password: string) {
      if (typeof password !== 'string' || password.length < 10) throw new CloudError('PASSWORD_TOO_SHORT');
      const generation = epoch, session = await getSession();
      if (generation !== epoch) throw new CloudError('SESSION_CHANGED');
      if (!session) throw new CloudError('LOGIN_REQUIRED');
      try { await auth('user', { password }, session.access_token, 'PUT'); }
      catch (error) {
        if (generation !== epoch) throw new CloudError('SESSION_CHANGED');
        if (error instanceof CloudError && error.status === 401) {
          let invalidated = false;
          await locked(async () => {
            const current = await readSession();
            if (generation === epoch && current?.user.id === session.user.id && current.access_token === session.access_token) { ++epoch; invalidated = true; await storage.removeItem(setupKey); await saveSession(null); }
          }, 'identity');
          throw new CloudError(invalidated ? 'AUTH_EXPIRED' : 'SESSION_CHANGED', 401);
        }
        if (error instanceof CloudError && error.status >= 400 && error.status < 500 && error.status !== 429) throw new CloudError('PASSWORD_REJECTED', error.status);
        throw error;
      }
      return locked(async () => {
        const current = await readSession();
        if (generation !== epoch || !current || current.user.id !== session.user.id || current.access_token !== session.access_token) throw new CloudError('SESSION_CHANGED');
        await storage.removeItem(setupKey); await saveSession(current); return current;
      }, 'identity');
    },
    async signOut() { const previous = await readSession(); const attempt = await beginIdentityChange(); await discardAttempt(attempt); if (previous) await auth('logout?scope=local', {}, previous.access_token).catch(() => {}); },
    onAuthChange(listener: (session: CloudSession | null) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
