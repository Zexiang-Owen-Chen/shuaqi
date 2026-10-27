import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxtjs/supabase', '@vite-pwa/nuxt'],
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },

  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      title: 'SHUAQI 耍起',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#f97316' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
        { name: 'apple-mobile-web-app-title', content: 'SHUAQI' },
        { name: 'mobile-web-app-capable', content: 'yes' },
      ],
      link: [{ rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' }],
    },
  },

  // Vercel functions in London, next to Supabase eu-west-2.
  nitro: { vercel: { functions: { regions: ['lhr1'] } } },

  supabase: {
    types: '~/types/database.types.ts',
    redirectOptions: {
      login: '/login',
      callback: '/confirm',
      // Remember the page a signed-out user tried to open; /login and /confirm return there.
      saveRedirectToCookie: true,
      // Pages anyone can open without signing in.
      exclude: ['/', '/events/*', '/install', '/checkin/*', '/about'],
    },
  },

  runtimeConfig: {
    // Server-only. Never exposed to the browser.
    supabaseServiceKey: '',
    // Web push (docs/push-notifications.md). Private key and dispatch secret are server only.
    vapidPrivateKey: '',
    vapidSubject: '',
    pushDispatchSecret: '',
    public: {
      vapidPublicKey: '',
    },
  },

  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'SHUAQI 耍起',
      short_name: 'SHUAQI',
      description: '找活动，找搭子，线下见',
      lang: 'zh-CN',
      theme_color: '#f97316',
      background_color: '#ffffff',
      display: 'standalone',
      id: '/',
      start_url: '/?source=pwa',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      navigateFallback: null,
      // Never cache API or Supabase responses; personal data must stay fresh.
      runtimeCaching: [],
      globPatterns: ['**/*.{js,css,png,svg,ico,woff2}'],
      // Push and notification-click handlers (web push notifications).
      importScripts: ['/push-sw.js'],
    },
    client: { installPrompt: false },
    devOptions: { enabled: false },
  },
})
