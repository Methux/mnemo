import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Mnemo',
  description: 'AI memory that forgets intelligently — Weibull decay, triple-path retrieval, multi-backend storage',
  head: [
    ['link', { rel: 'icon', href: '/logo.svg' }],
  ],
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'API', link: '/api/' },
      { text: 'Pro', link: '/pro' },
      { text: 'npm', link: 'https://www.npmjs.com/package/@mnemoai/core' },
      { text: 'GitHub', link: 'https://github.com/Methux/mnemo' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Quick Start', link: '/guide/quickstart' },
            { text: 'Local Setup ($0)', link: '/guide/ollama' },
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
        {
          text: 'Features',
          items: [
            { text: 'Storage Backends', link: '/guide/backends' },
            { text: 'Retrieval Pipeline', link: '/guide/retrieval' },
            { text: 'Weibull Decay', link: '/guide/decay' },
            { text: 'Comparison', link: '/guide/comparison' },
            { text: 'Ablation Tests', link: '/guide/ablation' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Overview', link: '/api/' },
            { text: 'createMnemo()', link: '/api/create-mnemo' },
            { text: 'store()', link: '/api/store' },
            { text: 'recall()', link: '/api/recall' },
            { text: 'delete()', link: '/api/delete' },
            { text: 'stats()', link: '/api/stats' },
            { text: 'Types', link: '/api/types' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Methux/mnemo' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright 2024-present Mnemo Contributors',
    },
    search: {
      provider: 'local',
    },
  },
})
