import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    // Optimize chunk sizes
    // BabylonJS is a large library, so we increase the warning limit
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        // Manual chunk splitting for better caching
        manualChunks: {
          'babylon-core': ['@babylonjs/core'],
        },
      },
    },
    // Use esbuild for minification (built-in, faster)
    minify: 'esbuild',
    // Generate source maps for debugging production issues
    sourcemap: false,
    // Target modern browsers
    target: 'es2020',
  },
  // Optimize dependencies
  optimizeDeps: {
    include: ['@babylonjs/core'],
  },
  // Esbuild options - remove console.logs in production
  esbuild: {
    drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
  },
  // Server settings for development
  server: {
    port: 5173,
    strictPort: false,
    open: true,
    host: true, // Listen on all addresses
  },
  base: './', // Ensure relative paths for simplified deployment
  // Preview settings (for testing production build)
  preview: {
    port: 4173,
  },
})
