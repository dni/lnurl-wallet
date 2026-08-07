import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vite'
import solidPlugin from 'vite-plugin-solid'
import {VitePWA} from 'vite-plugin-pwa'

const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./package.json', import.meta.url)),
    'utf-8'
  )
)

export default defineConfig({
  plugins: [
    solidPlugin(),
    VitePWA({
      // 'prompt', not 'autoUpdate': this is a wallet, so a new build must
      // never silently swap the running JS out from under a signing/melt
      // action in progress - src/index.tsx wires the prompt to a toast
      registerType: 'prompt',
      // precache only the built app shell (JS/CSS/fonts/icons). No
      // runtimeCaching entries are added on purpose - every fetch() this
      // app makes is a live LNURL/mint protocol call, and those must always
      // hit the network, never be served from a cache as if still current
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff,woff2,svg,png}'],
        // cleanupOutdatedCaches (on by default) drops the old precache
        // entries - old bundle files - once a new SW activates. clientsClaim
        // is what makes that activation actually reach an already-open tab:
        // without it, skipWaiting() alone still leaves the page controlled
        // by the previous SW until some unrelated navigation happens, so the
        // reload the update toast triggers (src/index.tsx) would silently
        // do nothing
        clientsClaim: true
      },
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'LNURLwallet',
        short_name: 'LNURLwallet',
        description: pkg.description,
        // relative to the manifest's own URL, so this resolves correctly
        // whether served from a domain root or a GitHub Pages subpath
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#002222',
        theme_color: '#002222',
        icons: [
          {src: 'icon-192.png', sizes: '192x192', type: 'image/png'},
          {src: 'icon-512.png', sizes: '512x512', type: 'image/png'},
          {
            src: 'maskable-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      }
    })
  ],
  // relative asset paths so the same build works on GitHub Pages
  // (https://user.github.io/lnurl-wallet/) and any other static host -
  // routing is hash-based, so no server-side path handling is needed either
  base: './',
  server: {
    port: 3000
  },
  build: {
    target: 'esnext'
  },
  // Footer shows this - a compile-time constant instead of a hand-kept-
  // in-sync copy of package.json's own version
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  }
})
