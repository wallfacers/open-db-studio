import type { languages } from 'monaco-editor'

export const MIGRATEQL_LANGUAGE_ID = 'migrateql'

export const migrateqlLanguageConfig: languages.LanguageConfiguration = {
  comments: {
    lineComment: '--',
    blockComment: ['/*', '*/'],
  },
  brackets: [['(', ')']],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: "'", close: "'" },
    { open: '/*', close: '*/' },
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: "'", close: "'" },
  ],
}

export const migrateqlMonarchTokens: languages.IMonarchLanguage = {
  ignoreCase: true,
  keywords: [
    'MIGRATE', 'FROM', 'INTO', 'MAPPING', 'WHERE', 'SET', 'USE',
    'CONNECTION', 'ON', 'CONFLICT', 'UPSERT', 'REPLACE', 'SKIP',
    'INSERT', 'OVERWRITE', 'BY', 'INCREMENTAL', 'CREATE', 'IF',
    'NOT', 'EXISTS',
  ],
  tokenizer: {
    root: [
      [/--.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/'[^']*'/, 'string'],
      [/\$[A-Z_]+/, 'variable'],
      [/::/, 'operator'],
      [/->/, 'operator'],
      [/[(),;.]/, 'delimiter'],
      [/=/, 'operator'],
      [/[a-zA-Z_]\w*/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'identifier',
        },
      }],
      [/\d+/, 'number'],
      [/\s+/, 'white'],
    ],
    comment: [
      [/\*\//, 'comment', '@pop'],
      [/./, 'comment'],
    ],
  },
}

let registered = false

/**
 * Register MigrateQL as a Monaco language with Monarch tokenizer.
 * Must be called inside a beforeMount or onMount callback where `monaco` is available.
 */
export function registerMigrateQLLanguage(monaco: {
  languages: {
    register: typeof import('monaco-editor').languages.register
    setLanguageConfiguration: typeof import('monaco-editor').languages.setLanguageConfiguration
    setMonarchTokensProvider: typeof import('monaco-editor').languages.setMonarchTokensProvider
  }
}) {
  if (registered) return
  registered = true
  monaco.languages.register({ id: MIGRATEQL_LANGUAGE_ID })
  monaco.languages.setLanguageConfiguration(MIGRATEQL_LANGUAGE_ID, migrateqlLanguageConfig)
  monaco.languages.setMonarchTokensProvider(MIGRATEQL_LANGUAGE_ID, migrateqlMonarchTokens)
}
