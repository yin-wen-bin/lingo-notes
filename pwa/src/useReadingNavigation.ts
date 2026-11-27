import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseRoute } from './model.mjs';

type Route = ReturnType<typeof parseRoute>;
export type ReadingTab = Route['tab'];
type Anchor = { id: string | undefined; index: number; offset: number; top: number };
type NavigationEntry = { session: string; id: number; from?: number };
type Screen = { route: Route; id: number; query: string; anchor?: Anchor };
const field = 'lingoReadingNavigation';

function anchors() {
  return [...document.querySelectorAll<HTMLElement>('#main-content [data-reading-anchor]')];
}
function captureAnchor(): Anchor {
  const visible = anchors();
  const index = visible.findIndex(element => element.getBoundingClientRect().bottom > 0);
  const element = visible[index];
  return {id:element?.dataset.readingAnchor, index, offset:element?.getBoundingClientRect().top ?? 0, top:window.scrollY};
}
function scrollToAnchor(anchor: Anchor) {
  const visible = anchors();
  const target = visible.find(element => element.dataset.readingAnchor === anchor.id) ?? visible[anchor.index] ?? visible.at(-1);
  const top = anchor.id && target ? window.scrollY + target.getBoundingClientRect().top - anchor.offset : anchor.top;
  window.scrollTo(0, Math.max(0, top));
}

export function useReadingNavigation(stopSpeech: () => void) {
  const [screen, setScreen] = useState<Screen>(() => ({route:parseRoute(location.href), id:0, query:''}));
  const [session] = useState(() => crypto.randomUUID());
  const entries = useRef(new Map<number, {query:string;anchor?:Anchor}>());
  const current = useRef(screen);
  const counter = useRef(0);
  const backPending = useRef(false);
  const pendingAnchor = useRef<Anchor | undefined>(undefined);
  const previousTab = useRef<Partial<Record<ReadingTab, {query:string;anchor:Anchor}>>>({});
  const stop = useRef(stopSpeech);
  stop.current = stopSpeech;

  const savePosition = useCallback(() => {
    const {id, route, query} = current.current;
    const anchor = captureAnchor();
    entries.current.set(id, {query, anchor});
    if (!route.recordId && !route.batchId) previousTab.current[route.tab] = {query, anchor};
  }, []);
  const apply = useCallback((entry: NavigationEntry, url: URL, saved?: {query:string; anchor?:Anchor}) => {
    const old = current.current;
    const route = parseRoute(url.href);
    if (old.id === entry.id && old.route.tab === route.tab && old.route.recordId === route.recordId && old.route.batchId === route.batchId) return;
    stop.current();
    const value = saved ?? entries.current.get(entry.id);
    pendingAnchor.current = value?.anchor;
    const next = {route, id:entry.id, query:value?.query ?? '', anchor:value?.anchor};
    current.current = next;
    entries.current.set(entry.id, {query:next.query, anchor:next.anchor});
    setScreen(next);
    if (!next.anchor) window.scrollTo(0, 0);
  }, []);
  const navigate = useCallback((change: (url: URL) => void, {replace = false, from, saved}: {replace?:boolean;from?:number;saved?:{query:string;anchor?:Anchor}} = {}) => {
    const url = new URL(location.href);
    change(url);
    if (url.href === location.href) return;
    savePosition();
    const entry: NavigationEntry = {session, id:++counter.current, from};
    if (replace) history.replaceState({[field]:entry}, '', url);
    else history.pushState({[field]:entry}, '', url);
    apply(entry, url, saved);
  }, [apply, savePosition, session]);

  useLayoutEffect(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    history.replaceState({...history.state, [field]:{session,id:current.current.id}}, '', location.href);
    const pop = () => {
      backPending.current = false;
      savePosition();
      const entry: NavigationEntry | undefined = history.state?.[field];
      apply(entry?.session === session ? entry : {session,id:++counter.current}, new URL(location.href));
    };
    window.addEventListener('popstate', pop);
    return () => {
      history.scrollRestoration = previous;
      window.removeEventListener('popstate', pop);
    };
  }, [apply, savePosition, session]);

  useEffect(() => {
    const workerMessage = (event: MessageEvent) => {
      if (event.source !== navigator.serviceWorker.controller || event.data?.type !== 'LINGO_OPEN_REVIEW') return;
      const batch: unknown = event.data.batch;
      if (typeof batch !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(batch)) return;
      navigate(url => { url.search = ''; url.searchParams.set('batch',batch); });
      event.ports[0]?.postMessage('LINGO_REVIEW_OPENED');
    };
    navigator.serviceWorker?.addEventListener?.('message', workerMessage);
    return () => navigator.serviceWorker?.removeEventListener?.('message', workerMessage);
  }, [navigate]);

  const setQuery = useCallback((query: string) => {
    current.current = {...current.current, query};
    entries.current.set(current.current.id, {query});
    setScreen(current.current);
  }, []);
  const restore = useCallback((id: number) => {
    if (id !== current.current.id || !pendingAnchor.current) return;
    const anchor = pendingAnchor.current;
    pendingAnchor.current = undefined;
    scrollToAnchor(anchor);
  }, []);
  const switchTab = (tab: ReadingTab) => navigate(url => {
    url.search = '';
    if (tab !== 'today') url.searchParams.set('tab', tab);
  }, {saved:previousTab.current[tab]});
  const openRecord = (id: string) => navigate(url => { url.searchParams.set('record', id); }, {from:current.current.id});
  const closeRecord = () => {
    if (backPending.current) return;
    const entry: NavigationEntry | undefined = history.state?.[field];
    if (entry?.session === session && entry.from !== undefined && entries.current.has(entry.from)) {
      backPending.current = true;
      history.back();
      return;
    }
    navigate(url => {
      url.searchParams.delete('record');
      if (url.searchParams.has('batch')) url.searchParams.delete('tab');
      else url.searchParams.set('tab', 'history');
    }, {replace:true});
  };
  return {screen, setQuery, restore, switchTab, openRecord, closeRecord};
}

export function useRestoreReadingPosition(ready: boolean, entry: number, restore: (id: number) => void) {
  useLayoutEffect(() => { if (ready) restore(entry); }, [ready, entry, restore]);
}
