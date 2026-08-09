/**
 * 프론트엔드 플러그인 확장점 레지스트리.
 *
 * 플러그인이 install 될 때 여기에 UI 기여를 등록한다.
 * uninstall 시 반환된 cleanup을 호출하면 등록된 모든 UI 기여가 제거된다.
 */
import { create } from 'zustand'
import type { ComponentType } from 'react'

export type RightTabDef = {
  pluginId: string
  id: string
  title: string
  icon?: string
  component: ComponentType
}

export type SidebarButtonDef = {
  pluginId: string
  id: string
  label: string
  icon?: string
  title?: string
  onClick: () => void
}

/**
 * 상단바에 표시되는 플러그인 진입점.
 *
 * 태스크 보드처럼 전체 작업 영역을 여는 플러그인은 사이드바 안에만 숨기지 않고
 * 상단바에서도 바로 접근할 수 있다.
 */
export type TopBarButtonDef = {
  pluginId: string
  id: string
  label: string
  icon?: string
  title?: string
  /** 이 버튼이 여는 workspace view id. 활성 상태 표시에 사용한다. */
  viewId?: string
  onClick: () => void
}

/** 문서 편집기와 분리된, 플러그인 전용 전체 작업 화면. */
export type WorkspaceViewDef = {
  pluginId: string
  id: string
  title: string
  icon?: string
  component: ComponentType
}

export type SelectionActionDef = {
  pluginId: string
  id: string
  label: string
  icon?: string
  /**
   * text: 현재 선택된 텍스트, notePath: 현재 편집 중인 노트 경로 (없으면 null)
   */
  onInvoke: (text: string, notePath: string | null) => void
}

export type CommandDef = {
  pluginId: string
  id: string
  title: string
  onInvoke: () => void
}

export type SlashItemDef = {
  pluginId: string
  id: string
  title: string
  subtext?: string
  aliases?: string[]
  icon?: string
  onInvoke: () => void
}

interface RegistryState {
  rightTabs: RightTabDef[]
  sidebarButtons: SidebarButtonDef[]
  topBarButtons: TopBarButtonDef[]
  workspaceViews: WorkspaceViewDef[]
  selectionActions: SelectionActionDef[]
  commands: CommandDef[]
  slashItems: SlashItemDef[]
  registerRightTab: (def: RightTabDef) => () => void
  registerSidebarButton: (def: SidebarButtonDef) => () => void
  registerTopBarButton: (def: TopBarButtonDef) => () => void
  registerWorkspaceView: (def: WorkspaceViewDef) => () => void
  registerSelectionAction: (def: SelectionActionDef) => () => void
  registerCommand: (def: CommandDef) => () => void
  registerSlashItem: (def: SlashItemDef) => () => void
  clearForPlugin: (pluginId: string) => void
}

export const usePluginRegistry = create<RegistryState>((set, get) => ({
  rightTabs: [],
  sidebarButtons: [],
  topBarButtons: [],
  workspaceViews: [],
  selectionActions: [],
  commands: [],
  slashItems: [],

  registerRightTab: (def) => {
    set((s) => ({ rightTabs: [...s.rightTabs.filter((t) => t.id !== def.id), def] }))
    return () => set((s) => ({ rightTabs: s.rightTabs.filter((t) => t.id !== def.id) }))
  },
  registerSidebarButton: (def) => {
    set((s) => ({ sidebarButtons: [...s.sidebarButtons.filter((b) => b.id !== def.id), def] }))
    return () => set((s) => ({ sidebarButtons: s.sidebarButtons.filter((b) => b.id !== def.id) }))
  },
  registerTopBarButton: (def) => {
    set((s) => ({ topBarButtons: [...s.topBarButtons.filter((b) => b.id !== def.id), def] }))
    return () => set((s) => ({ topBarButtons: s.topBarButtons.filter((b) => b.id !== def.id) }))
  },
  registerWorkspaceView: (def) => {
    set((s) => ({ workspaceViews: [...s.workspaceViews.filter((v) => v.id !== def.id), def] }))
    return () => set((s) => ({ workspaceViews: s.workspaceViews.filter((v) => v.id !== def.id) }))
  },
  registerSelectionAction: (def) => {
    set((s) => ({ selectionActions: [...s.selectionActions.filter((a) => a.id !== def.id), def] }))
    return () => set((s) => ({ selectionActions: s.selectionActions.filter((a) => a.id !== def.id) }))
  },
  registerCommand: (def) => {
    set((s) => ({ commands: [...s.commands.filter((c) => c.id !== def.id), def] }))
    return () => set((s) => ({ commands: s.commands.filter((c) => c.id !== def.id) }))
  },
  registerSlashItem: (def) => {
    set((s) => ({ slashItems: [...s.slashItems.filter((c) => c.id !== def.id), def] }))
    return () => set((s) => ({ slashItems: s.slashItems.filter((c) => c.id !== def.id) }))
  },
  clearForPlugin: (pluginId) => {
    set((s) => ({
      rightTabs: s.rightTabs.filter((t) => t.pluginId !== pluginId),
      sidebarButtons: s.sidebarButtons.filter((b) => b.pluginId !== pluginId),
      topBarButtons: s.topBarButtons.filter((b) => b.pluginId !== pluginId),
      workspaceViews: s.workspaceViews.filter((v) => v.pluginId !== pluginId),
      selectionActions: s.selectionActions.filter((a) => a.pluginId !== pluginId),
      commands: s.commands.filter((c) => c.pluginId !== pluginId),
      slashItems: s.slashItems.filter((c) => c.pluginId !== pluginId),
    }))
    void get
  },
}))

export type PluginContext = {
  pluginId: string
  registerRightTab: (def: Omit<RightTabDef, 'pluginId'>) => () => void
  registerSidebarButton: (def: Omit<SidebarButtonDef, 'pluginId'>) => () => void
  registerTopBarButton: (def: Omit<TopBarButtonDef, 'pluginId'>) => () => void
  registerWorkspaceView: (def: Omit<WorkspaceViewDef, 'pluginId'>) => () => void
  registerSelectionAction: (def: Omit<SelectionActionDef, 'pluginId'>) => () => void
  registerCommand: (def: Omit<CommandDef, 'pluginId'>) => () => void
  registerSlashItem: (def: Omit<SlashItemDef, 'pluginId'>) => () => void
}

export function createContext(pluginId: string): PluginContext {
  const reg = usePluginRegistry.getState()
  return {
    pluginId,
    registerRightTab: (def) => reg.registerRightTab({ ...def, pluginId }),
    registerSidebarButton: (def) => reg.registerSidebarButton({ ...def, pluginId }),
    registerTopBarButton: (def) => reg.registerTopBarButton({ ...def, pluginId }),
    registerWorkspaceView: (def) => reg.registerWorkspaceView({ ...def, pluginId }),
    registerSelectionAction: (def) => reg.registerSelectionAction({ ...def, pluginId }),
    registerCommand: (def) => reg.registerCommand({ ...def, pluginId }),
    registerSlashItem: (def) => reg.registerSlashItem({ ...def, pluginId }),
  }
}
