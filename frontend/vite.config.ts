import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

const backendPort = Number.parseInt(process.env.NOTE_APP_BACKEND_PORT || '8000', 10)
const backendTarget = process.env.NOTE_APP_BACKEND_URL ||
  `http://127.0.0.1:${Number.isInteger(backendPort) ? backendPort : 8000}`
const backendProxy = () => ({
  '/api': { target: backendTarget, ws: true },
  '/assets': { target: backendTarget },
})

export default defineConfig({
  // 상대 경로는 Electron에서 제공하는 로컬 FastAPI 주소와 일반 웹 배포를 모두 지원한다.
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: backendProxy(),
  },
  preview: {
    // 수동 npm preview에서도 로컬 백엔드 API와 첨부 파일을 그대로 사용한다.
    proxy: backendProxy(),
  },
  build: {
    // `/assets`는 사용자가 업로드한 노트 첨부 파일 경로이므로 앱 번들과 분리한다.
    assetsDir: 'app-assets',
    // 로컬 데스크톱 앱은 에디터와 다이어그램 런타임을 함께 제공하므로 일반 웹앱보다 번들이 크다.
    chunkSizeWarningLimit: 2300,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        quickMemo: fileURLToPath(new URL('./quick-memo.html', import.meta.url)),
      },
    },
  },
})
