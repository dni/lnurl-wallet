import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vite'
import solidPlugin from 'vite-plugin-solid'

const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./package.json', import.meta.url)),
    'utf-8'
  )
)

export default defineConfig({
  plugins: [solidPlugin()],
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
