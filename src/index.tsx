/* @refresh reload */
import {render} from 'solid-js/web'
import {Route, HashRouter} from '@solidjs/router'
import toast, {Toaster} from 'solid-toast'
import {registerSW} from 'virtual:pwa-register'

import {WalletProvider} from './WalletContext'
import {notify, NotifyKind} from './helpers'
import '@fontsource/noto-sans/400.css'
import '@fontsource/noto-sans/700.css'
import './styles/style.scss'
import './styles/background.scss'

import Nav from './components/Nav'
import Footer from './components/Footer'
import Hero from './pages/Hero'
import Wallet from './pages/Wallet'
import Setup from './pages/Setup'
import Mint from './pages/Mint'
import Mints from './pages/Mints'
import Scan from './pages/Scan'
import Paste from './pages/Paste'
import Melt from './pages/Melt'
import Backup from './pages/Backup'
import Docs from './pages/Docs'

const root = document.getElementById('root')

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    'Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?'
  )
}

const App = (props: any) => {
  return (
    <WalletProvider>
      {/* solid-toast's default top offset sits right under the viewport
      edge, which the fixed nav (taller still on mobile, see .nav-toggle in
      style.scss) then overlaps - pushed down past it instead */}
      <Toaster
        position="top-right"
        toastOptions={{duration: 5000}}
        containerStyle={{top: '64px'}}
      />
      <Nav />
      {props.children}
      <Footer />
    </WalletProvider>
  )
}

const cleanup = render(
  () => (
    <HashRouter root={App}>
      <Route path="/" component={Hero} />
      <Route path="/wallet" component={Wallet} />
      <Route path="/setup" component={Setup} />
      <Route path="/mint" component={Mint} />
      <Route path="/mints" component={Mints} />
      <Route path="/scan" component={Scan} />
      <Route path="/paste" component={Paste} />
      <Route path="/melt" component={Melt} />
      <Route path="/backup" component={Backup} />
      <Route path="/docs" component={Docs} />
      <Route path="*" component={() => <h1>Page not found</h1>} />
    </HashRouter>
  ),
  root!
)

if (import.meta.hot) {
  import.meta.hot.dispose(cleanup)
}

// 'prompt' registerType (see vite.config.ts) means a waiting update never
// takes over on its own - the reload is only ever whatever this toast's
// button triggers, so a build never swaps out from under an in-progress
// signing/melt action
const updateSW = registerSW({
  onNeedRefresh: () => {
    const id = toast.custom(
      <span>
        A new version is ready.&nbsp;
        <button
          onClick={() => {
            toast.dismiss(id)
            updateSW(true)
          }}
        >
          Reload
        </button>
      </span>,
      {duration: Infinity}
    )
  },
  onOfflineReady: () => {
    notify('Ready to work offline.', NotifyKind.SUCCESS)
  }
})
