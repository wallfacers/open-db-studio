import { useRef, useCallback, useEffect } from 'react'
import MonacoEditor, { type BeforeMount, type OnMount, type Monaco } from '@monaco-editor/react'
import type { editor as MonacoEditorType, Position, CancellationToken, languages } from 'monaco-editor'
import { invoke } from '@tauri-apps/api/core'
import { registerMigrateQLLanguage, MIGRATEQL_LANGUAGE_ID } from './MonarchTokenizer'
import { MigrateQLLspAdapter } from './LspAdapter'

interface Props {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  ghostTextEnabled?: boolean
}

const handleEditorWillMount: BeforeMount = (monaco) => {
  registerMigrateQLLanguage(monaco)

  // Define the same dark theme used elsewhere in the app
  monaco.editor.defineTheme('odb-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword',    foreground: '5eb2f7', fontStyle: 'bold' },
      { token: 'string',     foreground: 'e8a87c' },
      { token: 'number',     foreground: '9de0b2' },
      { token: 'comment',    foreground: '4caf76', fontStyle: 'italic' },
      { token: 'identifier', foreground: 'c8daea' },
      { token: 'operator',   foreground: '88d8ff' },
      { token: 'delimiter',  foreground: '7a9bb8' },
      { token: 'variable',   foreground: 'f0b040' },
    ],
    colors: {
      'editor.background':                 '#1E293B',
      'editorGutter.background':           '#0F172A',
      'editorLineNumber.foreground':       '#475569',
      'editorLineNumber.activeForeground': '#10B981',
      'editor.lineHighlightBackground':    '#25236340',
      'editor.lineHighlightBorder':        '#00000000',
      'editor.selectionBackground':        '#064E3B80',
      'editor.inactiveSelectionBackground':'#064E3B40',
      'editorCursor.foreground':           '#10B981',
      'editorIndentGuide.background1':     '#334155',
      'editorIndentGuide.activeBackground1':'#475569',
      'editorWidget.background':           '#27354F',
      'editorWidget.border':               '#334155',
      'editorSuggestWidget.background':    '#27354F',
      'editorSuggestWidget.border':        '#334155',
      'editorSuggestWidget.selectedBackground': '#064E3B',
      'list.hoverBackground':              '#334155',
      'list.activeSelectionBackground':    '#064E3B',
      'scrollbarSlider.background':        '#33415560',
      'scrollbarSlider.hoverBackground':   '#47556980',
      'menu.background':                   '#27354F',
      'menu.foreground':                   '#E2E8F0',
      'menu.selectionBackground':          '#334155',
      'menu.selectionForeground':          '#ffffff',
      'menu.separatorBackground':          '#475569',
      'menu.border':                       '#475569',
    },
  })
}

export function MigrationEditor({ value, onChange, onSave, ghostTextEnabled }: Props) {
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null)
  const lspAdapterRef = useRef<MigrateQLLspAdapter | null>(null)
  const lspDisposablesRef = useRef<{ dispose(): void }[]>([])
  const onSaveRef = useRef(onSave)
  useEffect(() => { onSaveRef.current = onSave }, [onSave])
  const ghostTextRef = useRef(ghostTextEnabled ?? false)
  useEffect(() => { ghostTextRef.current = ghostTextEnabled ?? false }, [ghostTextEnabled])
  const ghostTextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleEditorDidMount: OnMount = useCallback((editor, monaco: Monaco) => {
    editorRef.current = editor

    // Register LSP providers (static, shared across all editors)
    lspDisposablesRef.current.push(
      MigrateQLLspAdapter.registerCompletionProvider(monaco as unknown as typeof import('monaco-editor')),
      MigrateQLLspAdapter.registerHoverProvider(monaco as unknown as typeof import('monaco-editor')),
    )

    // Create per-editor LSP adapter for diagnostics
    const adapter = new MigrateQLLspAdapter(
      editor,
      monaco as unknown as typeof import('monaco-editor'),
    )
    adapter.start()
    lspAdapterRef.current = adapter

    // Ghost Text inline completion with debounce
    lspDisposablesRef.current.push(
      monaco.languages.registerInlineCompletionsProvider(MIGRATEQL_LANGUAGE_ID, {
        provideInlineCompletions: async (model: MonacoEditorType.ITextModel, position: Position, _context: languages.InlineCompletionContext, _token: CancellationToken) => {
          if (!ghostTextRef.current) return { items: [] }
          // Debounce: cancel previous timer, wait 500ms of cursor silence before LLM call
          return new Promise<languages.InlineCompletions<languages.InlineCompletion>>((resolve) => {
            if (ghostTextTimerRef.current) clearTimeout(ghostTextTimerRef.current)
            ghostTextTimerRef.current = setTimeout(async () => {
              try {
                const result = await invoke<string | null>('lsp_request', {
                  method: 'textDocument/inlineCompletion',
                  params: {
                    text: model.getValue(),
                    position: {
                      line: position.lineNumber - 1,
                      column: position.column - 1,
                    },
                  },
                })
                if (!result) return resolve({ items: [] })
                resolve({
                  items: [{
                    insertText: result,
                    range: new monaco.Range(
                      position.lineNumber, position.column,
                      position.lineNumber, position.column,
                    ),
                  }],
                })
              } catch {
                resolve({ items: [] })
              }
            }, 500)
          })
        },
        freeInlineCompletions: () => {
          if (ghostTextTimerRef.current) {
            clearTimeout(ghostTextTimerRef.current)
            ghostTextTimerRef.current = null
          }
        },
      }),
    )

    // Ctrl+S keybinding
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current()
    })

    // Trigger initial diagnostics
    adapter['requestDiagnostics']()
  }, [])

  useEffect(() => {
    return () => {
      lspAdapterRef.current?.dispose()
      lspDisposablesRef.current.forEach(d => d.dispose())
      lspDisposablesRef.current = []
    }
  }, [])

  return (
    <MonacoEditor
      height="100%"
      language={MIGRATEQL_LANGUAGE_ID}
      theme="odb-dark"
      beforeMount={handleEditorWillMount}
      onMount={handleEditorDidMount}
      value={value}
      onChange={(val) => onChange(val ?? '')}
      options={{
        fontSize: 16,
        fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        lineNumbers: 'on',
        lineNumbersMinChars: 3,
        renderLineHighlight: 'line',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        formatOnPaste: true,
        tabSize: 2,
        padding: { top: 12, bottom: 12 },
        glyphMargin: true,
        automaticLayout: true,
        overviewRulerBorder: false,
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        contextmenu: false,
      }}
    />
  )
}
