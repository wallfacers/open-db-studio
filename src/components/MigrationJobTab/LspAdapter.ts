import { invoke } from '@tauri-apps/api/core'
import type { editor, MarkerSeverity as MarkerSeverityType, languages, Range as MonacoRange, IDisposable } from 'monaco-editor'

export interface LspDiagnostic {
  severity: string
  message: string
  start_line: number
  start_col: number
  end_line: number
  end_col: number
}

export interface LspCompletionItem {
  label: string
  kind: string
  detail?: string
  insert_text?: string
}

export interface LspHoverInfo {
  contents: string
  start_line: number
  start_col: number
  end_line: number
  end_col: number
}

/**
 * Adapter that bridges Monaco editor to the Rust MigrateQL LSP via Tauri invoke.
 * Provides diagnostics (on content change), completion, hover, and formatting.
 */
export class MigrateQLLspAdapter {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private editorInstance: editor.IStandaloneCodeEditor
  private disposables: IDisposable[] = []
  private monacoApi: typeof import('monaco-editor')

  constructor(
    editorInstance: editor.IStandaloneCodeEditor,
    monacoApi: typeof import('monaco-editor'),
  ) {
    this.editorInstance = editorInstance
    this.monacoApi = monacoApi
  }

  start() {
    this.disposables.push(
      this.editorInstance.onDidChangeModelContent(() => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer)
        this.debounceTimer = setTimeout(() => {
          this.requestDiagnostics()
        }, 300)
      })
    )
  }

  dispose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.disposables.forEach(d => d.dispose())
  }

  private async requestDiagnostics() {
    const model = this.editorInstance.getModel()
    if (!model) return

    try {
      const diagnostics = await invoke<LspDiagnostic[]>('lsp_request', {
        method: 'textDocument/diagnostic',
        params: { text: model.getValue() },
      })

      const monaco = this.monacoApi
      const markers: editor.IMarkerData[] = diagnostics.map(d => ({
        severity: d.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : d.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
        message: d.message,
        startLineNumber: d.start_line + 1,
        startColumn: d.start_col + 1,
        endLineNumber: d.end_line + 1,
        endColumn: d.end_col + 2,
      }))

      monaco.editor.setModelMarkers(model, 'migrateql', markers)
    } catch (e) {
      console.error('LSP diagnostics error:', e)
    }
  }

  static registerCompletionProvider(
    monacoApi: typeof import('monaco-editor'),
  ): IDisposable {
    return monacoApi.languages.registerCompletionItemProvider('migrateql', {
      triggerCharacters: ['.', ' ', ':', ','],
      provideCompletionItems: async (model, position) => {
        try {
          const items = await invoke<LspCompletionItem[]>('lsp_request', {
            method: 'textDocument/completion',
            params: {
              text: model.getValue(),
              position: {
                line: position.lineNumber - 1,
                column: position.column - 1,
              },
            },
          })

          const kindMap: Record<string, languages.CompletionItemKind> = {
            keyword: monacoApi.languages.CompletionItemKind.Keyword,
            connection: monacoApi.languages.CompletionItemKind.Reference,
            database: monacoApi.languages.CompletionItemKind.Module,
            table: monacoApi.languages.CompletionItemKind.Struct,
            column: monacoApi.languages.CompletionItemKind.Field,
            type: monacoApi.languages.CompletionItemKind.TypeParameter,
            parameter: monacoApi.languages.CompletionItemKind.Property,
          }

          return {
            suggestions: items.map((item, i) => ({
              label: item.label,
              kind: kindMap[item.kind] || monacoApi.languages.CompletionItemKind.Text,
              detail: item.detail,
              insertText: item.insert_text || item.label,
              sortText: String(i).padStart(4, '0'),
              range: undefined as unknown as languages.CompletionItem['range'],
            })),
          }
        } catch {
          return { suggestions: [] }
        }
      },
    })
  }

  static registerHoverProvider(
    monacoApi: typeof import('monaco-editor'),
  ): IDisposable {
    return monacoApi.languages.registerHoverProvider('migrateql', {
      provideHover: async (model, position) => {
        try {
          const result = await invoke<LspHoverInfo | null>('lsp_request', {
            method: 'textDocument/hover',
            params: {
              text: model.getValue(),
              position: {
                line: position.lineNumber - 1,
                column: position.column - 1,
              },
            },
          })

          if (!result) return null

          return {
            contents: [{ value: result.contents }],
            range: new monacoApi.Range(
              result.start_line + 1, result.start_col + 1,
              result.end_line + 1, result.end_col + 2,
            ),
          }
        } catch {
          return null
        }
      },
    })
  }

  async format(): Promise<string | null> {
    const model = this.editorInstance.getModel()
    if (!model) return null

    try {
      const result = await invoke<string | null>('lsp_request', {
        method: 'textDocument/formatting',
        params: { text: model.getValue() },
      })
      return result
    } catch {
      return null
    }
  }
}
