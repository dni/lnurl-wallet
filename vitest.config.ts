import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'
import solidPlugin from 'vite-plugin-solid'

const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./package.json', import.meta.url)),
    'utf-8'
  )
)

export default defineConfig({
  plugins: [solidPlugin()],
  // matches vite.config.ts's own define - nothing currently under test
  // reads __APP_VERSION__, but keeps it available if that changes
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  test: {
    // the tested modules are pure crypto/codec helpers - node's own
    // WebCrypto (crypto.subtle) covers everything they need, no jsdom
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
