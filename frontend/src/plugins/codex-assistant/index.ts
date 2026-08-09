import { aiBus } from '../../aiBus'
import { SYSTEM_AI_TAB, useAppStore } from '../../store'
import type { PluginContext } from '../registry'

/**
 * Codex 엔진 플러그인 (프론트).
 *
 * Twill AI 챗 UI 는 이제 코어 시스템 탭(ByeoriPanel)이므로, 이 플러그인은 Twill AI를 여는
 * 진입점(사이드바 버튼 · 커맨드 · 슬래시 · 선택 액션)만 등록한다.
 * 엔진 등록/로그인 등 백엔드 기능은 플러그인 install 시 서버 쪽에서 처리됨.
 */
const plugin = {
  id: 'codex_assistant',
  install(ctx: PluginContext): () => void {
    const disposers: Array<() => void> = []

    const openByeori = () => {
      useAppStore.getState().openRightTab(SYSTEM_AI_TAB)
    }

    disposers.push(
      ctx.registerSidebarButton({
        id: 'codex-open',
        label: 'Twill AI',
        icon: '🤖',
        title: 'Twill AI 열기',
        onClick: openByeori,
      }),
    )

    disposers.push(
      ctx.registerCommand({
        id: 'codex-open',
        title: 'Twill AI 열기',
        onInvoke: openByeori,
      }),
    )

    disposers.push(
      ctx.registerSlashItem({
        id: 'codex-ask',
        title: 'Twill AI에게 질문',
        subtext: 'Twill AI 대화창을 열고 이 문서에 대해 질문합니다',
        aliases: ['ai', 'twill', 'twill ai', 'byeori', '벼리', 'ask', 'ask-ai', '질문'],
        icon: '🤖',
        onInvoke: openByeori,
      }),
    )

    disposers.push(
      ctx.registerSelectionAction({
        id: 'codex-ask',
        label: 'Twill AI에게 질문',
        icon: '🤖',
        onInvoke: (text, notePath) => {
          openByeori()
          // 패널 마운트를 기다렸다가 컨텍스트 주입
          setTimeout(
            () =>
              aiBus.emit({
                type: 'insertContext',
                text,
                documentPath: notePath,
                prompt: '선택한 내용을 검토하고 설명해줘.',
                // 텍스트 선택 버튼은 사용자가 누른 명시적 문서 요청이다. 일반 채팅에는
                // 이 값이 절대 실리지 않으므로 문서가 자동으로 전달되지 않는다.
                includeDocument: Boolean(notePath),
              }),
            100,
          )
        },
      }),
    )

    return () => {
      for (const d of disposers) d()
    }
  },
}

export default plugin
