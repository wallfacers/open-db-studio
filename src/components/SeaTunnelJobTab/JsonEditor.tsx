import React from 'react';
import MonacoEditor, { type BeforeMount } from '@monaco-editor/react';

interface JsonEditorProps {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}

const handleEditorWillMount: BeforeMount = (monaco) => {
  if (!monaco.editor.getModel(monaco.Uri.parse('inmemory://odb-json-theme'))) {
    monaco.editor.defineTheme('odb-dark-json', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'string.key.json',   foreground: '5eb2f7' },
        { token: 'string.value.json', foreground: 'e8a87c' },
        { token: 'number',            foreground: '9de0b2' },
        { token: 'keyword',           foreground: '00c9a7' },
        { token: 'delimiter',         foreground: '7a9bb8' },
      ],
      colors: {
        'editor.background':                  '#111922',
        'editorGutter.background':            '#0d1117',
        'editorLineNumber.foreground':        '#2a3f5a',
        'editorLineNumber.activeForeground':  '#00c9a7',
        'editor.lineHighlightBackground':     '#0e1e2e',
        'editor.lineHighlightBorder':         '#00000000',
        'editor.selectionBackground':         '#003d2f80',
        'editor.inactiveSelectionBackground': '#003d2f40',
        'editorCursor.foreground':            '#00c9a7',
        'editorWidget.background':            '#151d28',
        'editorWidget.border':                '#1e2d42',
        'scrollbarSlider.background':         '#1e2d4260',
        'scrollbarSlider.hoverBackground':    '#2a3f5a80',
      },
    });
  }
};

const JsonEditor: React.FC<JsonEditorProps> = ({ value, onChange, readOnly = false }) => {
  return (
    <MonacoEditor
      height="100%"
      language="json"
      theme="odb-dark-json"
      value={value}
      beforeMount={handleEditorWillMount}
      onChange={(v) => {
        if (!readOnly && v !== undefined) onChange(v);
      }}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        tabSize: 2,
        formatOnPaste: true,
        formatOnType: false,
        automaticLayout: true,
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
        },
      }}
    />
  );
};

export default JsonEditor;
