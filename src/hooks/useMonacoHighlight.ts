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

  // Fallback if structure changed too much
  const maxLen = Math.max(oldLines.length, newLines.length)
  if (maxLen === 0) return null
  const minLen = Math.min(oldLines.length, newLines.length)
  if (maxLen > 0 && (maxLen - minLen) / maxLen > 0.5) return null

  const changed: number[] = []
  for (let i = 0; i < maxLen; i++) {
    if ((oldLines[i] ?? '') !== (newLines[i] ?? '')) {
      changed.push(i + 1) // Monaco lines are 1-based
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
  const disposableRef = useRef<Monaco.IDisposable>()

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      disposableRef.current?.dispose()
    }
  }, [])

  const notifyContentChange = useCallback(
    (oldValue: string, newValue: string) => {
      const editor = editorRef.current
      if (!editor) return

      // Clear previous decorations
      decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, [])
      if (timerRef.current) clearTimeout(timerRef.current)
      disposableRef.current?.dispose()

      const changedLines = diffLines(oldValue, newValue)

      let targetLines: number[]
      if (changedLines === null || changedLines.length === 0) {
        // Fallback: flash all lines
        const lineCount = editor.getModel()?.getLineCount() ?? 0
        if (lineCount === 0) return
        targetLines = Array.from({ length: lineCount }, (_, i) => i + 1)
      } else {
        targetLines = changedLines
      }

      // Phase 1: Pulse decorations
      decorationIdsRef.current = editor.deltaDecorations(
        [],
        linesToDecorations(targetLines, 'ai-line-pulse'),
      )

      // Phase 2: After pulse ends, switch to residual
      timerRef.current = setTimeout(() => {
        if (!editorRef.current) return
        decorationIdsRef.current = editorRef.current.deltaDecorations(
          decorationIdsRef.current,
          linesToDecorations(targetLines, 'ai-line-residual', 'ai-gutter-residual'),
        )
      }, PULSE_DURATION)

      // Clear residual decorations on user edit in those lines
      disposableRef.current = editor.onDidChangeModelContent((e) => {
        if (!editorRef.current) return
        const editedLines = new Set<number>()
        for (const change of e.changes) {
          for (let l = change.range.startLineNumber; l <= change.range.endLineNumber; l++) {
            editedLines.add(l)
          }
        }
        // Remove decorations for edited lines
        const remaining = linesToDecorations(
          targetLines.filter(l => !editedLines.has(l)),
          'ai-line-residual',
          'ai-gutter-residual',
        )
        decorationIdsRef.current = editorRef.current.deltaDecorations(
          decorationIdsRef.current,
          remaining,
        )
        // Update targetLines
        targetLines = targetLines.filter(l => !editedLines.has(l))
        if (targetLines.length === 0) {
          disposableRef.current?.dispose()
        }
      })
    },
    [editorRef],
  )

  return { notifyContentChange }
}
