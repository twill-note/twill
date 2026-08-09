/**
 * 플러그인 라이프사이클 매니저.
 *
 * - 앱 시작 시 backend 로부터 플러그인 목록을 받고, installed=true 이면 프론트 모듈을 로드하여 확장점 등록
 * - installPlugin/uninstallPlugin 은 backend/frontend 동시 반영
 * - 각 플러그인의 프론트 진입점은 default export 로 { id, install(ctx) → cleanup } 형태를 노출
 */
import { api } from '../api'
import { createContext, usePluginRegistry } from './registry'

export type FrontendPlugin = {
  id: string
  install: (ctx: ReturnType<typeof createContext>) => () => void
}

/** 앱에 번들된 built-in 플러그인 진입점. 향후 외부 로딩을 지원할 때 확장. */
const BUILTIN_LOADERS: Record<string, () => Promise<FrontendPlugin>> = {
  // 백엔드에서 core_feature로 등록된 엔진도 프런트 진입점은 명시적으로 번들에 연결해야
  // 선택 텍스트 액션·명령 팔레트 같은 UI 기여가 동작한다.
  codex_assistant: () => import('./codex-assistant').then((module) => module.default),
}

/** 백엔드 플러그인 목록에서 제외되는 시스템 기능도 프런트 진입점은 항상 등록한다. */
const CORE_FRONTEND_PLUGINS = ['codex_assistant']

const cleanups = new Map<string, () => void>()

async function loadFrontend(pluginId: string): Promise<void> {
  if (cleanups.has(pluginId)) return
  const loader = BUILTIN_LOADERS[pluginId]
  if (!loader) return
  const plugin = await loader()
  const ctx = createContext(pluginId)
  const cleanup = plugin.install(ctx)
  cleanups.set(pluginId, cleanup)
}

function unloadFrontend(pluginId: string): void {
  const c = cleanups.get(pluginId)
  if (c) c()
  cleanups.delete(pluginId)
  usePluginRegistry.getState().clearForPlugin(pluginId)
}

export async function initPlugins(): Promise<void> {
  // `codex_assistant`는 core_feature라 백엔드의 설치형 플러그인 목록에 없다. 여기서 먼저
  // 로드해야 문서 선택 액션·명령 팔레트·슬래시 메뉴 같은 벼리 진입점이 항상 제공된다.
  for (const pluginId of CORE_FRONTEND_PLUGINS) await loadFrontend(pluginId)
  const { plugins } = await api.plugins.list()
  for (const p of plugins) {
    if (p.installed) {
      try {
        await loadFrontend(p.id)
      } catch (e) {
        console.warn('failed to load plugin', p.id, e)
      }
    }
  }
}

export async function installPlugin(pluginId: string): Promise<void> {
  await api.plugins.install(pluginId)
  await loadFrontend(pluginId)
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
  unloadFrontend(pluginId)
  await api.plugins.uninstall(pluginId)
}
