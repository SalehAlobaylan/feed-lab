import { createRootRoute, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router'
import { History as HistoryIcon, Layers } from 'lucide-react'
import stylesheet from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Feed Lab · Wahb' }],
    links: [
      { rel: 'stylesheet', href: stylesheet },
      { rel: 'icon', href: '/images/wahb_mark_transparent.png', type: 'image/png' },
      { rel: 'icon', href: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
    ],
  }),
  shellComponent: ({ children }) => <html lang="en"><head><HeadContent /></head><body>{children}<Scripts /></body></html>,
  component: () => <>
    <header className="masthead">
      <div className="masthead-inner">
        <Link to="/" className="brand">
          <img className="brand-logo" src="/images/wahb_mark_transparent.png" alt="" width={28} height={32} />
          <span className="brand-name">WAHB</span>
          <i aria-hidden="true">/</i>
          <span className="brand-sub">Feed Lab</span>
        </Link>
        <nav aria-label="Feed Lab">
          <Link to="/" activeOptions={{ exact: true }}><Layers size={14} aria-hidden="true" />Workspace</Link>
          <Link to="/runs"><HistoryIcon size={14} aria-hidden="true" />Saved runs</Link>
        </nav>
      </div>
    </header>
    <Outlet />
  </>,
})
