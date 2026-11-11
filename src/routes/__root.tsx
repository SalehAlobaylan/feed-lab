import { createRootRoute, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router'
import stylesheet from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Feed Lab · Wahb' }],
    links: [{ rel: 'stylesheet', href: stylesheet }],
  }),
  shellComponent: ({ children }) => <html lang="en"><head><HeadContent /></head><body>{children}<Scripts /></body></html>,
  component: () => <>
    <header className="masthead">
      <div className="masthead-inner">
        <Link to="/" className="brand"><span>WAHB</span><i aria-hidden="true">/</i>Feed Lab</Link>
        <nav aria-label="Feed Lab"><Link to="/" activeOptions={{ exact: true }}>Workspace</Link><Link to="/runs">Saved runs</Link></nav>
      </div>
    </header>
    <Outlet />
  </>,
})
