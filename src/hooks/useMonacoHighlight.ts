import { useRef, useCallback, useEffect } from 'react'
import type * as Monaco from 'monaco-editor'

const PULSE_DURATION = 2400

/**
 * Compute changed line numbers between two strings (1-based).
 * If the line count difference exceeds 50%, returns null (= fallback to full flash).
 */
function diffLines(oldText: string, newText: string): number[] | null {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  const maxLen = Math.max(oldLines.length, newLines.length)
  if (maxLen === 0) return null
  const minLen = Math.min(oldLines.length, newLines.length)
  if (maxLen > 0 && (maxLen - minLen) / maxLen > 0.5) return null

  const changed: number[] = []
  for (let i = 0; i < maxLen; i++) {
    if ((oldLines[i] ?? '') !== (newLines[i] ?? '')) {
      changed.push(i + 1)
    }
  }
  return changed
}

function linesToDecorations(
  lines: number[],
  className: string,
  glyphClassName?: string,
): Monaco.editor.IModelDeltaDecoration[] {
  return lines.map(line => ({
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    options: {
      isWholeLine: true,
      className,
      glyphMarginClassName: glyphClassName,
    },
  }))
}

/**
 * Generic hook for Monaco editor AI change highlighting.
 *
 * Usage:
 *   const { notifyContentChange } = useMonacoHighlight(editorRef)
 *   // When external (AI) content arrives:
 *   notifyContentChange(oldJson, newJson)
 */
export function useMonacoHighlight(
  editorRef: React.RefObject<Monaco.editor.IStandaloneCodeEditor | null>,
) {
  const decorationIdsRef = useRef<string[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const rafRef = useRef<number>()
  const disposableRef = useRef<Monaco.IDisposable>()

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      disposableRef.current?.dispose()
    }
  }, [])

  const notifyContentChange = useCallback(
    (oldValue: string, newValue: string) => {
      const editor = editorRef.current
      if (!editor) return

      // Clear previous state
      decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, [])
      if (timerRef.current) clearTimeout(timerRef.current)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      disposableRef.current?.dispose()

      const changedLines = diffLines(oldValue, newValue)

      // Defer decoration to next frame — @monaco-editor/react updates the model
      // via a useEffect when the `value` prop changes. Our useEffect fires in the
      // same commit cycle, so the model may still hold the OLD content. Waiting one
      // frame guarantees the model has been updated and onDidChangeModelContent from
      // the programmatic value change has already fired and settled.
      rafRef.current = requestAnimationFrame(() => {
        const ed = editorRef.current
        if (!ed) return

        // Recalculate against actual model content to get correct line numbers
        const modelContent = ed.getModel()?.getValue() ?? ''
        const actualLines = diffLines(oldValue, modelContent)

        let targetLines: number[]
        if (actualLines === null || actualLines.length === 0) {
          const lineCount = ed.getModel()?.getLineCount() ?? 0
          if (lineCount === 0) return
          targetLines = Array.from({ length: lineCount }, (_, i) => i + 1)
        } else {
          targetLines = actualLines
        }

        // Phase 1: Pulse
        decorationIdsRef.current = ed.deltaDecorations(
          [],
          linesToDecorations(targetLines, 'ai-line-pulse'),
        )

        // Phase 2: Residual after pulse ends
        timerRef.current = setTimeout(() => {
          if (!editorRef.current) return
          decorationIdsRef.current = editorRef.current.deltaDecorations(
            decorationIdsRef.current,
            linesToDecorations(targetLines, 'ai-line-residual', 'ai-gutter-residual'),
          )
        }, PULSE_DURATION)

        // Clear decorations when user manually edits highlighted lines
        disposableRef.current = ed.onDidChangeModelContent((e) => {
          if (!editorRef.current) return
          const editedLines = new Set<number>()
          for (const change of e.changes) {
            for (let l = change.range.startLineNumber; l <= change.range.endLineNumber; l++) {
              editedLines.add(l)
            }
          }
          const remaining = linesToDecorations(
            targetLines.filter(l => !editedLines.has(l)),
            'ai-line-residual',
            'ai-gutter-residual',
          )
          decorationIdsRef.current = editorRef.current.deltaDecorations(
            decorationIdsRef.current,
            remaining,
          )
          targetLines = targetLines.filter(l => !editedLines.has(l))
          if (targetLines.length === 0) {
            disposableRef.current?.dispose()
          }
        })
      })
    },
    [editorRef],
  )

  return { notifyContentChange }
}
