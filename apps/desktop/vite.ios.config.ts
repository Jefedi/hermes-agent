import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

// iOS (Capacitor) build of the desktop renderer. Same plugins/aliases as
// vite.config.ts, but with the iOS entry (ios.html → gateway-only bridge shim)
// and a separate outDir that Capacitor consumes as its webDir.

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version?: string }

// Capacitor expects the webDir to contain an index.html; the Vite input is
// ios.html so both builds can live in one project. Rename after write.
const renameIosHtml = (): Plugin => ({
  name: 'hermes-rename-ios-html',
  closeBundle() {
    const outDir = path.resolve(__dirname, 'dist-ios')
    const from = path.join(outDir, 'ios.html')
    const to = path.join(outDir, 'index.html')

    if (fs.existsSync(from)) {
      fs.rmSync(to, { force: true })
      fs.renameSync(from, to)
    }
  }
})

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), renameIosHtml()],
  define: {
    'import.meta.env.VITE_HERMES_IOS_VERSION': JSON.stringify(pkg.version ?? '0.0.0')
  },
  css: {
    // Hermetic PostCSS config — see the rationale in vite.config.ts.
    postcss: { plugins: [] }
  },
  build: {
    outDir: 'dist-ios',
    emptyOutDir: true,
    chunkSizeWarningLimit: 25000,
    rolldownOptions: {
      input: path.resolve(__dirname, 'ios.html'),
      output: {
        codeSplitting: false
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@hermes/plugin-sdk': path.resolve(__dirname, './src/sdk/index.ts'),
      '@hermes/shared/billing': path.resolve(__dirname, '../shared/src/billing-types.ts'),
      '@hermes/shared': path.resolve(__dirname, '../shared/src'),
      react: path.resolve(__dirname, '../../node_modules/react'),
      'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
      'react/jsx-dev-runtime': path.resolve(__dirname, '../../node_modules/react/jsx-dev-runtime.js'),
      'react/jsx-runtime': path.resolve(__dirname, '../../node_modules/react/jsx-runtime.js')
    },
    dedupe: ['react', 'react-dom']
  }
})
