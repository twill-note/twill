import { createRoot } from 'react-dom/client'
import './fonts'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './index.css'
import './themes.css'
import './theme' // 저장된 테마를 앱 렌더 전에 <html data-theme> 로 적용
import './i18n' // 다국어 초기화 (저장된 언어 적용)
import App from './App.tsx'
import ByeoriWindowApp from './ByeoriWindowApp.tsx'

const windowMode = new URLSearchParams(window.location.search).get('window')

createRoot(document.getElementById('root')!).render(
  windowMode === 'byeori' ? <ByeoriWindowApp /> : <App />,
)
