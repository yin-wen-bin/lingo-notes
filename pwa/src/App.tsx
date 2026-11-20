import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { CloudSession } from '../../shared/cloud-client';
import { api, cloud, configured, vapidPublicKey } from './cloud';
import { languageLabel, parseRoute, pushSubscriptionError, readSetupLink, reviewCards, safeExternalUrl, userError, vapidBytes } from './model.mjs';
import type { Example, KeyStatus, LearningRecord, Notice, RecordItem, ReviewBatch, ReviewCard, Settings } from './types';
import { SpeechProvider, useSpeech } from './speech';
import { FONT_THEMES, type FontTheme } from '../../shared/typography/theme';
import { useFontTheme } from './useFontTheme';

type ErrorHandler = (error: unknown) => void;
type Tab = 'today' | 'history' | 'settings';

// Consume one-time setup credentials before rendering or starting any requests.
function consumeSetupLink() {
  const link = readSetupLink(window.location.href);
  if (link.present) {
    const clean = new URL(window.location.href); clean.hash = '';
    window.history.replaceState(null, '', `${clean.pathname}${clean.search}`);
  }
  return link;
}
const setupLink = consumeSetupLink();
let setupToken = setupLink.token;
setupLink.token = null;
let setupRedemption: Promise<CloudSession> | null = null;
function redeemInitialSetup() {
  if (!setupRedemption) {
    const token = setupToken; setupToken = null;
    setupRedemption = token && cloud ? cloud.redeemSetupToken(token) : (async () => { await cloud?.signOut(); throw new Error('SETUP_LINK_INVALID'); })();
  }
  return setupRedemption;
}

function Icon({ name, className = '' }: { name: string; className?: string }) {
  const paths: Record<string, ReactNode> = {
    sound: <><path d="m11 5-6 4H2v6h3l6 4V5Z" /><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    today: <><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /><circle cx="12" cy="12" r="4" /></>,
    history: <><path d="M5 3h14v18l-7-4-7 4V3Z" /><path d="M9 8h6m-6 4h6" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
    arrow: <path d="m9 5 7 7-7 7" />,
    back: <path d="m15 5-7 7 7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    delete: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    refresh: <><path d="M20 6v5h-5M4 18v-5h5" /><path d="M19 10a7 7 0 0 0-12-5L4 8m16 8-3 3A7 7 0 0 1 5 14" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1" /><path d="m3 17 6-6 4 4 3-3 5 5" /></>,
  };
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.arrow}</svg>;
}
function Pronounce({ text, reading = '', language }: { text: string; reading?: string; language: string }) {
  const id = useId(); const speech = useSpeech(); const playing = speech.active === id;
  return <button className={`sound-button ${playing ? 'playing' : ''}`} type="button" disabled={!speech.available} aria-label={`${playing ? '停止' : '播放'}发音：${text}`} aria-pressed={playing} title={playing ? '停止发音' : '播放发音'} onClick={() => speech.toggle(id, text, reading, language)}><Icon name={playing ? 'stop' : 'sound'} /></button>;
}
function sourceLanguage(language?: string) {
  return language === 'ja' || language === 'en' ? language : undefined;
}
function ExampleLine({ example, language }: { example: Example; language: string }) {
  const lang = sourceLanguage(language);
  return <div className="example"><div className="example-original"><p className={lang ? 'learning-text' : 'ui-text'} lang={lang}>{example.text}</p><Pronounce text={example.text} language={language} /></div><p className="translation learning-text" lang="zh-CN">{example.translation}</p></div>;
}
function Loading({ label = '正在读取…' }: { label?: string }) { return <div className="loading" role="status"><span className="spinner" />{label}</div>; }
function SupportLinks() { return <nav className="support-links" aria-label="隐私与支持"><a href="https://lingo-notes.pages.dev/privacy" target="_blank" rel="noopener noreferrer">隐私说明</a><a href="https://lingo-notes.pages.dev/support" target="_blank" rel="noopener noreferrer">使用支持</a></nav>; }
function Empty({ title, children }: { title: string; children: ReactNode }) { return <section className="empty card"><div className="empty-symbol"><Icon name="history" /></div><h2>{title}</h2><p>{children}</p></section>; }
function Modal({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null); const id = useId();
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} className={`modal ${className}`} aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="modal-content"><div className="section-heading"><h2 id={id}>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div>{children}</div></dialog>;
}
function Login({ onError }: { onError: ErrorHandler }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  async function login(event: FormEvent) {
    event.preventDefault(); if (!cloud || busy) return; setBusy(true);
    try { await cloud.signIn(email, password); } catch (error) { onError(error); } finally { setPassword(''); setBusy(false); }
  }
  return <main className="login-page"><div className="login-intro"><span className="eyebrow">一点一滴，记得更久</span><h1>把学过的，<br />慢慢变成自己的。</h1><p>每天读几张卡片，重逢那些值得记住的词句。</p></div><section className="card login-card"><h2>登录 Lingo Notes</h2><p className="muted">使用受邀邮箱和自己的密码登录。</p>{!configured ? <p role="status">学习服务尚未就绪，请稍后再来。</p> : <><form className="password-form" onSubmit={login}><label htmlFor="email">邮箱</label><input id="email" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" disabled={busy} /><label htmlFor="password">密码</label><input id="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /><button className="primary wide" type="submit" disabled={busy || !password}>{busy ? '正在登录…' : '登录'}</button></form><details className="password-help"><summary>首次登录或忘记密码？</summary><p className="small muted">请联系管理员获取一次性的密码设置链接，然后亲自设置密码。</p></details></>}</section><p className="login-footnote">手机上轻松回看。新的查询，在电脑扩展中完成。</p><SupportLinks /></main>;
}

function PasswordSetup({ email, onError }: { email?: string; onError: ErrorHandler }) {
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [busy, setBusy] = useState(false); const [mismatch, setMismatch] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !cloud) return;
    if (password !== confirmation) { setMismatch(true); return; }
    if (password.length < 10) { onError(new Error('PASSWORD_TOO_SHORT')); return; }
    setMismatch(false); setBusy(true);
    try { await cloud.setPassword(password); }
    catch (error) { onError(error); }
    finally { setPassword(''); setConfirmation(''); setBusy(false); }
  }
  return <main className="login-page"><div className="page-heading"><div><span className="eyebrow">从自己的密码开始</span><h1>设置登录密码</h1><p>{email || '你的 Lingo Notes 账号'}</p></div></div><section className="card login-card"><p className="muted">请设置至少 10 个字符的密码，之后使用邮箱和密码登录。</p><form className="password-form" onSubmit={submit}><label htmlFor="new-password">新密码</label><input id="new-password" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={event => { setPassword(event.target.value); setMismatch(false); }} disabled={busy} /><label htmlFor="confirm-password">再次输入新密码</label><input id="confirm-password" type="password" autoComplete="new-password" minLength={10} required value={confirmation} onChange={event => { setConfirmation(event.target.value); setMismatch(false); }} disabled={busy} />{mismatch && <p className="small danger" role="alert">两次输入的密码不一致。</p>}<button className="primary wide" disabled={busy || password.length < 10 || confirmation.length < 10}>{busy ? '正在保存…' : '保存密码并继续'}</button></form><button className="text-button" disabled={busy} onClick={() => void cloud?.signOut()}>返回登录</button></section></main>;
}

function Today({ batchId, openRecord, onError, refresh }: { batchId: string | null; openRecord: (id: string) => void; onError: ErrorHandler; refresh: number }) {
  const [batch, setBatch] = useState<ReviewBatch | null>(null); const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false); const [retry, setRetry] = useState(0); const opened = useRef(new Set<string>());
  useEffect(() => {
    let live = true; setLoading(true); setFailed(false); setBatch(null);
    api<{ batch: ReviewBatch | null }>(batchId ? 'review.get' : 'review.today', batchId ? { batch_id: batchId } : {}).then(result => { if (live) setBatch(result.batch); }).catch(error => { if (live) { setFailed(true); onError(error); } }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [batchId, refresh, retry, onError]);
  useEffect(() => {
    if (!batch || opened.current.has(batch.id)) return;
    const mark = () => {
      if (document.hidden || opened.current.has(batch.id)) return;
      opened.current.add(batch.id);
      api('review.opened', { batch_id: batch.id }).catch(() => { opened.current.delete(batch.id); });
    };
    mark(); document.addEventListener('visibilitychange', mark); return () => document.removeEventListener('visibilitychange', mark);
  }, [batch]);
  const cards = reviewCards(batch) as ReviewCard[];
  return <><div className="page-heading"><div><span className="eyebrow">每天一点，刚刚好</span><h1>今日复习</h1><p>{batch ? `${batch.local_date} · ${cards.length} 张精选卡片` : '给学过的词句，一次新的相遇。'}</p></div><button className="icon-button refresh" aria-label="刷新复习" disabled={loading} onClick={() => setRetry(value => value + 1)}><Icon name="refresh" /></button></div>{loading ? <Loading /> : failed ? <Empty title="暂时没有读到卡片">请检查网络后，点击右上角重试。</Empty> : !cards.length ? <Empty title="今天还没有复习卡片">在电脑上查过的词句，会在之后的每日精选里与你重逢。</Empty> : <div className="review-stack">{cards.map((card, index) => <article className="card review-card" key={card.id}><div className="card-meta"><span className="language-pill">{languageLabel(card.language)}</span><span>学习于 {card.local_date}</span><span className="card-number">{String(index + 1).padStart(2, '0')}</span></div><h2 className={'term ' + (sourceLanguage(card.language) ? 'learning-text' : 'ui-text')} lang={sourceLanguage(card.language)}>{card.term}</h2><div className="reading"><span className={card.reading && card.language === 'ja' ? 'learning-text' : 'reading-ipa'} lang={card.reading ? sourceLanguage(card.language) : 'zh-CN'}>{card.reading || languageLabel(card.language)}</span><Pronounce text={card.term} reading={card.reading} language={card.language} /></div><p className="meaning ui-text" lang="zh-CN">{card.meaning}</p>{card.example && <ExampleLine example={card.example} language={card.language} />}<button className="text-button record-link" onClick={() => openRecord(card.record_id)}>回看完整讲解<Icon name="arrow" /></button></article>)}<p className="end-note">今天就读到这里。慢一点，也在前进。</p></div>}</>;
}

function History({ openRecord, requestDelete, onError, refresh }: { openRecord: (id: string) => void; requestDelete: (record: RecordItem) => void; onError: ErrorHandler; refresh: number }) {
  const [query, setQuery] = useState(''); const [search, setSearch] = useState(''); const [offset, setOffset] = useState(0); const [items, setItems] = useState<RecordItem[]>([]); const [hasMore, setHasMore] = useState(false); const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false); const [retry, setRetry] = useState(0);
  useEffect(() => { const timer = window.setTimeout(() => { setSearch(query.trim()); setOffset(0); }, query ? 250 : 0); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => {
    let live = true; setLoading(true); setFailed(false); if (!offset) setItems([]);
    api<{ items: RecordItem[]; has_more: boolean }>('records.history', { query: search, offset }).then(result => {
      if (!live) return; setHasMore(result.has_more); setItems(previous => offset ? [...previous, ...result.items.filter(item => !previous.some(existing => existing.record_id === item.record_id))] : result.items);
    }).catch(error => { if (live) { setFailed(true); onError(error); } }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [search, offset, refresh, retry, onError]);
  // A delete changes pagination. Restart at the first page so an old offset cannot skip a row.
  useEffect(() => { setOffset(0); }, [refresh]);
  return <><div className="page-heading"><div><span className="eyebrow">那些查过的词句</span><h1>学习历史</h1><p>每一次好奇，都留在这里。</p></div></div><div className="search-box"><Icon name="search" /><input type="search" aria-label="搜索学习记录" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索单词、句子或讲解" />{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><Icon name="close" /></button>}</div>{!loading && !items.length && !failed && <Empty title={search ? '还没找到这条记录' : '从一次好奇开始'}>{search ? '换一个关键词，或者清空搜索看看全部记录。' : '在电脑扩展中查询，记录会出现在这里。'}</Empty>}<div className="history-stack">{items.map(item => <article className="card history-row" key={item.record_id}><button className="history-open" onClick={() => openRecord(item.record_id)}><div className="card-meta"><span>{item.local_date}</span>{item.has_image && <span className="inline-icon"><Icon name="image" />截图</span>}<span className={`record-status ${item.status === 'completed' || item.status === 'complete' ? '' : 'pending'}`}>{statusLabel(item.status)}</span></div><h2>{item.text}</h2><span className="text-button">查看讲解<Icon name="arrow" /></span></button><button className="icon-button delete-button" aria-label={`删除记录：${item.text}`} onClick={() => requestDelete(item)}><Icon name="delete" /></button></article>)}</div>{loading && <Loading />}{failed && <button className="secondary wide" onClick={() => setRetry(value => value + 1)}>重新读取</button>}{!loading && !failed && hasMore && <button className="secondary wide more-button" onClick={() => setOffset(items.length)}>查看更多</button>}</>;
}
function statusLabel(value: string) { return ({ complete: '已完成', completed: '已完成', generating: '生成中', processing: '生成中', pending: '待处理', saved: '已保存', accepted: '已保存', awaiting_review: '待校正', interrupted: '结果待确认', failed: '未完成', cancelled: '已取消', canceled: '已取消' } as Record<string, string>)[value] || '已保存'; }

function RecordDetail({ id, onBack, requestDelete, onError }: { id: string; onBack: () => void; requestDelete: (record: RecordItem) => void; onError: ErrorHandler }) {
  const [record, setRecord] = useState<LearningRecord | null>(null); const [loading, setLoading] = useState(true); const [imageUrl, setImageUrl] = useState<string | null>(null); const [imageOpen, setImageOpen] = useState(false); const [imageFailed, setImageFailed] = useState(false); const [imageLoading, setImageLoading] = useState(false); const [retry, setRetry] = useState(0); const imageRequest = useRef(0);
  useEffect(() => { let live = true; setRecord(null); setLoading(true); setImageUrl(null); setImageOpen(false); api<LearningRecord>('records.get', { record_id: id }).then(result => { if (live) setRecord(result); }).catch(error => { if (live) onError(error); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [id, retry, onError]);
  const fetchImage = useCallback(async (zoom = false) => {
    const request = ++imageRequest.current;
    setImageLoading(true); setImageFailed(false);
    try {
      const response = await api<{ url: string }>('images.url', { record_id: id });
      if (request !== imageRequest.current) return;
      const safe = safeExternalUrl(response.url);
      if (!safe) throw new Error('IMAGE_URL_INVALID');
      setImageUrl(safe); if (zoom) setImageOpen(true);
    } catch (error) { if (request === imageRequest.current) { setImageFailed(true); if (zoom) onError(error); } }
    finally { if (request === imageRequest.current) setImageLoading(false); }
  }, [id, onError]);
  useEffect(() => {
    setImageUrl(null); setImageFailed(false);
    if (record?.image) void fetchImage();
    // Invalidate even a successful late URL when the record/account view has unmounted.
    return () => { ++imageRequest.current; };
  }, [record?.image, fetchImage]);
  const result = record?.result; const source = safeExternalUrl(record?.source?.url);
  const lang = sourceLanguage(result?.language);
  const contentClass = lang ? 'learning-text' : 'ui-text';
  return <><button className="text-button back-button" onClick={onBack}><Icon name="back" />返回</button>{loading ? <Loading /> : !record ? <Empty title="暂时无法打开记录"><button className="text-button" onClick={() => setRetry(value => value + 1)}>重新读取</button></Empty> : <><div className="page-heading record-heading"><div><div className="card-meta"><span>{record.local_date}</span><span>{statusLabel(record.status)}</span></div><h1 className={contentClass} lang={lang}>{record.corrected_text || record.original_text || record.text}</h1></div><button className="icon-button delete-button" aria-label="删除这条记录" onClick={() => requestDelete(record)}><Icon name="delete" /></button></div>{result ? <><section className="card explanation"><h2>一句话读懂</h2><p className="preserve-lines ui-text" lang="zh-CN">{result.summary_zh}</p></section>{result.vocabulary.map((word, index) => <section className="card lesson-point" key={`v-${index}`}><span className="eyebrow">词汇 · {word.pos}</span><h2 className={'term ' + contentClass} lang={lang}>{word.term}</h2><div className="reading"><span className={lang === 'ja' ? 'learning-text' : 'reading-ipa'} lang={lang}>{word.reading}</span><Pronounce text={word.term} reading={word.reading} language={result.language} /></div><p className="meaning ui-text" lang="zh-CN">{word.meaning}</p><div className="examples">{word.examples.map((example, n) => <ExampleLine key={n} example={example} language={result.language} />)}</div></section>)}{result.grammar.map((point, index) => <section className="card lesson-point" key={`g-${index}`}><span className="eyebrow">语法</span><h2 className="ui-text" lang="zh-CN">{point.point}</h2><p className="preserve-lines ui-text" lang="zh-CN">{point.explanation}</p><div className="examples">{point.examples.map((example, n) => <ExampleLine key={n} example={example} language={result.language} />)}</div></section>)}</> : <section className="card explanation"><h2>{statusLabel(record.status)}</h2><p>完整讲解尚未生成，请在电脑扩展中查看处理状态。</p><button className="secondary" onClick={() => setRetry(value => value + 1)}>刷新状态</button></section>}{record.image && <section className="card"><h2>当时的截图</h2>{imageUrl && !imageFailed ? <><button className="image-thumbnail" onClick={() => void fetchImage(true)} disabled={imageLoading} aria-label="放大查看截图"><img src={imageUrl} alt="查询时保存的截图" loading="lazy" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /></button>{imageLoading && <p className="small muted" role="status">正在打开截图…</p>}</> : imageFailed ? <div><p className="muted">截图暂时无法读取。</p><button className="text-button" onClick={() => void fetchImage()}>重新加载截图</button></div> : <Loading label="正在读取截图…" />}</section>}{(record.context || record.source?.title || source) && <section className="card source-card">{record.context && <details><summary>原文上下文</summary><p className={'preserve-lines ' + contentClass} lang={lang}>{record.context}</p></details>}{(record.source?.title || source) && <div className="source-link"><span className="eyebrow">来源</span>{source ? <a href={source} target="_blank" rel="noopener noreferrer">{record.source?.title || '打开原页面'} ↗</a> : <p>{record.source?.title}</p>}</div>}</section>}{imageOpen && imageUrl && <Modal title="查询截图" onClose={() => setImageOpen(false)} className="image-modal">{imageFailed ? <><p>截图链接已失效或网络不可用。</p><button className="secondary" onClick={() => void fetchImage(true)} disabled={imageLoading}>重新加载截图</button></> : <img src={imageUrl} alt="查询时保存的完整截图" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />}</Modal>}</>}</>;
}

function Toggle({ label, detail, checked, disabled, onChange }: { label: string; detail?: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <label className="setting-row"><span><strong>{label}</strong>{detail && <span className="setting-detail">{detail}</span>}</span><input className="switch" type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /></label>;
}
function FontSettings({ fonts }: { fonts: ReturnType<typeof useFontTheme> }) {
  const selected = FONT_THEMES.find(item => item.id === fonts.theme);
  return <section className="card settings-card font-settings"><h2>字体方案</h2><div className="mode-setting"><label htmlFor="font-theme">字体组合</label><select id="font-theme" value={fonts.theme} disabled={fonts.busy || !fonts.ready} aria-describedby="font-description font-status" onChange={event => void fonts.choose(event.target.value as FontTheme)}>{FONT_THEMES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><p id="font-description" className="small muted">{selected?.description}</p></div><div className="font-preview" aria-label="字体预览"><p className="ui-text" lang="zh-CN">把遇见的文字，慢慢读懂。</p><p className="learning-text" lang="en">A little discovery, every day.</p><p className="learning-text" lang="ja">言葉との出会いを、少しずつ。</p></div><p id="font-status" className="setting-detail" role="status">{fonts.busy ? '正在保存字体方案…' : '标题、按钮和学习内容一起切换，并在登录后同步。'}</p></section>;
}
function SettingsPage({ email, onError, notify, onSignOut, fonts }: { email?: string; onError: ErrorHandler; notify: (notice: Notice) => void; onSignOut: () => Promise<void>; fonts: ReturnType<typeof useFontTheme> }) {
  const [settings, setSettings] = useState<Settings | null>(null); const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null); const [key, setKey] = useState(''); const [busy, setBusy] = useState(''); const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'); const [removeKey, setRemoveKey] = useState(false); const [retry, setRetry] = useState(0);
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  useEffect(() => { let live = true; Promise.all([api<Settings>('settings.get'), api<KeyStatus>('key.status')]).then(([prefs, status]) => { if (live) { setSettings(prefs); setKeyStatus(status); } }).catch(error => { if (live) onError(error); }); return () => { live = false; }; }, [onError, retry]);
  async function update(change: Partial<Settings>) {
    if (busy) return; setBusy('settings');
    try {
      const updated = await api<Settings>('settings.update', change);
      setSettings(previous => ({ ...previous, ...updated }));
      if (change.explanation_mode) {
        const confirmed = await api<Settings>('settings.get');
        setSettings(previous => ({ ...previous, ...confirmed }));
        if (confirmed.explanation_mode !== change.explanation_mode) { notify({ text: '讲解模式尚未确认，请稍后重试。', tone: 'error' }); return; }
        notify({ text: `讲解模式已设为${confirmed.explanation_mode === 'thinking' ? '思考' : '快速'}。`, tone: 'success' });
      }
    } catch (error) { onError(error); } finally { setBusy(''); }
  }
  async function registration() {
    const value = await navigator.serviceWorker.getRegistration('/');
    if (value?.active) return value;
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('TIMEOUT')), 10000))]);
  }
  async function enablePush() {
    if (busy) return;
    if (ios && !standalone) { notify({ text: '请先添加到主屏幕，再从主屏幕打开并开启通知。' }); return; }
    if (!pushSupported || !vapidPublicKey) { notify({ text: '当前暂时无法开启通知，请稍后重试。', tone: 'error' }); return; }
    if (Notification.permission === 'denied') { notify({ text: '通知权限已关闭，请到 iPhone 设置中允许 Lingo Notes 通知，再回到这里。' }); return; }
    setBusy('push'); let created: PushSubscription | null = null;
    try {
      // Start permission directly in this gesture, and catch synchronous browser failures too.
      const permissionRequest = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
      const granted = await permissionRequest; setPermission(granted);
      if (granted !== 'granted') { notify({ text: '尚未允许通知。你仍然可以在这里查看每日卡片。' }); return; }
      const worker = await registration(); let subscription = await worker.pushManager.getSubscription();
      if (!subscription) { subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(vapidPublicKey) }); created = subscription; }
      await api('push.subscribe', { subscription: subscription.toJSON() }); created = null;
      const updated = await api<Settings>('settings.update', { push_enabled: true });
      const confirmed = await api<Settings>('settings.get');
      setSettings(previous => ({ ...previous, ...updated, ...confirmed }));
      if (!confirmed.push_enabled) { notify({ text: '通知开启状态尚未确认，请点击“开启通知”重试。', tone: 'error' }); return; }
      notify({ text: '已开启这台设备的通知。可以发送一条测试通知。', tone: 'success' });
    } catch (error) {
      await created?.unsubscribe().catch(() => {});
      const message = pushSubscriptionError(error);
      if (message) notify({ text: message, tone: 'error' }); else onError(error);
    } finally { setBusy(''); }
  }
  async function disablePush() {
    if (busy) return; setBusy('push');
    try { await api('push.unsubscribe'); setSettings(previous => previous ? { ...previous, push_enabled: false } : previous); const worker = await navigator.serviceWorker?.getRegistration('/'); await (await worker?.pushManager.getSubscription())?.unsubscribe(); notify({ text: '已关闭通知，复习卡片仍会保留。', tone: 'success' }); } catch (error) { onError(error); } finally { setBusy(''); }
  }
  async function testPush() { if (busy || !settings?.push_enabled) return; setBusy('test'); try { await api('push.test'); notify({ text: '测试请求已提交，请查看是否收到通知。送达可能需要一点时间。' }); } catch (error) { onError(error); } finally { setBusy(''); } }
  async function saveKey(event: FormEvent) { event.preventDefault(); if (busy || !key.trim()) return; setBusy('key'); const submitted = key.trim(); setKey(''); try { await api('key.save', { key: submitted }); setKeyStatus(await api<KeyStatus>('key.status')); notify({ text: 'DeepSeek Key 已保存。', tone: 'success' }); } catch (error) { onError(error); } finally { setBusy(''); } }
  async function deleteKey() { if (busy) return; setBusy('key'); try { await api('key.delete'); setKeyStatus({ configured: false }); setKey(''); setRemoveKey(false); notify({ text: '托管 Key 已移除，已有学习记录不受影响。', tone: 'success' }); } catch (error) { onError(error); } finally { setBusy(''); } }
  return <><div className="page-heading"><div><span className="eyebrow">按你的节奏</span><h1>设置</h1><p>留一点时间，给学过的东西。</p></div></div>{!settings ? <section className="card"><p>正在读取设置，连接失败时可以重试。</p><button className="secondary" onClick={() => setRetry(value => value + 1)}>重新读取</button></section> : <><section className="card settings-card"><h2>每日复习</h2><Toggle label="每日精选" detail="每天北京时间 07:00，最多 5 张卡片。" checked={settings.review_enabled} disabled={Boolean(busy)} onChange={value => update({ review_enabled: value })} />{!settings.review_enabled && <p className="soft-note">复习已暂停，已有卡片和历史仍可查看。</p>}<div className="setting-block"><div className="section-heading"><div><strong>手机通知</strong><p className="setting-detail">{settings.push_enabled ? '已开启 · 每个账号使用一台主要设备' : '开启后，点开通知就能阅读卡片。'}</p></div><Icon name="bell" /></div>{ios && !standalone && <div className="install-guide"><strong>先把 Lingo Notes 放到主屏幕</strong><ol><li>在 Safari 中打开本页面。</li><li>点“分享”，选择“添加到主屏幕”。</li><li>从主屏幕打开，再点下方“开启通知”。</li></ol><p>需要支持网页推送的 iOS 版本（16.4 或更新）。</p></div>}{permission === 'denied' && <p className="soft-note">系统通知权限已关闭。请在系统设置中允许通知。</p>}<div className="button-row">{!settings.push_enabled && <button className="primary" onClick={enablePush} disabled={Boolean(busy)}>{busy === 'push' ? '正在开启…' : '开启通知'}</button>}<button className="secondary" onClick={testPush} disabled={Boolean(busy) || !settings.push_enabled}>{busy === 'test' ? '正在发送…' : '发送测试通知'}</button>{settings.push_enabled && <><button className="text-button" onClick={disablePush} disabled={Boolean(busy)}>关闭通知</button><button className="text-button" onClick={enablePush} disabled={Boolean(busy)}>改用当前设备</button></>}</div>{!settings.push_enabled && <p className="setting-detail">先开启通知，再发送测试通知。</p>}</div><p className="small muted">没有复习内容时不发送空提醒。</p></section><FontSettings fonts={fonts} /><section className="card settings-card"><h2>AI 服务</h2><div className="setting-row"><div><strong>DeepSeek</strong><span className="setting-detail">{keyStatus?.configured ? `已配置 · •••• ${keyStatus.last_four || ''}` : '尚未配置 Key'}</span></div><span className={`status-dot ${keyStatus?.configured ? 'ready' : ''}`} /></div><div className="mode-setting"><label htmlFor="explanation-mode">讲解模式</label><select id="explanation-mode" aria-describedby="mode-description" value={settings.explanation_mode ?? 'fast'} disabled={Boolean(busy)} onChange={event => update({ explanation_mode: event.target.value as 'fast' | 'thinking' })}><option value="fast">快速</option><option value="thinking">思考</option></select><p id="mode-description" className="small muted">快速适合随手查询。思考通常更慢、用量更多，不保证更准确。</p></div><p className="small muted">Key 在云端加密托管，仅用于你的学习请求。模型费用由 DeepSeek 收取，已有卡片的每日精选不会重复调用 AI。</p><details className="key-settings"><summary>{keyStatus?.configured ? '更换或移除 Key' : '配置自己的 Key'}</summary><form onSubmit={saveKey}><label htmlFor="api-key">DeepSeek API Key</label><input id="api-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="填写你的 API Key" disabled={Boolean(busy)} /><button className="primary" type="submit" disabled={Boolean(busy) || !key.trim()}>{busy === 'key' ? '正在保存…' : '保存 Key'}</button></form>{keyStatus?.configured && <button className="text-button danger" disabled={Boolean(busy)} onClick={() => setRemoveKey(true)}>移除托管 Key</button>}</details></section></>}<section className="card settings-card"><h2>账号</h2><p className="account-email">{email || '已登录'}</p><button className="secondary" onClick={onSignOut} disabled={Boolean(busy)}>退出登录</button><p className="small muted">退出会清除本机登录状态，云端记录会继续保留。</p></section><SupportLinks />{removeKey && <Modal title="移除 DeepSeek Key？" onClose={() => { if (!busy) setRemoveKey(false); }}><p>以后查询需要重新填写 Key。已有学习记录和复习卡片会保留。</p><p className="small muted">这只移除 Lingo Notes 托管的副本，不会撤销 DeepSeek 平台上的 Key。</p><div className="button-row"><button className="secondary" autoFocus onClick={() => setRemoveKey(false)} disabled={Boolean(busy)}>保留</button><button className="danger-button" onClick={deleteKey} disabled={Boolean(busy)}>确认移除</button></div></Modal>}</>;
}

function SignedIn({ session, onError, notify }: { session: CloudSession; onError: ErrorHandler; notify: (notice: Notice) => void }) {
  const fonts = useFontTheme(session.user.id, onError, notify);
  const [route, setRoute] = useState(() => parseRoute(window.location.href)); const [refresh, setRefresh] = useState(0); const [deleting, setDeleting] = useState<RecordItem | null>(null); const [deleteBusy, setDeleteBusy] = useState(false); const [loggingOut, setLoggingOut] = useState(false); const speech = useSpeech();
  useEffect(() => { const change = () => { speech.stop(); setRoute(parseRoute(window.location.href)); }; window.addEventListener('popstate', change); return () => window.removeEventListener('popstate', change); }, [speech.stop]);
  const navigate = (change: (url: URL) => void) => { speech.stop(); const url = new URL(window.location.href); change(url); window.history.pushState({}, '', url); setRoute(parseRoute(url.href)); window.scrollTo({ top: 0 }); };
  const switchTab = (tab: Tab) => navigate(url => { url.search = ''; if (tab !== 'today') url.searchParams.set('tab', tab); });
  const openRecord = (id: string) => navigate(url => { url.searchParams.set('record', id); });
  const closeRecord = () => navigate(url => { url.searchParams.delete('record'); });
  async function confirmDelete() {
    if (!deleting || deleteBusy) return; setDeleteBusy(true); speech.stop();
    try {
      await api('records.delete', { record_id: deleting.record_id, revision: deleting.revision, confirmed: true });
      if (route.recordId === deleting.record_id) closeRecord(); setDeleting(null); setRefresh(value => value + 1); notify({ text: '记录已删除，并已移出后续复习。', tone: 'success' });
    } catch (error) { onError(error); } finally { setDeleteBusy(false); }
  }
  async function logout() {
    if (loggingOut) return;
    speech.stop(); setLoggingOut(true);
    try {
      const worker = await navigator.serviceWorker?.getRegistration('/');
      const subscription = await worker?.pushManager.getSubscription();
      if (subscription) {
        // A stale device must not disable the user's newer primary subscription.
        const removeRemote = api('push.unsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
        await subscription.unsubscribe().catch(() => {});
        await Promise.race([removeRemote, new Promise(resolve => window.setTimeout(resolve, 3000))]);
      }
    } catch { /* Logout remains available offline or with an unavailable push service. */ }
    finally { await cloud?.signOut(); setLoggingOut(false); }
  }
  if (loggingOut) return <main className="app-main"><Loading label="正在退出登录…" /></main>;
  return <><main className="app-main" id="main-content">{route.recordId ? <RecordDetail key={route.recordId} id={route.recordId} onBack={closeRecord} requestDelete={setDeleting} onError={onError} /> : route.tab === 'today' ? <Today batchId={route.batchId} openRecord={openRecord} onError={onError} refresh={refresh} /> : route.tab === 'history' ? <History openRecord={openRecord} requestDelete={setDeleting} onError={onError} refresh={refresh} /> : <SettingsPage email={session.user.email} onError={onError} notify={notify} onSignOut={logout} fonts={fonts} />}</main><nav className="bottom-nav" aria-label="主导航">{([{ key: 'today', label: '今日复习' }, { key: 'history', label: '学习历史' }, { key: 'settings', label: '设置' }] as const).map(tab => <button key={tab.key} className={route.tab === tab.key ? 'selected' : ''} aria-current={route.tab === tab.key ? 'page' : undefined} onClick={() => switchTab(tab.key)}><Icon name={tab.key} /><span>{tab.label}</span></button>)}</nav>{deleting && <Modal title="删除这条学习记录？" onClose={() => { if (!deleteBusy) setDeleting(null); }}><p>这条记录、关联截图和复习卡片会从你的学习库中移除。删除后无法撤销。</p><p className="delete-preview">{deleting.text || '当前学习记录'}</p><div className="button-row"><button className="secondary" autoFocus disabled={deleteBusy} onClick={() => setDeleting(null)}>保留记录</button><button className="danger-button" disabled={deleteBusy} onClick={confirmDelete}>{deleteBusy ? '正在删除…' : '确认删除'}</button></div></Modal>}</>;
}

export default function App() {
  const [session, setSession] = useState<CloudSession | null | undefined>(undefined); const [notice, setNotice] = useState<Notice>(null); const [online, setOnline] = useState(navigator.onLine);
  const [setupRequired, setSetupRequired] = useState(false); const [setupBusy, setSetupBusy] = useState(setupLink.present); const [setupFailure, setSetupFailure] = useState(false);
  const handleError = useCallback((error: unknown) => {
    const code = (error as { code?: string })?.code;
    if (code === 'SESSION_CHANGED' || code === 'AUTH_CANCELLED') return;
    setNotice({ text: userError(error), tone: 'error' });
    if (['LOGIN_REQUIRED', 'AUTH_EXPIRED', 'AUTH_REQUIRED', 'UNAUTHORIZED'].includes(code || '')) void cloud?.signOut();
  }, []);
  const speechError = useCallback((text: string) => setNotice({ text, tone: 'error' }), []);
  useEffect(() => {
    let live = true, version = 0, setupVersion = 0;
    const client = cloud;
    if (!client) { setSession(null); setSetupBusy(false); return; }
    async function applySession(value: CloudSession | null, stamp = ++version) {
      const required = await client!.isPasswordSetupRequired(value);
      if (live && stamp === version) { setSetupRequired(required); setSession(value); }
    }
    const unsubscribe = client.onAuthChange(value => { void applySession(value).catch(handleError); });
    const sync = async () => { const stamp = ++version; await applySession(await client.getSession(), stamp); };
    const completeSetup = (promise: Promise<CloudSession>) => {
      const attempt = ++setupVersion;
      return promise.then(value => { if (live && attempt === setupVersion) return applySession(value); }).catch(error => { if (live && attempt === setupVersion) { setSetupFailure(true); setSession(null); handleError(error); } }).finally(() => { if (live && attempt === setupVersion) setSetupBusy(false); });
    };
    if (setupLink.present) {
      void completeSetup(redeemInitialSetup());
    } else {
      sync().catch(error => { if (live) { setSession(null); handleError(error); } });
    }
    const storage = () => { void sync().catch(handleError); };
    const hashChange = () => {
      const link = consumeSetupLink(); if (!link.present) return;
      setSetupBusy(true); setSetupFailure(false); setNotice(null);
      const task = link.token ? client.redeemSetupToken(link.token) : (async () => { await client.signOut(); throw new Error('SETUP_LINK_INVALID'); })();
      link.token = null; void completeSetup(task);
    };
    window.addEventListener('storage', storage);
    window.addEventListener('hashchange', hashChange);
    return () => { live = false; unsubscribe(); window.removeEventListener('storage', storage); window.removeEventListener('hashchange', hashChange); };
  }, [handleError]);
  useEffect(() => { const update = () => setOnline(navigator.onLine); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, []);
  return <SpeechProvider key={session?.user.id || 'signed-out'} onError={speechError}><div className="app-shell"><header className="brand-header"><a className="brand" href="/" aria-label="Lingo Notes 首页"><img src="/icons/extension-brand-128.png" alt="" width="36" height="36" /><span lang="en">Lingo Notes</span></a><span className="header-note">随手记，慢慢记</span></header>{!online && <div className="offline-notice" role="status">当前离线，连接网络后即可读取学习内容。</div>}{notice && <div className={`notice ${notice.tone || ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" /></button></div>}{setupBusy || session === undefined ? <main className="app-main"><Loading label={setupBusy ? '正在验证设置链接…' : '正在恢复登录…'} /></main> : setupFailure ? <main className="login-page"><Empty title="设置链接暂时无法使用">请联系管理员获取新的密码设置链接。</Empty><button className="secondary wide more-button" onClick={() => { setSetupFailure(false); setNotice(null); }}>返回登录</button></main> : session && setupRequired ? <PasswordSetup email={session.user.email} onError={handleError} /> : session ? <SignedIn key={session.user.id} session={session} onError={handleError} notify={setNotice} /> : <Login onError={handleError} />}</div></SpeechProvider>;
}
