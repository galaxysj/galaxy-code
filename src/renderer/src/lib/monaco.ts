import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

// Files open on their own, without the project's tsconfig or packages, so type errors would be noise.
for (const defaults of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
  defaults.setCompilerOptions({ ...defaults.getCompilerOptions(), jsx: monaco.languages.typescript.JsxEmit.Preserve, allowJs: true, allowNonTsExtensions: true })
}

function token(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  // Monaco takes hex colors only.
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : ''
}

/** Monaco themes that take the app's background and accent colors. Call again when the app theme changes. */
export function applyMonacoTheme(): void {
  const dark = document.documentElement.dataset.theme !== 'light'
  const bg = token('--bg') || (dark ? '#161616' : '#ffffff')
  monaco.editor.defineTheme('galaxy', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editorGutter.background': bg,
      'minimap.background': bg,
      'editorLineNumber.foreground': token('--fg-subtle') || (dark ? '#6a6a67' : '#a0a09c'),
      'editorLineNumber.activeForeground': token('--fg') || (dark ? '#e7e7e5' : '#1a1a19'),
      'editorCursor.foreground': token('--fg') || (dark ? '#e7e7e5' : '#1a1a19')
    }
  })
  monaco.editor.setTheme('galaxy')
}

export { monaco }
