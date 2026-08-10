import { defineConfig } from 'vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'

// 三个独立窗口对应三个 HTML 入口：
//   pet.html      桌宠窗口（Live2D）
//   chat.html     聊天窗口
//   settings.html 设置窗口
const rendererPages = {
  pet: resolve(__dirname, 'pet.html'),
  chat: resolve(__dirname, 'chat.html'),
  settings: resolve(__dirname, 'settings.html'),
}

export default defineConfig({
  // 生产环境通过 file:// 协议加载渲染进程，必须使用相对路径
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: { output: { format: 'cjs' } },
          },
        },
      },
      preload: {
        input: resolve(__dirname, 'electron/preload.ts'),
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: { output: { format: 'cjs' } },
          },
        },
      },
    }),
  ],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: rendererPages,
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
