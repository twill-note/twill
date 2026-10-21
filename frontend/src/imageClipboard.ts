import { useEffect, type RefObject } from 'react'
import type { BlockNoteEditor } from '@blocknote/core'
import { dialog } from './dialog'

/** Rasterize at natural size so SVG and bitmap blocks paste as an actual image. */
export async function copyImageToClipboard(url: string): Promise<void> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = url
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context || !canvas.width || !canvas.height) throw new Error('이미지를 읽을 수 없습니다.')
  context.drawImage(image, 0, 0)
  if (window.noteDesktop?.copyImage) {
    await window.noteDesktop.copyImage(canvas.toDataURL('image/png'))
  } else {
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      value => value ? resolve(value) : reject(new Error('이미지 변환에 실패했습니다.')), 'image/png',
    ))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  }
}

// The shared editor schema contains custom blocks in addition to BlockNote defaults.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useImageClipboard(wrapperRef: RefObject<HTMLDivElement | null>, editor: BlockNoteEditor<any, any, any>) {
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const onCopy = (event: ClipboardEvent) => {
      const target = event.target
      if (!(target instanceof Element) || target.closest('input, textarea') || !target.closest('.bn-editor')) return
      const fragment = editor.prosemirrorState.selection.content().content
      if (fragment.childCount !== 1) return
      let node = fragment.firstChild
      if (node?.type.name === 'blockContainer' && node.childCount === 1) node = node.firstChild
      // Mixed block/text selections keep BlockNote's normal rich-text copy behavior.
      if (node?.type.name !== 'image' || typeof node.attrs.url !== 'string' || !node.attrs.url) return
      event.preventDefault()
      event.stopPropagation()
      void copyImageToClipboard(node.attrs.url).catch(error => {
        void dialog.alert('이미지 복사에 실패했습니다: ' + (error as Error).message)
      })
    }
    wrapper.addEventListener('copy', onCopy, true)
    return () => wrapper.removeEventListener('copy', onCopy, true)
  }, [wrapperRef, editor])
}
