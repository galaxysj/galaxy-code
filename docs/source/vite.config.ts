import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'demo-html',
      generateBundle(_options, bundle) {
        const code = Object.values(bundle).map((entry) => entry.type === 'chunk' ? entry.code : String(entry.source)).join('')
        const version = createHash('sha256').update(code).digest('hex').slice(0, 12)
        const source = readFileSync(resolve(__dirname, 'index.html'), 'utf8')
          .replace('demo.js', `demo.js?v=${version}`)
          .replace('galaxy-code.css', `galaxy-code.css?v=${version}`)
        this.emitFile({ type: 'asset', fileName: 'index.html', source })
      }
    }
  ],
  base: './',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: { alias: { '@shared': resolve(__dirname, '../../src/shared') } },
  build: {
    outDir: resolve(__dirname, '../demo'),
    emptyOutDir: true,
    assetsInlineLimit: 500000,
    lib: { entry: resolve(__dirname, 'demo.tsx'), name: 'GalaxyDemo', formats: ['iife'], fileName: () => 'demo.js' },
    rollupOptions: { output: { inlineDynamicImports: true, assetFileNames: '[name][extname]' } }
  }
})
