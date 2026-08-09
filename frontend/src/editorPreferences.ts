export type EditorWidth = 'normal' | 'wide' | 'full'

export function readEditorWidth(value: string | null): EditorWidth {
  return value === 'normal' || value === 'wide' || value === 'full' ? value : 'full'
}

export function readSpellcheckEnabled(value: string | null): boolean {
  return value === 'on'
}
