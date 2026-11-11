import { ArrowLeft, ArrowUpRight, Bookmark, ChevronDown, ChevronUp, Clock, Ellipsis, FileText, Headphones, Heart, Layers, MessageCircle, Search, Share2, UserRound } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { safeURL, type Item } from '../lib/feed'
import type { CheckSettings } from '../lib/evidence'

export type Surface = 'pods' | 'news' | 'saved'
export type Interaction = 'like' | 'bookmark'
export type Reader = { item: Item; title: string; text: string; coverage: Item[]; translation?: string }
export const textLanguage = (value?: string) => /[\u0600-\u06ff\u0750-\u077f]/u.test(value ?? '') ? 'ar' : 'en'

const durations = [5, 10, 15, 20, 30, 40]
const newsWindows = ['today', 'week', 'month']
const labels = { pods: 'سمعيات', news: 'الأخبار', saved: 'المحفوظات' }
const windows: Record<string, string> = { today: 'اليوم', week: 'هذا الأسبوع', month: 'هذا الشهر' }

export function FeedHeader({ surface, duration, windowName, disabled, onFeed, onDuration, onWindow }: {
  surface: Surface
  duration: string
  windowName: string
  disabled: boolean
  onFeed: (surface: Surface) => void
  onDuration: (duration: string) => void
  onWindow: (windowName: string) => void
}) {
  const [showWindows, setShowWindows] = useState(false)
  return <div className="consumer-chrome" data-pager-control>
    <header className="consumer-header">
      <button className="consumer-edge" aria-label="Search" title="Search is outside the feed preview" disabled><Search /></button>
      <nav className="consumer-tabs" aria-label="Wahb feeds" dir="rtl">
        {(['pods', 'news', 'saved'] as const).map(feed => <button key={feed} aria-pressed={surface === feed} disabled={disabled}
          aria-expanded={surface === 'news' && feed === 'news' ? showWindows : undefined}
          onClick={() => {
            if (surface === 'news' && feed === 'news') { setShowWindows(value => !value); return }
            setShowWindows(false)
            onFeed(feed)
          }}>
          {labels[feed]}{surface === 'news' && feed === 'news' && <ChevronDown size={13} />}
        </button>)}
      </nav>
      <button className="consumer-edge" aria-label="Profile" title="Profile is outside the feed preview" disabled><UserRound /></button>
    </header>
    {surface === 'pods' && <div className="consumer-duration" dir="rtl" role="group" aria-label="Pods length">
      <button aria-label="Any length" aria-pressed={!duration} disabled={disabled} onClick={() => onDuration('')}><Clock size={16} /></button>
      {durations.map(value => <button dir="ltr" key={value} aria-label={value + ' minutes'} aria-pressed={duration === String(value)} disabled={disabled}
        onClick={() => onDuration(String(value))}>{value}m</button>)}
    </div>}
    {surface === 'news' && showWindows && <div className="consumer-windows" dir="rtl" role="group" aria-label="News window">
      {newsWindows.map(window => <button key={window} aria-pressed={windowName === window} disabled={disabled} onClick={() => {
        setShowWindows(false)
        onWindow(window)
      }}>{windows[window]}</button>)}
    </div>}
  </div>
}

const count = (value?: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

export function ItemActions({ item, disabled, onInteraction, onAbout, dock = false }: {
  item: Item
  disabled: boolean
  onInteraction: (item: Item, kind: Interaction) => void
  onAbout?: () => void
  dock?: boolean
}) {
  return <div className={dock ? 'consumer-action-dock' : 'consumer-actions'} data-pager-control>
    {dock && <button className="sheet-handle" aria-label="Open episode details" onClick={onAbout}><span /></button>}
    <button data-interaction="like" className={item.is_liked ? 'is-active' : ''} aria-label={item.is_liked ? 'Unlike' : 'Like'}
      aria-pressed={!!item.is_liked} disabled={disabled} onClick={() => onInteraction(item, 'like')}><Heart />{count(item.like_count) && <small>{count(item.like_count)}</small>}</button>
    {dock && <button aria-label="Comments" title="Comments are outside this preview" disabled><MessageCircle />{count(item.comment_count) && <small>{count(item.comment_count)}</small>}</button>}
    <button data-interaction="bookmark" className={item.is_bookmarked ? 'is-active' : ''} aria-label={item.is_bookmarked ? 'Unbookmark' : 'Bookmark'}
      aria-pressed={!!item.is_bookmarked} disabled={disabled} onClick={() => onInteraction(item, 'bookmark')}><Bookmark /></button>
    {dock ? <button aria-label="More actions" onClick={onAbout}><Ellipsis /></button>
      : <button aria-label="Share" title="Sharing is outside this preview" disabled><Share2 /></button>}
  </div>
}

export function PreviewImage({ url, fallback, className }: { url?: string; fallback: ReactNode; className?: string }) {
  const [failed, setFailed] = useState<string>()
  const src = safeURL(url)
  return <div className={className}>
    {src && failed !== src ? <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(src)} /> : fallback}
  </div>
}

function timeAgo(value?: string) {
  if (!value) return ''
  const delta = (new Date(value).getTime() - Date.now()) / 1000
  if (!Number.isFinite(delta)) return ''
  const formatter = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' })
  if (Math.abs(delta) < 60) return formatter.format(Math.round(delta), 'second')
  if (Math.abs(delta) < 3600) return formatter.format(Math.round(delta / 60), 'minute')
  if (Math.abs(delta) < 86400) return formatter.format(Math.round(delta / 3600), 'hour')
  return formatter.format(Math.round(delta / 86400), 'day')
}

export function NewsPreview({ item, disabled, writesDisabled, onRead, onInteraction }: {
  item: Item
  disabled: boolean
  writesDisabled: boolean
  onRead: (item: Item, coverage?: Item[]) => void
  onInteraction: (item: Item, kind: Interaction) => void
}) {
  const [showCoverage, setShowCoverage] = useState(false)
  const coverage = item.members ?? []
  const source = item.source_name || item.author
  const image = safeURL(item.thumbnail_url)
  const published = timeAgo(item.published_at)
  const updated = timeAgo(item.last_member_at)
  const excerpt = item.summary || item.excerpt
  return <div className="consumer-card news-card" data-item-id={item.id} dir="rtl">
    <div className="news-featured">
      <button className="news-lead" aria-label="Read article" disabled={disabled} onClick={() => onRead(item, coverage)}>
        {image ? <PreviewImage className="news-hero" url={image} fallback={<FileText />} />
          : <PreviewImage className="news-source-image" url={item.source_image_url} fallback={<FileText />} />}
        <h2 dir="auto" lang={textLanguage(item.title)}>{item.title || 'Untitled item'}</h2>
        {excerpt && <p dir="auto">{excerpt}</p>}
      </button>
      {coverage.length > 1 && <button className="news-coverage" aria-expanded={showCoverage} onClick={() => setShowCoverage(true)}><Layers size={13} /> تغطية من {item.source_count || coverage.length} مصادر</button>}
      {updated && <div className="news-updated"><Clock size={12} /> تحديث {updated}</div>}
      <div className="news-meta">
        <div>{source && <><PreviewImage className="news-avatar" url={item.source_image_url} fallback={<FileText />} /><span dir="auto">{source}</span></>}
          {published && <span><Clock size={12} /> {published}</span>}</div>
        <ItemActions item={item} disabled={writesDisabled} onInteraction={onInteraction} />
      </div>
    </div>
    {!!item.related?.length && <section className="news-related" aria-label="Related stories">
      <h3>المتعلّق</h3>
      {item.related.map(related => <button className="news-related-row" key={related.id} disabled={disabled} onClick={() => onRead(related, related.members)}>
        <PreviewImage className="news-related-image" url={related.thumbnail_url || related.source_image_url} fallback={<FileText />} />
        <span className="news-related-copy">
          <span className="news-kicker" dir="auto">{related.source_name || related.format || 'خبر'}</span>
          <strong dir="auto">{related.title || 'Untitled story'}</strong>
        </span>
        <small>{timeAgo(related.published_at)}</small>
      </button>)}
    </section>}
    {showCoverage && <PreviewSheet title="التغطية" onClose={() => setShowCoverage(false)}>
      {coverage.map(member => <button className="sheet-row" key={member.id} disabled={disabled} onClick={() => onRead(member, coverage)}>
        <strong dir="auto">{member.title || member.source_name || 'Article'}</strong>
        <span dir="auto">{member.source_name}</span>
      </button>)}
    </PreviewSheet>}
  </div>
}

export function PreviewSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const opener = document.activeElement
    close.current?.focus({ preventScroll: true })
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  return <section className="consumer-sheet" aria-label={title} data-pager-control onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose() }
  }}>
    <div className="consumer-sheet-head"><strong dir="auto">{title}</strong><button ref={close} aria-label="Close details" onClick={onClose}><ChevronUp /></button></div>
    <div className="consumer-sheet-content">{children}</div>
  </section>
}

export function ArticleReader({ reader, disabled, writesDisabled, onBack, onRead, onInteraction }: {
  reader: Reader
  disabled: boolean
  writesDisabled: boolean
  onBack: () => void
  onRead: (item: Item, coverage?: Item[]) => void
  onInteraction: (item: Item, kind: Interaction) => void
}) {
  const date = reader.item.published_at ? new Date(reader.item.published_at) : null
  const published = date && Number.isFinite(date.getTime()) ? date.toLocaleDateString('ar', { dateStyle: 'medium' }) : ''
  const otherCoverage = reader.coverage.filter(item => item.id !== reader.item.id)
  const source = reader.item.source_name || reader.item.author || 'WAHB'
  const original = safeURL(reader.item.original_url)
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => { back.current?.focus({ preventScroll: true }) }, [])
  return <article className="article-reader" aria-label="Article reader" data-item-id={reader.item.id} data-pager-control dir="rtl" onKeyDown={event => {
    if (event.key === 'Escape' && !disabled) onBack()
  }}>
    <header>
      <button ref={back} aria-label="Back to preview" onClick={onBack} disabled={disabled}><ArrowLeft className="article-back" /></button>
      <strong dir="auto">{source}</strong>
      <div className="article-actions">
        <button className={reader.item.is_bookmarked ? 'is-active' : ''} disabled={writesDisabled} aria-pressed={!!reader.item.is_bookmarked}
          aria-label={reader.item.is_bookmarked ? 'Unbookmark article' : 'Bookmark article'} onClick={() => onInteraction(reader.item, 'bookmark')}><Bookmark /></button>
        <button disabled aria-label="Share" title="Sharing is outside this preview"><Share2 /></button>
      </div>
    </header>
    <div className="article-body">
      {safeURL(reader.item.thumbnail_url) && <PreviewImage className="article-image" url={reader.item.thumbnail_url} fallback={<FileText />} />}
      <h2 dir="auto" lang={textLanguage(reader.title)}>{reader.title}</h2>
      <div className="article-byline">
        <PreviewImage className="news-avatar" url={reader.item.source_image_url} fallback={<span aria-hidden="true">{source.slice(0, 1)}</span>} />
        <div><strong dir="auto">{source}</strong>{published && <time dateTime={reader.item.published_at}>{published}</time>}</div>
      </div>
      {original && <a className="article-original" href={original} target="_blank" rel="noreferrer">المصدر الأصلي <ArrowUpRight /></a>}
      <p dir="auto">{reader.text}</p>
      {!!otherCoverage.length && <section className="reader-coverage" aria-label="Other coverage">
        <h3>المزيد من التغطية</h3>
        {otherCoverage.map(item => <button className="sheet-row" key={item.id} disabled={disabled} onClick={() => onRead(item, reader.coverage)}><strong dir="auto">{item.title || item.source_name || 'Article'}</strong><ArrowUpRight size={15} /></button>)}
      </section>}
    </div>
  </article>
}

export function SavedLibrary({ items, index, scroll, disabled, writesDisabled, filter, sort, hasMore, onFilter, onSort, onOpen, onRemove, onMore }: {
  items: Item[]; index: number; scroll: RefObject<number>; disabled: boolean; writesDisabled: boolean
  filter: NonNullable<CheckSettings['savedFilter']>; sort: NonNullable<CheckSettings['savedSort']>; hasMore: boolean
  onFilter: (filter: NonNullable<CheckSettings['savedFilter']>) => void
  onSort: (sort: NonNullable<CheckSettings['savedSort']>) => void
  onOpen: (item: Item, index: number) => void
  onRemove: (item: Item) => void
  onMore: () => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const selected = useRef<HTMLLIElement>(null)
  useLayoutEffect(() => {
    if (container.current) container.current.scrollTop = scroll.current
  }, [scroll])
  useLayoutEffect(() => {
    const list = container.current, row = selected.current
    if (!list || !row) return
    const frame = list.getBoundingClientRect(), target = row.getBoundingClientRect()
    if (target.top < frame.top + 64) list.scrollTop += target.top - frame.top - 64
    else if (target.bottom > frame.bottom) list.scrollTop += target.bottom - frame.bottom
  }, [index])
  return <div ref={container} className="consumer-card saved-card" dir="rtl" data-pager-control
    onScroll={event => { scroll.current = event.currentTarget.scrollTop }}>
    <div className="saved-library-controls">
      <h2>المحفوظات</h2>
      <div role="group" aria-label="Saved filter">
        {([['all', 'الكل'], ['pods', 'سمعيات'], ['news', 'الأخبار']] as const).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={filter === value} disabled={disabled} onClick={() => onFilter(value)}>{label}</button>)}
      </div>
      <label>الترتيب <select aria-label="Saved order" value={sort} disabled={disabled}
        onChange={event => onSort(event.target.value as typeof sort)}>
        <option value="saved_desc">الأحدث أولاً</option><option value="saved_asc">الأقدم أولاً</option>
      </select></label>
    </div>
    {!items.length && <p className="saved-empty">{hasMore ? 'لا توجد عناصر في هذه الصفحة.' : 'لا توجد عناصر محفوظة.'}</p>}
    <ul className="saved-library-list">
      {items.map((item, i) => <li ref={i === index ? selected : undefined} className="saved-item" key={item.id + '/' + item.capture?.id + '/' + i}
        data-saved-id={item.id} data-selected={i === index}>
        <button className="saved-link" disabled={disabled} onClick={() => onOpen(item, i)}>
          <PreviewImage className="news-related-image" url={item.thumbnail_url || item.source_image_url}
            fallback={item.type === 'PODCAST' || item.type === 'VIDEO' || item.playback_url ? <Headphones /> : <FileText />} />
          <span><strong dir="auto">{item.title || 'Untitled item'}</strong>
            {item.source_name && <small dir="auto">{item.source_name}</small>}
            {item.bookmarked_at && Number.isFinite(Date.parse(item.bookmarked_at)) && <small>{new Date(item.bookmarked_at).toLocaleDateString('ar')}</small>}
          </span>
        </button>
        <button className="saved-remove is-active" type="button" disabled={writesDisabled} aria-label={'Remove bookmark: ' + (item.title || item.id)}
          onClick={() => onRemove(item)}><Bookmark fill="currentColor" /></button>
      </li>)}
    </ul>
    {hasMore && <button type="button" className="saved-more" disabled={disabled} onClick={onMore}>تحميل المزيد</button>}
  </div>
}
