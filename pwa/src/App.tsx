import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { CloudSession } from '../../shared/cloud-client';
import { api, cloud, configured, deviceReadingOwner } from './cloud';
import { dailyReviewLimit, explanationLang, languageLabel, readSetupLink, reviewCards, reviewTerm, safeExternalUrl, userError } from './model.mjs';
import type { Example, KeyStatus, LearningRecord, Lesson, Notice, RecordItem, ReviewBatch, ReviewCard, ReviewState, Settings } from './types';
import { SpeechProvider, useSpeech } from './speech';
import { FONT_THEMES, type FontTheme } from '../../shared/typography/theme';
import { useFontTheme } from './useFontTheme';
import { useReviewActions } from './useReviewActions';
import { ReadingCache, historyKey, pointKey, recordKey, reviewKey, readHistory, readRecord, readReview, useReading, useReadingRefresh } from './readingCache';
import type { HistoryWindow } from './readingCache';
import { clearStoredReading } from './readingDisk';
import { useReadingNavigation, useRestoreReadingPosition } from './useReadingNavigation';
import { useDeviceNotification } from './useDeviceNotification';

type ErrorHandler = (error: unknown) => void;

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
  return language === 'zh' ? 'zh-CN' : language === 'ja' || language === 'en' ? language : undefined;
}
function ExampleLine({ example, language, explanationLanguage }: { example: Example; language: string; explanationLanguage?: string }) {
  language = example.language || language;
  const lang = sourceLanguage(language);
  return <div className="example"><div className="example-original"><p className={lang ? 'learning-text' : 'ui-text'} lang={lang}>{example.text}</p><Pronounce text={example.text} language={language} /></div><p className="translation learning-text" lang={explanationLang(explanationLanguage)}>{example.translation}</p></div>;
}
function ReviewCardView({ card, index, openRecord, pending, onComplete, onMastered }: { card: ReviewCard; index: number; openRecord: (id: string) => void; pending: boolean; onComplete: () => void; onMastered: () => void }) {
  const term = reviewTerm(card); const lang = sourceLanguage(term.language);
  return <article className="card review-card" data-reading-anchor={card.id}><div className="card-meta"><span className="language-pill">{languageLabel(card.example?.language || card.language)}</span><span>学习于 {card.local_date}</span><span className="card-number">{String(index + 1).padStart(2, '0')}</span></div>
    <h2 className={'term ' + (lang ? 'learning-text' : 'ui-text')} lang={lang}>{card.term}</h2>
    {(card.kind === 'vocabulary' || (!card.kind && Boolean(card.reading) && (!card.term_language || card.term_language === card.language))) &&
      <div className="reading"><span className={term.reading && term.language === 'ja' ? 'learning-text' : 'reading-ipa'} lang={term.reading ? lang : 'zh-CN'}>{term.reading || languageLabel(term.language)}</span><Pronounce text={card.term} reading={term.reading} language={term.language} /></div>}
    <p className="meaning learning-text" lang={explanationLang(card.explanation_language)}>{card.meaning}</p>
    {card.example && <ExampleLine example={card.example} language={card.language} explanationLanguage={card.explanation_language} />}
    {card.point_key && <div className="review-controls"><p className="review-progress" role="status">{card.reviewed ? card.completed ? '五轮复习已完成' : `本轮已复习${card.next_due_date ? ` · 下次 ${card.next_due_date}` : ''}` : `第 ${card.scheduled_round ?? Math.min(5, (card.review_round ?? 0) + 1)} / 5 轮`}</p><div className="review-actions"><button type="button" className="secondary" disabled={pending || card.reviewed || card.completed} onClick={onComplete}>{card.reviewed ? '本轮已复习' : '已复习'}</button><button type="button" className="text-button" disabled={pending} onClick={onMastered} aria-label={`标记已记住：${card.term}`}>已记住</button></div></div>}
    <button className="text-button record-link" onClick={() => openRecord(card.record_id)}>回看完整讲解<Icon name="arrow" /></button></article>;
}
function LessonContent({ result, renderReviewControl }: { result: Lesson; renderReviewControl?: (slot: number) => ReactNode }) {
  const lang = sourceLanguage(result.language); const explanation = explanationLang(result.explanation_language);
  const contentClass = lang ? 'learning-text' : 'ui-text';
  return <><section className="card explanation"><h2>一句话读懂</h2><p className="preserve-lines learning-text" lang={explanation}>{result.summary_zh}</p></section>
    {result.vocabulary.map((word, index) => <section className="card lesson-point" key={`v-${index}`}><span className="eyebrow">词汇 · <span className="learning-text" lang={explanation}>{word.pos}</span></span><h2 className={'term ' + contentClass} lang={lang}>{word.term}</h2><div className="reading"><span className={lang === 'ja' ? 'learning-text' : 'reading-ipa'} lang={lang}>{word.reading}</span><Pronounce text={word.term} reading={word.reading} language={result.language} /></div><p className="meaning learning-text" lang={explanation}>{word.meaning}</p><div className="examples">{word.examples.map((example, n) => <ExampleLine key={n} example={example} language={result.language} explanationLanguage={result.explanation_language} />)}</div>{renderReviewControl?.(index)}</section>)}
    {result.grammar.map((point, index) => <section className="card lesson-point" key={`g-${index}`}><span className="eyebrow">语法</span><h2 className="learning-text" lang={explanation}>{point.point}</h2><p className="preserve-lines learning-text" lang={explanation}>{point.explanation}</p><div className="examples">{point.examples.map((example, n) => <ExampleLine key={n} example={example} language={result.language} explanationLanguage={result.explanation_language} />)}</div>{renderReviewControl?.(result.vocabulary.length + index)}</section>)}</>;
}
function Loading({ label = '正在读取…' }: { label?: string }) { return <div className="loading" role="status"><span className="spinner" />{label}</div>; }
function SupportLinks() { return <nav className="support-links" aria-label="隐私与支持"><a href="/privacy" target="_blank" rel="noopener noreferrer">隐私说明</a><a href="/support" target="_blank" rel="noopener noreferrer">使用支持</a></nav>; }
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

type ReadingScreen = {
  cache: ReadingCache;
  refresh: number;
  navigationId: number;
  restore: (entry: number) => void;
  online: boolean;
};

function Today({ batchId, day, openRecord, onError, cache, refresh, navigationId, restore, online }:
  ReadingScreen & { batchId: string | null; day: string; openRecord: (id: string) => void; onError: ErrorHandler }) {
  const key = reviewKey(batchId, day);
  const [remembered, setRemembered] = useState<ReviewCard | null>(null);
  const speech = useSpeech();
  const actions = useReviewActions(key, onError, (state, batch) => cache.applyReview(state, batch));
  const {entry, retry} = useReading(cache, key, () => readReview(batchId, day), refresh, !actions.pending);
  const batch = entry?.value;
  const cards = reviewCards(batch ?? null) as ReviewCard[];
  useRestoreReadingPosition(entry?.value !== undefined || Boolean(entry?.error), navigationId, restore);
  useEffect(() => {
    if (batch && !document.hidden && online) cache.markOpened(batch);
  }, [batch, cache, online, refresh]);

  async function complete(card: ReviewCard) {
    if (!online || !batch || card.reviewed || card.completed) return;
    await actions.complete(card, batch.id);
  }
  async function remember(card: ReviewCard, mastered: boolean) {
    if (!online) return;
    if (await actions.mastery(card, mastered)) {
      speech.stop();
      setRemembered(mastered ? card : null);
    }
  }

  const loading = entry?.value === undefined && !entry?.error;
  return <>
    <div className="page-heading">
      <div><span className="eyebrow">每天一点，刚刚好</span><h1>今日复习</h1><p>{batch ? batch.local_date + ' · ' + cards.length + ' 张卡片' : '给学过的词句，一次新的相遇。'}</p></div>
      <button className="icon-button refresh" aria-label="刷新复习" disabled={!online || Boolean(entry?.loading || actions.pending)} onClick={retry}><Icon name="refresh" /></button>
    </div>
    {remembered && <div className="review-undo" role="status"><span>已记住「{remembered.term}」，不再安排这个学习点。</span><button type="button" className="text-button" disabled={!online || Boolean(actions.pending)} onClick={() => void remember(remembered, false)}>撤销</button></div>}
    {entry?.error && batch && online && <p className="small muted" role="status">暂时未能更新，正在显示本机缓存。</p>}
    {loading ? <Loading /> : entry?.error && batch === undefined ? <Empty title="暂时没有读到卡片">请检查网络后，点击右上角重试。</Empty> : !cards.length
      ? <Empty title="当前没有待复习卡片">到期的词汇和语法会在每日安排中出现；已记住的学习点仍可从历史查看。</Empty>
      : <><p className="review-instruction">读完后点“已复习”安排下一轮；“已记住”会停止这个学习点的复习。</p>
        <div className="review-stack">{cards.map((card, index) => <ReviewCardView key={card.id} card={card} index={index} openRecord={openRecord} pending={!online || Boolean(actions.pending)} onComplete={() => void complete(card)} onMastered={() => void remember(card, true)} />)}
          <p className="end-note">今天就读到这里。慢一点，也在前进。</p>
        </div></>}
  </>;
}

function PointMasteryControl({ card, pending, onChange }: { card: ReviewCard; pending: boolean; onChange: (mastered: boolean) => void }) {
  return <div className="point-review-controls"><p className="review-progress" role="status">{card.mastered ? '已记住，不再安排复习。' : card.completed ? '五轮复习已完成。' : '按间隔复习计划安排。'}</p><button type="button" className="text-button" disabled={pending} aria-label={`${card.mastered ? '撤销已记住' : '标记已记住'}：${card.term}`} onClick={() => onChange(!card.mastered)}>{card.mastered ? '撤销已记住' : '已记住'}</button></div>;
}

function History({query, setQuery, openRecord, requestDelete, cache, refresh, navigationId, restore, online}:
  ReadingScreen & {query:string; setQuery:(value:string)=>void; openRecord:(id:string)=>void; requestDelete:(record:RecordItem)=>void}) {
  const [search, setSearch] = useState(query.trim());
  useEffect(() => {
    if (!query.trim()) { setSearch(''); return; }
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const key = historyKey(search);
  const {entry, retry} = useReading(cache, key, () => readHistory(search, cache.view<HistoryWindow>(key)?.value), refresh);
  const items = entry?.value?.items ?? [];
  const initialLoading = entry?.value === undefined && !entry?.error;
  useRestoreReadingPosition(!initialLoading, navigationId, restore);
  const loadMore = () => { if (online && entry?.value) void cache.read(key, () => readHistory(search, entry.value, true), true); };

  return <>
    <div className="page-heading"><div><span className="eyebrow">那些查过的词句</span><h1>学习历史</h1><p>每一次好奇，都留在这里。</p></div></div>
    <div className="search-box"><Icon name="search" /><input type="search" aria-label="搜索学习记录" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索单词、句子或讲解" maxLength={500} />{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><Icon name="close" /></button>}</div>
    {!initialLoading && !items.length && !entry?.error && <Empty title={search ? '还没找到这条记录' : '从一次好奇开始'}>{search ? '换一个关键词，或者清空搜索看看全部记录。' : '在电脑扩展中查询，记录会出现在这里。'}</Empty>}
    <div className="history-stack">
      {items.map(item => <article className="card history-row" key={item.record_id} data-reading-anchor={item.record_id}>
        <button className="history-open" onClick={() => openRecord(item.record_id)}>
          <div className="card-meta"><span>{item.local_date}</span>{item.has_image && <span className="inline-icon"><Icon name="image" />截图</span>}<span className={'record-status ' + (item.status === 'completed' || item.status === 'complete' ? '' : 'pending')}>{statusLabel(item.status)}</span></div>
          <h2>{item.text}</h2><span className="text-button">查看讲解<Icon name="arrow" /></span>
        </button>
        <button className="icon-button delete-button" disabled={!online} aria-label={'删除记录：' + item.text} onClick={() => requestDelete(item)}><Icon name="delete" /></button>
      </article>)}
    </div>
    {initialLoading && <Loading />}
    {entry?.error && <><p className="small muted" role="status">{items.length ? '暂时未能更新，正在显示本机缓存。' : '暂时无法读取这页历史。'}</p><button className="secondary wide" disabled={!online} onClick={retry}>重新读取</button></>}
    {entry?.value?.has_more && <button className="secondary wide more-button" disabled={!online || Boolean(entry.loading)} onClick={loadMore}>{entry.loading ? '正在读取…' : '查看更多'}</button>}
  </>;
}
function statusLabel(value: string) { return ({ complete: '已完成', completed: '已完成', generating: '生成中', processing: '生成中', pending: '待处理', saved: '已保存', accepted: '已保存', awaiting_review: '待校正', interrupted: '结果待确认', failed: '未完成', cancelled: '已取消', canceled: '已取消' } as Record<string, string>)[value] || '已保存'; }

function RecordDetail({id, onBack, requestDelete, onError, cache, refresh, navigationId, restore, online}:
  ReadingScreen & {id:string; onBack:()=>void; requestDelete:(record:RecordItem)=>void; onError:ErrorHandler}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const imageRequest = useRef(0);
  const recordReading = useReading(cache, recordKey(id), () => readRecord(id), refresh);
  const record = recordReading.entry?.value;
  const loading = record === undefined && !recordReading.entry?.error;
  const key = pointKey(id, record?.revision ?? 0);
  const pointActions = useReviewActions(key, onError, state => cache.applyReview(state));
  const {entry:pointEntry, retry:retryPoints} = useReading(cache, key, async () => {
    const result = await api<{cards:ReviewCard[]}>('review.cards', {record_id:id});
    if (!Array.isArray(result.cards)) throw new Error('REVIEW_STATE_UNCONFIRMED');
    return result.cards;
  }, refresh, online && Boolean(record?.result) && !pointActions.pending);
  const points = pointEntry?.value ?? [];
  const pointsLoading = online && Boolean(record?.result) && !pointEntry?.value && !pointEntry?.error;
  const pointsFailed = Boolean(pointEntry?.error);
  useRestoreReadingPosition(!loading, navigationId, restore);

  async function setMastered(card: ReviewCard, mastered: boolean) {
    if (online) await pointActions.mastery(card, mastered);
  }
  function pointControl(slot: number) {
    const card = points.find(point => point.slot === slot), lesson = record?.result;
    if (!card?.point_key || !lesson) return null;
    const vocabulary = slot < lesson.vocabulary.length, point = vocabulary ? lesson.vocabulary[slot] : lesson.grammar[slot - lesson.vocabulary.length];
    // A later re-explanation can reuse a slot. Do not attach its controls to older visible wording.
    if (!point || card.term !== ('term' in point ? point.term : point.point) || card.meaning !== ('meaning' in point ? point.meaning : point.explanation)
      || card.kind !== (vocabulary ? 'vocabulary' : 'grammar') || card.language !== lesson.language
      || (card.explanation_language || 'zh') !== (lesson.explanation_language || 'zh')
      || (vocabulary && ((card.reading || '') !== ('reading' in point ? point.reading : '') || (card.pos || '') !== ('pos' in point ? point.pos : '')))) return null;
    return <PointMasteryControl card={card} pending={!online || Boolean(pointActions.pending)} onChange={mastered => void setMastered(card, mastered)} />;
  }
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
    if (online && record?.image) void fetchImage();
    // Invalidate even a successful late URL when the record/account view has unmounted.
    return () => { ++imageRequest.current; };
  }, [record?.image, fetchImage, online]);
  const result = record?.result; const source = safeExternalUrl(record?.source?.url);
  const lang = sourceLanguage(result?.language);
  const contentClass = lang ? 'learning-text' : 'ui-text';
  return <><button className="text-button back-button" onClick={onBack}><Icon name="back" />返回</button>{loading ? <Loading /> : !record ? <Empty title="暂时无法打开记录"><button className="text-button" onClick={recordReading.retry} disabled={!online}>重新读取</button></Empty> : <>{recordReading.entry?.error && online && <p className="small muted" role="status">暂时未能更新，正在显示本机缓存。</p>}<div className="page-heading record-heading"><div><div className="card-meta"><span>{record.local_date}</span><span>{statusLabel(record.status)}</span></div><h1 className={contentClass} lang={lang}>{record.corrected_text || record.recognized_text || record.original_text || record.text}</h1></div><button className="icon-button delete-button" aria-label="删除这条记录" disabled={!online} onClick={() => requestDelete(record)}><Icon name="delete" /></button></div>{result ? <>{pointsLoading && <p className="small muted" role="status">正在读取复习状态…</p>}{pointsFailed && <p className="small muted" role="status">复习状态暂时无法读取。<button type="button" className="text-button" onClick={retryPoints} disabled={!online}>重新读取复习状态</button></p>}<LessonContent result={result} renderReviewControl={pointControl} /></> : <section className="card explanation"><h2>{statusLabel(record.status)}</h2><p>完整讲解尚未生成，请在电脑扩展中查看处理状态。</p><button className="secondary" onClick={recordReading.retry} disabled={!online}>刷新状态</button></section>}{record.image && <section className="card"><h2>当时的截图</h2>{!online ? <p className="small muted">联网后可查看截图。</p> : imageUrl && !imageFailed ? <><button className="image-thumbnail" onClick={() => void fetchImage(true)} disabled={imageLoading} aria-label="放大查看截图"><img src={imageUrl} alt="查询时保存的截图" loading="lazy" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /></button>{imageLoading && <p className="small muted" role="status">正在打开截图…</p>}</> : imageFailed ? <div><p className="muted">截图暂时无法读取。</p><button className="text-button" onClick={() => void fetchImage()}>重新加载截图</button></div> : <Loading label="正在读取截图…" />}</section>}{(record.context || record.source?.title || source) && <section className="card source-card">{record.context && <details><summary>原文上下文</summary><p className={'preserve-lines ' + contentClass} lang={lang}>{record.context}</p></details>}{(record.source?.title || source) && <div className="source-link"><span className="eyebrow">来源</span>{source ? <a href={source} target="_blank" rel="noopener noreferrer">{record.source?.title || '打开原页面'} ↗</a> : <p>{record.source?.title}</p>}</div>}</section>}{imageOpen && imageUrl && <Modal title="查询截图" onClose={() => setImageOpen(false)} className="image-modal">{imageFailed ? <><p>截图链接已失效或网络不可用。</p><button className="secondary" onClick={() => void fetchImage(true)} disabled={imageLoading}>重新加载截图</button></> : <img src={imageUrl} alt="查询时保存的完整截图" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />}</Modal>}</>}</>;
}

function Toggle({ label, detail, checked, disabled, onChange }: { label: string; detail?: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <label className="setting-row"><span><strong>{label}</strong>{detail && <span className="setting-detail">{detail}</span>}</span><input className="switch" type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /></label>;
}
function FontSettings({ fonts }: { fonts: ReturnType<typeof useFontTheme> }) {
  const selected = FONT_THEMES.find(item => item.id === fonts.theme);
  return <section className="card settings-card font-settings"><h2>字体方案</h2><div className="mode-setting"><label htmlFor="font-theme">字体组合</label><select id="font-theme" value={fonts.theme} disabled={fonts.busy || !fonts.ready} aria-describedby="font-description font-status" onChange={event => void fonts.choose(event.target.value as FontTheme)}>{FONT_THEMES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><p id="font-description" className="small muted">{selected?.description}</p></div><div className="font-preview" aria-label="字体预览"><p className="ui-text" lang="zh-CN">把遇见的文字，慢慢读懂。</p><p className="learning-text" lang="en">A little discovery, every day.</p><p className="learning-text" lang="ja">言葉との出会いを、少しずつ。</p></div><p id="font-status" className="setting-detail" role="status">{fonts.busy ? '正在保存字体方案…' : '标题、按钮和学习内容一起切换，并在登录后同步。'}</p></section>;
}
function DailyReviewLimit({ value = 5, disabled, onBusy, onSaved, recheck }: {
  value?: number; disabled: boolean; onBusy: (busy: boolean) => void; onSaved: (limit: number) => void; recheck: () => void;
}) {
  const [input, setInput] = useState(String(value)), [saving, setSaving] = useState(false), [message, setMessage] = useState(''), [invalid, setInvalid] = useState(false);
  const alive = useRef(true), locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setInput(String(value)); }, [value]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (locked.current || disabled) return;
    const limit = dailyReviewLimit(input);
    if (limit === null) { setInvalid(true); setMessage('请输入 1–100 之间的整数。'); return; }
    locked.current = true; setSaving(true); onBusy(true); setInvalid(false); setMessage('正在保存每日数量…');
    let written = false;
    try {
      await api<Settings>('settings.update', { review_daily_limit: limit });
      written = true;
      if (!alive.current) return;
      const confirmed = await api<Settings>('settings.get');
      if (!alive.current) return;
      if (confirmed.review_daily_limit !== limit) throw new Error('REVIEW_LIMIT_NOT_CONFIRMED');
      onSaved(limit); setInput(String(limit)); setMessage(`已保存：每天最多 ${limit} 张，新生成的复习批次生效。`);
    } catch (error) {
      if (alive.current) {
        setInvalid(true); setMessage(userError(error));
        if (written) recheck();
      }
    }
    finally { locked.current = false; if (alive.current) { setSaving(false); onBusy(false); } }
  }
  return <form className="daily-review-limit" onSubmit={save} noValidate><label htmlFor="review-daily-limit">每天最多复习</label><div className="review-limit-input"><input id="review-daily-limit" type="number" inputMode="numeric" min="1" max="100" step="1" value={input} aria-invalid={invalid} aria-describedby="review-limit-help review-limit-status" disabled={saving || disabled} onChange={event => { setInput(event.target.value); setInvalid(false); setMessage(''); }} /><span>张</span><button type="submit" className="secondary" disabled={saving || disabled || input === String(value)}>{saving ? '保存中…' : '保存数量'}</button></div><p className="setting-detail" id="review-limit-help">输入 1–100 张。只挑选到期内容；修改对新生成的批次生效。</p><p className={`setting-detail ${invalid ? 'danger' : ''}`} role={invalid ? 'alert' : 'status'} id="review-limit-status">{message}</p></form>;
}
function SettingsPage({email, onError, notify, onSignOut, fonts, settings, patchSettings, refresh, retrySettings}:
  {email?:string; onError:ErrorHandler; notify:(notice:Notice)=>void; onSignOut:()=>Promise<void>;
   fonts:ReturnType<typeof useFontTheme>; settings?:Settings; patchSettings:(change:Partial<Settings>)=>void; refresh:number; retrySettings:()=>void}) {
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const push = useDeviceNotification({enabled:Boolean(settings?.push_enabled), refresh, busy, setBusy, patchSettings, notify, onError});
  useEffect(() => {
    let live = true;
    api<KeyStatus>('key.status').then(value => { if (live) setKeyStatus(value); })
      .catch(error => { if (live && navigator.onLine) onError(error); });
    return () => { live = false; };
  }, [onError]);
  async function update(change: Partial<Settings>) {
    if (busy) return; setBusy('settings');
    try {
      const updated = await api<Settings>('settings.update', change);
      patchSettings(updated);
      if (change.explanation_mode) {
        const confirmed = await api<Settings>('settings.get');
        patchSettings(confirmed);
        if (confirmed.explanation_mode !== change.explanation_mode) { notify({ text: '讲解模式尚未确认，请稍后重试。', tone: 'error' }); return; }
        notify({ text: `讲解模式已设为${confirmed.explanation_mode === 'thinking' ? '思考' : '快速'}。`, tone: 'success' });
      }
    } catch (error) { onError(error); } finally { setBusy(''); }
  }
  async function saveKey(event: FormEvent) { event.preventDefault(); if (busy || !key.trim()) return; setBusy('key'); const submitted = key.trim(); setKey(''); try { await api('key.save', { key: submitted }); setKeyStatus(await api<KeyStatus>('key.status')); notify({ text: 'DeepSeek Key 已保存。', tone: 'success' }); } catch (error) { onError(error); } finally { setBusy(''); } }
  async function deleteKey() { if (busy) return; setBusy('key'); try { await api('key.delete'); setKeyStatus({ configured: false }); setKey(''); setRemoveKey(false); notify({ text: '托管 Key 已移除，已有学习记录不受影响。', tone: 'success' }); } catch (error) { onError(error); } finally { setBusy(''); } }
  return <><div className="page-heading"><div><span className="eyebrow">按你的节奏</span><h1>设置</h1><p>留一点时间，给学过的东西。</p></div></div>{!settings ? <section className="card"><p>正在读取设置，连接失败时可以重试。</p><button className="secondary" onClick={retrySettings}>重新读取</button></section> : <><section className="card settings-card"><h2>每日复习</h2><Toggle label="每日精选" detail={`每天北京时间 07:00，最多 ${settings.review_daily_limit ?? 5} 张到期卡片。`} checked={settings.review_enabled} disabled={Boolean(busy)} onChange={value => update({ review_enabled: value })} />{!settings.review_enabled && <p className="soft-note">复习已暂停，已有卡片和历史仍可查看。</p>}<DailyReviewLimit value={settings.review_daily_limit ?? 5} disabled={Boolean(busy) && busy !== 'review-limit'} onBusy={value => setBusy(value ? 'review-limit' : '')} onSaved={limit => patchSettings({review_daily_limit:limit})} recheck={retrySettings} /><details className="review-schedule-help"><summary>复习如何安排？</summary><p className="small muted">正常情况下，在首次学习后的第 1、3、7、14、30 天安排五轮复习。点击“已复习”才推进；延迟完成时，下一轮从实际完成日再间隔 2、4、7、16 天。未完成的内容按到期先后安排，不在一天补多轮。</p><p className="small muted">这是间隔复习的默认节奏，不是对个人遗忘速度的精确预测。“已记住”的学习点停止复习，可在完整讲解中撤销。</p></details><div className="setting-block">
      <div className="section-heading">
        <div><strong>手机通知</strong><p className="setting-detail" role="status">{
          !settings.push_enabled ? '开启后，点开通知就能阅读卡片。' :
            push.permission === 'denied' ? '系统通知权限已关闭。' :
            push.device === 'current' ? push.permission === 'granted' ? '本机已连接' : '需要重新连接' :
            push.device === 'other' ? '通知连在另一台设备' :
            push.device === 'missing' ? '需要重新连接' :
            push.device === 'checking' ? '正在检查本机订阅…' : '暂时无法确认本机订阅'
        }</p></div>
        <Icon name="bell" />
      </div>
      {push.ios && !push.standalone && <div className="install-guide"><strong>先把 Lingo Notes 放到主屏幕</strong><ol><li>在 Safari 中打开本页面。</li><li>点“分享”，选择“添加到主屏幕”。</li><li>从主屏幕打开，再点下方“开启通知”。</li></ol><p>需要支持网页推送的 iOS 版本（16.4 或更新）。</p></div>}
      {push.permission === 'denied' && <p className="soft-note">请在系统通知设置中允许 Lingo Notes。</p>}
      <div className="button-row">
        {!settings.push_enabled && <button className="primary" onClick={push.enablePush} disabled={Boolean(busy)}>{busy === 'push' ? '正在开启…' : '开启通知'}</button>}
        <button className="secondary" onClick={push.testPush} disabled={Boolean(busy) || !push.canTest}>{busy === 'test' ? '正在发送…' : '发送测试通知'}</button>
        {settings.push_enabled && push.device === 'current' && <button className="text-button" onClick={push.disablePush} disabled={Boolean(busy)}>关闭通知</button>}
        {settings.push_enabled && <button className="text-button" onClick={push.enablePush} disabled={Boolean(busy)}>{push.device === 'other' ? '改用当前设备' : '重新连接这台设备'}</button>}
      </div>
      {push.delivery && <p className="setting-detail" role="status">{push.delivery}</p>}
      {settings.push_enabled && !settings.review_enabled && <p className="setting-detail">每日复习已暂停，测试通知仍可单独发送。</p>}
      {!settings.push_enabled && <p className="setting-detail">先开启通知，再发送测试通知。</p>}
    </div><p className="small muted">没有复习内容时不发送空提醒。</p></section><FontSettings fonts={fonts} /><section className="card settings-card"><h2>AI 服务</h2><div className="setting-row"><div><strong>DeepSeek</strong><span className="setting-detail">{keyStatus?.configured ? `已配置 · •••• ${keyStatus.last_four || ''}` : '尚未配置 Key'}</span></div><span className={`status-dot ${keyStatus?.configured ? 'ready' : ''}`} /></div><div className="mode-setting"><label htmlFor="explanation-mode">讲解模式</label><select id="explanation-mode" aria-describedby="mode-description" value={settings.explanation_mode ?? 'fast'} disabled={Boolean(busy)} onChange={event => update({ explanation_mode: event.target.value as 'fast' | 'thinking' })}><option value="fast">快速</option><option value="thinking">思考</option></select><p id="mode-description" className="small muted">快速适合随手查询。思考通常更慢、用量更多，不保证更准确。</p></div><p className="small muted">Key 在云端加密托管，仅用于你的学习请求。模型费用由 DeepSeek 收取，已有卡片的每日精选不会重复调用 AI。</p><details className="key-settings"><summary>{keyStatus?.configured ? '更换或移除 Key' : '配置自己的 Key'}</summary><form onSubmit={saveKey}><label htmlFor="api-key">DeepSeek API Key</label><input id="api-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="填写你的 API Key" disabled={Boolean(busy)} /><button className="primary" type="submit" disabled={Boolean(busy) || !key.trim()}>{busy === 'key' ? '正在保存…' : '保存 Key'}</button></form>{keyStatus?.configured && <button className="text-button danger" disabled={Boolean(busy)} onClick={() => setRemoveKey(true)}>移除托管 Key</button>}</details></section></>}<section className="card settings-card"><h2>账号</h2><p className="account-email">{email || '已登录'}</p><button className="secondary" onClick={onSignOut} disabled={Boolean(busy)}>退出登录</button><p className="small muted">退出会清除本机登录状态和学习缓存，云端笔记会继续保留。</p></section><SupportLinks />{removeKey && <Modal title="移除 DeepSeek Key？" onClose={() => { if (!busy) setRemoveKey(false); }}><p>以后查询需要重新填写 Key。已有学习记录和复习卡片会保留。</p><p className="small muted">这只移除 Lingo Notes 托管的副本，不会撤销 DeepSeek 平台上的 Key。</p><div className="button-row"><button className="secondary" autoFocus onClick={() => setRemoveKey(false)} disabled={Boolean(busy)}>保留</button><button className="danger-button" onClick={deleteKey} disabled={Boolean(busy)}>确认移除</button></div></Modal>}</>;
}

function SignedIn({session, onError, notify, online}:
  {session:CloudSession; onError:ErrorHandler; notify:(notice:Notice)=>void; online:boolean}) {
  const [cache] = useState(() => new ReadingCache(deviceReadingOwner(session.user.id)));
  const {refresh, changed, day} = useReadingRefresh();
  const settings = useReading(cache,'settings',() => api<Settings>('settings.get'),refresh);
  const patchSettings = useCallback((change:Partial<Settings>) => cache.patchSettings(change), [cache]);
  const fonts = useFontTheme(settings.entry?.value, patchSettings, onError, notify);
  const [deleting, setDeleting] = useState<RecordItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const speech = useSpeech();
  const navigation = useReadingNavigation(speech.stop);
  const {route,id: navigationId,query} = navigation.screen;
  const reader = {cache, refresh, navigationId, restore:navigation.restore, online};

  async function confirmDelete() {
    if (!deleting || deleteBusy || !online) return; setDeleteBusy(true); speech.stop();
    try {
      await api('records.delete', { record_id: deleting.record_id, revision: deleting.revision, confirmed: true });
      cache.removeRecord(deleting.record_id);
      if (route.recordId === deleting.record_id) navigation.closeRecord();
      setDeleting(null); changed(); notify({ text: '记录已删除，并已移出后续复习。', tone: 'success' });
    } catch (error) { onError(error); } finally { setDeleteBusy(false); }
  }
  async function logout() {
    if (loggingOut) return;
    speech.stop(); setLoggingOut(true);
    await cache.closeAndClear();
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
  return <>
    <main className="app-main" id="main-content">
      {route.recordId
        ? <RecordDetail key={route.recordId} id={route.recordId} onBack={navigation.closeRecord} requestDelete={setDeleting} onError={onError} {...reader} />
        : route.tab === 'today'
          ? <Today key={reviewKey(route.batchId,day)} batchId={route.batchId} day={day} openRecord={navigation.openRecord} onError={onError} {...reader} />
          : route.tab === 'history'
            ? <History key={navigationId} query={query} setQuery={navigation.setQuery} openRecord={navigation.openRecord} requestDelete={setDeleting} {...reader} />
            : <SettingsPage email={session.user.email} onError={onError} notify={notify} onSignOut={logout} fonts={fonts}
                settings={settings.entry?.value} patchSettings={patchSettings} refresh={refresh} retrySettings={settings.retry} />}
    </main>
    <nav className="bottom-nav" aria-label="主导航">
      {([{key:'today',label:'今日复习'}, {key:'history',label:'学习历史'}, {key:'settings',label:'设置'}] as const).map(tab =>
        <button key={tab.key} className={route.tab === tab.key ? 'selected' : ''} aria-current={route.tab === tab.key ? 'page' : undefined} onClick={() => navigation.switchTab(tab.key)}><Icon name={tab.key} /><span>{tab.label}</span></button>)}
    </nav>
    {deleting && <Modal title="删除这条学习记录？" onClose={() => { if (!deleteBusy) setDeleting(null); }}>
      <p>这条记录、关联截图和复习卡片会从你的学习库中移除。删除后无法撤销。</p>
      <p className="delete-preview">{deleting.text || '当前学习记录'}</p>
      <div className="button-row"><button className="secondary" autoFocus disabled={deleteBusy} onClick={() => setDeleting(null)}>保留记录</button><button className="danger-button" disabled={deleteBusy || !online} onClick={confirmDelete}>确认删除</button></div>
    </Modal>}
  </>;

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
    let live = true, version = 0, setupVersion = 0, expiryTimer = 0;
    let owner: string | undefined;
    const client = cloud;
    if (!client) { setSession(null); setSetupBusy(false); return; }
    async function applySession(value: CloudSession | null, stamp = ++version) {
      const required = await client!.isPasswordSetupRequired(value);
      if (!live || stamp !== version) return;
      const nextOwner = value ? deviceReadingOwner(value.user.id) : undefined;
      if (owner && (owner !== nextOwner || required)) void clearStoredReading(owner).catch(() => {});
      owner = nextOwner;
      clearTimeout(expiryTimer);
      setSetupRequired(required);
      setSession(value);
      if (value) {
        expiryTimer = window.setTimeout(() => {
          setSession(null);
          resume();
        }, Math.max(0, value.expires_at * 1000 - Date.now()));
      }
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
    const resume = () => { void sync().catch(error => { if (live) handleError(error); }); };
    const storage = (event: StorageEvent) => { if (!event.key || event.key.startsWith('lingo-session:')) resume(); };
    const hashChange = () => {
      const link = consumeSetupLink(); if (!link.present) return;
      setSetupBusy(true); setSetupFailure(false); setNotice(null);
      const task = link.token ? client.redeemSetupToken(link.token) : (async () => { await client.signOut(); throw new Error('SETUP_LINK_INVALID'); })();
      link.token = null; void completeSetup(task);
    };
    window.addEventListener('online', resume);
    window.addEventListener('storage', storage);
    window.addEventListener('hashchange', hashChange);
    return () => { live = false; clearTimeout(expiryTimer); unsubscribe(); window.removeEventListener('online', resume); window.removeEventListener('storage', storage); window.removeEventListener('hashchange', hashChange); };
  }, [handleError]);
  useEffect(() => { const update = () => setOnline(navigator.onLine); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, []);
  return <SpeechProvider key={session?.user.id || 'signed-out'} onError={speechError}><div className="app-shell"><header className="brand-header"><a className="brand" href="/" aria-label="Lingo Notes 首页"><img src="/icons/extension-brand-128.png" alt="" width="36" height="36" /><span lang="en">Lingo Notes</span></a><span className="header-note">随手记，慢慢记</span></header>{!online && <div className="offline-notice" role="status">当前离线，可查看本机已缓存的内容。联网后可同步更新。</div>}{notice && <div className={`notice ${notice.tone || ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" /></button></div>}{setupBusy || session === undefined ? <main className="app-main"><Loading label={setupBusy ? '正在验证设置链接…' : '正在恢复登录…'} /></main> : setupFailure ? <main className="login-page"><Empty title="设置链接暂时无法使用">请联系管理员获取新的密码设置链接。</Empty><button className="secondary wide more-button" onClick={() => { setSetupFailure(false); setNotice(null); }}>返回登录</button></main> : session && setupRequired ? <PasswordSetup email={session.user.email} onError={handleError} /> : session ? <SignedIn key={session.user.id} session={session} onError={handleError} notify={setNotice} online={online} /> : <Login onError={handleError} />}</div></SpeechProvider>;
}
