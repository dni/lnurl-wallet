import {defineConfig} from 'vitest/config'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    // the tested modules are pure crypto/codec helpers - node's own
    // WebCrypto (crypto.subtle) covers everything they need, no jsdom
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
