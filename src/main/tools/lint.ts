import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { displayPath, exists, resolvePath, truncateEnd, which } from '../util'
import { ToolInputError, type ToolDef } from './types'

interface Linter {
  name: string
  command: string
  args: string[]
  /** Runs on the whole project; output lines are filtered to the requested paths instead. */
  wholeProject?: boolean
}

function runLinter(linter: Linter, cwd: string, signal: AbortSignal): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(linter.command, linter.args, { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const append = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-400000) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000)
    child.on('error', (error) => { clearTimeout(timer); done({ code: -1, output: output + error.message }) })
    child.on('close', (code) => { clearTimeout(timer); done({ code: code ?? -1, output }) })
  })
}

/** tsconfig.json may be JSONC. A solution file lists references and no files of its own. */
async function tsconfigTargets(cwd: string): Promise<string[]> {
  const root = join(cwd, 'tsconfig.json')
  try {
    const text = (await readFile(root, 'utf8')).replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1')
    const config = JSON.parse(text) as { files?: unknown[]; include?: unknown[]; references?: { path: string }[] }
    if (config.references?.length && !config.files?.length && !config.include?.length) {
      return Promise.all(config.references.map(async (ref) => {
        const target = join(cwd, ref.path)
        return (await stat(target).catch(() => null))?.isDirectory() ? join(target, 'tsconfig.json') : target
      }))
    }
  } catch {
    // Unreadable config: let tsc report it.
  }
  return [root]
}

async function detectLinters(cwd: string, paths: string[]): Promise<Linter[]> {
  const files = new Set(await readdir(cwd).catch(() => [] as string[]))
  const targets = paths.length ? paths : ['.']
  const linters: Linter[] = []
  const bin = (name: string): string => join(cwd, 'node_modules', '.bin', name)
  let pkg: { eslintConfig?: unknown } = {}
  if (files.has('package.json')) pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8').catch(() => '{}')) as typeof pkg
  const eslintConfig = [...files].some((file) => /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?)$/.test(file)) || !!pkg.eslintConfig
  if (eslintConfig && (await exists(bin('eslint')))) linters.push({ name: 'eslint', command: bin('eslint'), args: ['--format', 'unix', '--no-color', ...targets] })
  if (files.has('tsconfig.json') && (await exists(bin('tsc')))) {
    for (const config of await tsconfigTargets(cwd)) {
      linters.push({ name: `tsc (${relative(cwd, config)})`, command: bin('tsc'), args: ['--noEmit', '--pretty', 'false', '-p', config], wholeProject: true })
    }
  }
  if (files.has('biome.json') && (await exists(bin('biome')))) linters.push({ name: 'biome', command: bin('biome'), args: ['lint', '--colors=off', ...targets] })
  const ruff = files.has('pyproject.toml') || files.has('ruff.toml') || files.has('.ruff.toml') ? await which('ruff') : null
  if (ruff) linters.push({ name: 'ruff', command: ruff, args: ['check', '--output-format', 'concise', ...targets] })
  const go = files.has('go.mod') ? await which('go') : null
  if (go) linters.push({ name: 'go vet', command: go, args: ['vet', './...'], wholeProject: true })
  const cargo = files.has('Cargo.toml') ? await which('cargo') : null
  if (cargo) linters.push({ name: 'cargo check', command: cargo, args: ['check', '--message-format', 'short', '--color', 'never'], wholeProject: true })
  return linters
}

/** Keeps the diagnostics of a whole-project run that name one of the requested paths. */
function filterToPaths(output: string, paths: string[]): string {
  if (!paths.length || paths.includes('.')) return output
  const prefixes = paths.map((path) => path.replace(/^\.\//, '').replace(/\/$/, ''))
  return output.split('\n').filter((line) => prefixes.some((prefix) => line.startsWith(prefix))).join('\n')
}

export const lintTool: ToolDef = {
  name: 'Lint',
  kind: 'lint',
  description:
    "Run the project's own linters and type checkers and return their diagnostics: ESLint, TypeScript (tsc --noEmit), Biome, Ruff, go vet and cargo check, whichever the project is set up with. Use it after editing code to catch errors, or to see what is broken before a fix. Pass paths to check only those files or folders; leave them out to check the whole project. Nothing is changed or auto-fixed.",
  parameters: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders to check, relative to the working directory. Defaults to the whole project.' }
    }
  },
  present(input, ctx) {
    const paths = Array.isArray(input.paths) ? input.paths.map(String) : []
    return { title: paths.length ? `Lint ${paths.map((path) => displayPath(ctx.cwd, path)).join(', ')}` : 'Lint project' }
  },
  async execute(input, ctx) {
    if (input.paths !== undefined && !Array.isArray(input.paths)) throw new ToolInputError('Parameter paths must be an array of strings')
    const paths = ((input.paths as unknown[] | undefined) ?? []).map((path) => relative(ctx.cwd, resolvePath(ctx.cwd, String(path))) || '.')
    if (paths.some((path) => path.startsWith('..'))) throw new ToolInputError('Lint only checks paths inside the working directory')
    const linters = await detectLinters(ctx.cwd, paths)
    if (!linters.length) return { text: 'No linter or type checker is set up in this project (looked for ESLint, TypeScript, Biome, Ruff, go vet and cargo check). Check with Bash if the project lints another way.' }
    const sections: string[] = []
    let clean = 0
    for (const linter of linters) {
      if (ctx.signal.aborted) break
      const result = await runLinter(linter, ctx.cwd, ctx.signal)
      const output = (linter.wholeProject ? filterToPaths(result.output, paths) : result.output).trim()
      // A whole-project check that failed only on other files is clean for the requested paths.
      const passed = !output && (result.code === 0 || !!linter.wholeProject && paths.length > 0 && !paths.includes('.') && /error|warning/i.test(result.output))
      if (passed) clean++
      const status = passed ? ': no problems' : output ? '' : `: exited with code ${result.code}\n${result.output.trim()}`
      sections.push(`## ${linter.name}${status}\n${output}`.trim())
    }
    const summary = clean === linters.length ? 'No problems found.' : `${linters.length - clean} of ${linters.length} checks reported problems.`
    return { text: truncateEnd(`${summary}\n\n${sections.join('\n\n')}`, 60000) }
  }
}
