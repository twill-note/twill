import { ensureKoreanFontLoaded } from './fontFamilies'

const PRINT_CSS = `
#twill-print-document { display: none; }
@media print {
  @page { size: A4; margin: 16mm; background: white; }
  html[data-theme][data-theme], html[data-theme][data-theme] body { color-scheme: light !important; height: auto !important; overflow: visible !important; background: white !important; }
  body > *:not(#twill-print-document) { display: none !important; }
  #twill-print-document { display: block !important; color: #222 !important; background: white !important; font: 11pt/1.6 "Noto Sans KR", sans-serif; }
  #twill-print-document h1 { font-size: 24pt; margin: 0 0 8mm; }
  #twill-print-document .bn-editor { padding: 0 !important; background: white !important; color: #222 !important; font-family: "Noto Sans KR", sans-serif !important; }
  #twill-print-document [data-node-type="blockContainer"] { overflow: visible !important; }
  #twill-print-document [data-content-type="columnList"] { display: flex !important; gap: 5mm; }
  #twill-print-document [data-content-type="column"] { min-width: 0 !important; }
  #twill-print-document img, #twill-print-document svg { max-width: 100% !important; height: auto; }
  #twill-print-document img, #twill-print-document .mermaid-preview { break-inside: avoid; }
  #twill-print-document .mermaid-preview { overflow: visible !important; background: white !important; }
  #twill-print-document pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  #twill-print-document [data-content-type="codeBlock"] { background: #f3f3f3 !important; color: #222 !important; }
  #twill-print-document [data-content-type="codeBlock"] span { color: #222 !important; }
  #twill-print-document table { width: 100%; border-collapse: collapse; }
  #twill-print-document td, #twill-print-document th { border: 1px solid #ccc; padding: 2mm; }
}
`

/** Export only this editor's current DOM, including edits not yet auto-saved. */
export async function exportDocumentPdf(editor: HTMLElement, title: string): Promise<void> {
  if (document.getElementById('twill-print-document')) throw new Error('PDF 내보내기가 이미 진행 중입니다.')
  await ensureKoreanFontLoaded()
  await document.fonts.ready
  const output = document.createElement('article')
  output.id = 'twill-print-document'
  output.dataset.theme = 'paper'
  const heading = document.createElement('h1')
  heading.textContent = title || '제목 없음'
  const copy = editor.cloneNode(true) as HTMLElement
  copy.querySelectorAll('button, textarea, input, [role="toolbar"], [data-image-annotate], .bn-side-menu').forEach((node) => node.remove())
  copy.querySelectorAll('[contenteditable]').forEach((node) => node.removeAttribute('contenteditable'))
  output.append(heading, copy)
  const style = document.createElement('style')
  style.textContent = PRINT_CSS
  output.append(style)
  document.body.append(output)
  try {
    const diagrams = copy.querySelectorAll<HTMLElement>('[data-mermaid-source]')
    if (diagrams.length) {
      const { renderMermaidForExport } = await import('./components/MermaidBlock')
      for (const [index, diagram] of [...diagrams].entries()) {
        diagram.innerHTML = await renderMermaidForExport(diagram.dataset.mermaidSource ?? '', `pdf-mermaid-${Date.now()}-${index}`)
      }
    }
    await Promise.all([...copy.querySelectorAll('img')].map(async (img) => {
      img.loading = 'eager'
      await img.decode()
    }))
    await document.fonts.ready
    if (window.noteDesktop?.exportPdf) await window.noteDesktop.exportPdf(title || '문서')
    else window.print()
  } finally { output.remove() }
}
