import {defineConfig} from 'vite'
import solidPlugin from 'vite-plugin-solid'

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
  }
})
