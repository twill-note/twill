import { useEffect, useState } from 'react'
import { api, type AiRuntimeInfo, type SkillMeta } from '../api'
import { useBackdropDismiss } from '../useBackdropDismiss'

function PromptDetails({ prompt }: { prompt: AiRuntimeInfo['prompts'][number] }) {
  const inactiveLabel =
    prompt.stage === '동적 도구 조회 원본'
      ? '필요 시 조회'
      : prompt.stage === 'Codex 작업 디렉터리 탐색'
        ? '자동 탐색'
        : '조건부'
  return (
    <details className="rounded-md border border-[#e9e9e7] bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-[#f7f7f5]">
        <span className="min-w-0 flex-1 text-[12px] font-medium text-[#37352f]">{prompt.title}</span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
            prompt.included ? 'bg-[#eaf4ea] text-[#36713a]' : 'bg-[#f1f1ef] text-[#777672]'
          }`}
        >
          {prompt.included ? '현재 포함' : inactiveLabel}
        </span>
        <span className="shrink-0 text-[10px] text-[#9b9a97]">▾</span>
      </summary>
      <div className="border-t border-[#f1f1ef] px-3 py-2">
        <p className="mb-2 text-[10px] text-[#9b9a97]">
          {prompt.stage} · {prompt.source}
        </p>
        {prompt.content ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[#f7f7f5] p-2.5 font-mono text-[11px] leading-5 text-[#37352f]">
            {prompt.content}
          </pre>
        ) : (
          <p className="rounded bg-[#f7f7f5] px-2.5 py-2 text-[11px] text-[#9b9a97]">
            이 항목은 현재 공통 프롬프트에 직접 포함되지 않습니다.
          </p>
        )}
      </div>
    </details>
  )
}

function SkillPrompt({
  skill,
  body,
  loading,
  onLoad,
}: {
  skill: SkillMeta
  body: string | undefined
  loading: boolean
  onLoad: () => void
}) {
  return (
    <div className="rounded-md border border-[#e9e9e7] bg-white px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-[#37352f]">{skill.name}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-[#9b9a97]">{skill.path}</p>
          {skill.description && <p className="mt-1 text-[11px] text-[#5f5e5b]">{skill.description}</p>}
        </div>
        <button
          className="shrink-0 rounded border border-[#e3e2e0] px-2 py-1 text-[10px] text-[#5f5e5b] hover:bg-[#f7f7f5] disabled:opacity-50"
          onClick={onLoad}
          disabled={loading}
        >
          {loading ? '불러오는 중…' : body === undefined ? '본문 보기' : '새로고침'}
        </button>
      </div>
      {body !== undefined && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[#f7f7f5] p-2.5 font-mono text-[11px] leading-5 text-[#37352f]">
          {body || '(본문 없음)'}
        </pre>
      )}
    </div>
  )
}

/** 설정에서 현재 오케스트레이터가 조립하는 프롬프트와 도구 실행 경계를 투명하게 보여준다. */
export default function AiRuntimeInspectorDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<AiRuntimeInfo | null>(null)
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [skillBodies, setSkillBodies] = useState<Record<string, string>>({})
  const [loadingSkills, setLoadingSkills] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const dismissFromBackdrop = useBackdropDismiss<HTMLDivElement>(onClose)

  const load = () => {
    setError(null)
    Promise.all([api.ai.runtimeInfo(), api.skills.list()])
      .then(([runtime, result]) => {
        setInfo(runtime)
        setSkills(result.skills)
      })
      .catch((e) => setError((e as Error).message))
  }

  useEffect(() => {
    load()
  }, [])

  const loadSkillBody = async (path: string) => {
    setLoadingSkills((current) => new Set(current).add(path))
    try {
      const result = await api.skills.body(path)
      setSkillBodies((current) => ({ ...current, [path]: result.body }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoadingSkills((current) => {
        const next = new Set(current)
        next.delete(path)
        return next
      })
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 pt-[4vh]"
      onClick={dismissFromBackdrop}
    >
      <div
        className="max-h-[90vh] w-[840px] max-w-[95vw] overflow-y-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-runtime-inspector-title"
      >
        <div className="flex items-center justify-between border-b border-[#e9e9e7] px-5 py-3">
          <div>
            <h2 id="ai-runtime-inspector-title" className="text-[14px] font-semibold text-[#37352f]">
              🤖 AI 실행 점검
            </h2>
            <p className="mt-0.5 text-[11px] text-[#9b9a97]">현재 워크스페이스 기준의 읽기 전용 실행 정보</p>
          </div>
          <button className="rounded px-2 py-0.5 text-[13px] text-[#9b9a97] hover:bg-[#efefed]" onClick={onClose}>
            ✕
          </button>
        </div>

        {!info ? (
          <div className="p-6 text-center text-[13px] text-[#9b9a97]">{error ?? '실행 정보를 불러오는 중…'}</div>
        ) : (
          <div className="space-y-5 p-5">
            <section>
              <div className="mb-2 flex items-end justify-between gap-3">
                <div>
                  <h3 className="text-[12px] font-medium text-[#37352f]">현재 공통 시스템 지시 전문</h3>
                  <p className="mt-0.5 text-[11px] text-[#9b9a97]">
                    정체성·스킬북 탐색·문서 저장·자율 수행 정책만 모든 실행에 전달합니다.
                  </p>
                </div>
                <button
                  className="shrink-0 rounded border border-[#e3e2e0] px-2 py-1 text-[10px] text-[#5f5e5b] hover:bg-[#f7f7f5]"
                  onClick={load}
                >
                  새로고침
                </button>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[#e9e9e7] bg-[#f7f7f5] p-3 font-mono text-[11px] leading-5 text-[#37352f]">
                {info.common_instructions || '(공통 지시사항 없음)'}
              </pre>
            </section>

            <section>
              <h3 className="mb-1 text-[12px] font-medium text-[#37352f]">프롬프트·조회 원본 구성</h3>
              <p className="mb-2 text-[11px] text-[#9b9a97]">
                공통 주입, Codex 자동 탐색, 필요 시 도구 조회 원본을 구분해서 표시합니다.
              </p>
              <div className="space-y-1.5">
                {info.prompts.map((prompt) => (
                  <PromptDetails key={prompt.id} prompt={prompt} />
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-1 text-[12px] font-medium text-[#37352f]">실행별 추가 입력</h3>
              <div className="rounded-md border border-[#e9e9e7]">
                {info.conditional_inputs.map((item) => (
                  <div key={item.title} className="border-b border-[#f1f1ef] px-3 py-2 last:border-b-0">
                    <p className="text-[11px] font-medium text-[#37352f]">{item.title}</p>
                    <p className="mt-0.5 text-[10px] text-[#9b9a97]">{item.when}</p>
                    <p className="mt-1 text-[11px] text-[#5f5e5b]">{item.description}</p>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-1 text-[12px] font-medium text-[#37352f]">스킬 프롬프트</h3>
              <p className="mb-2 text-[11px] text-[#9b9a97]">
                사용자가 직접 선택한 스킬만 해당 실행 지시에 추가됩니다. 본문 보기를 눌러 실제 지시를 확인하세요.
              </p>
              {skills.length ? (
                <div className="space-y-1.5">
                  {skills.map((skill) => (
                    <SkillPrompt
                      key={skill.path}
                      skill={skill}
                      body={skillBodies[skill.path]}
                      loading={loadingSkills.has(skill.path)}
                      onLoad={() => loadSkillBody(skill.path)}
                    />
                  ))}
                </div>
              ) : (
                <p className="rounded-md border border-dashed border-[#e3e2e0] px-3 py-3 text-[11px] text-[#9b9a97]">
                  등록된 스킬 노트가 없습니다.
                </p>
              )}
            </section>

            <section>
              <h3 className="mb-1 text-[12px] font-medium text-[#37352f]">도구 실행 정보</h3>
              <p className="mb-2 text-[11px] text-[#9b9a97]">
                현재 엔진: {info.tooling.engine.name}
                {info.tooling.engine.id ? ` (${info.tooling.engine.id})` : ''}
              </p>
              <div className="rounded-md border border-[#e9e9e7]">
                {info.tooling.items.map((item) => (
                  <div key={item.title} className="grid grid-cols-[110px_minmax(0,1fr)] gap-2 border-b border-[#f1f1ef] px-3 py-2 last:border-b-0">
                    <span className="text-[11px] font-medium text-[#37352f]">{item.title}</span>
                    <div>
                      <p className="text-[11px] text-[#5f5e5b]">{item.value}</p>
                      <p className="mt-0.5 text-[10px] text-[#9b9a97]">{item.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {error && <p className="rounded bg-[#fff2f2] px-3 py-2 text-[11px] text-[#c92a2a]">{error}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
