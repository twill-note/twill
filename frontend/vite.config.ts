import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

const packageMetadata = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version?: string }
const appVersion = packageMetadata.version?.trim() || '0.0.0'
// CI가 TWILL_BUILD_TIME을 주면 재현 가능한 식별자를 사용하고, 로컬 빌드는 실행 시각으로
// 서로 구분한다. 이 값은 실제 UI 번들에 들어가므로 설치된 화면의 신선도를 확인할 수 있다.
const appBuildTime = process.env.TWILL_BUILD_TIME?.trim() || new Date().toISOString()

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
  define: {
    __TWILL_APP_VERSION__: JSON.stringify(appVersion),
    __TWILL_BUILD_TIME__: JSON.stringify(appBuildTime),
  },
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
