/* @refresh reload */
import {render} from 'solid-js/web'
import {Route, HashRouter} from '@solidjs/router'
import {Toaster} from 'solid-toast'

import {WalletProvider} from './WalletContext'
import '@fontsource/noto-sans/400.css'
import '@fontsource/noto-sans/700.css'
import './styles/style.scss'
import './styles/background.scss'

import Nav from './components/Nav'
import Footer from './components/Footer'
import Wallet from './pages/Wallet'
import Setup from './pages/Setup'
import Mint from './pages/Mint'
import Scan from './pages/Scan'
import Paste from './pages/Paste'
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
      <Toaster position="top-right" toastOptions={{duration: 5000}} />
      <Nav />
      {props.children}
      <Footer />
    </WalletProvider>
  )
}

const cleanup = render(
  () => (
    <HashRouter root={App}>
      <Route path="/" component={Wallet} />
      <Route path="/setup" component={Setup} />
      <Route path="/mint" component={Mint} />
      <Route path="/scan" component={Scan} />
      <Route path="/paste" component={Paste} />
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
