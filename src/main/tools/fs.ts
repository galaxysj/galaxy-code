import { spawn } from 'node:child_process'
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { rgPath as bundledRgPath } from '@vscode/ripgrep'
import type { ToolItem } from '@shared/types'
import { skillNameForPath } from '../services/skills'
import { displayPath, exists, isImagePath, looksBinary, mimeOf, resolvePath, truncateEnd } from '../util'
import { makeDiff } from './diff'
import { applyEditPatch, parseEditPatch, patchFiles, previewEditPatch } from './patch'
import { bool, num, plural, str, ToolInputError, type ToolDef } from './types'

const rgPath = bundledRgPath.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')

const MAX_READ_LINES = 2000
const MAX_LINE_LENGTH = 2000
const MAX_READ_BYTES = 8 * 1024 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', '.cache', '.turbo', 'DerivedData'])

function runRg(args: string[], cwd: string, signal: AbortSignal, maxBytes = 2_000_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(rgPath, args, { cwd, signal })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8')
      else child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', fail)
    child.on('close', (code) => done({ code: code ?? 0, stdout, stderr }))
  })
}

export const readTool: ToolDef = {
  name: 'Read',
  kind: 'read',
  parallel: true,
  description:
    'Read a file from disk. Returns numbered lines. Reads up to 2000 lines from the start unless `offset` and `limit` are given; use them for large files. Also reads images (PNG, JPG, GIF, WebP), which are shown to you visually. To use a skill, Read its SKILL.md.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path, or a path relative to the working directory.' },
      offset: { type: 'integer', description: '1-based line number to start from.' },
      limit: { type: 'integer', description: 'Maximum number of lines to return.' }
    },
    required: ['path']
  },
  present(input, ctx) {
    const path = String(input.path ?? '')
    const abs = resolvePath(ctx.cwd, path)
    const skill = skillNameForPath(abs, ctx.skills)
    if (skill) return { title: `Read ${skill} skill`, meta: { skill } }
    const offset = Number(input.offset) || 0
    const limit = Number(input.limit) || 0
    const range = offset || limit ? ` L${offset || 1}${limit ? `-${(offset || 1) + limit - 1}` : ''}` : ''
    return { title: `Read ${basename(abs)}${range}`, detail: displayPath(ctx.cwd, abs) }
  },
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, str(input, 'path', true))
    const info = await stat(abs).catch(() => null)
    if (!info) throw new Error(`File not found: ${abs}`)
    if (info.isDirectory()) throw new Error(`${abs} is a directory. Use List to see its contents.`)

    if (isImagePath(abs)) {
      if (info.size > 15 * 1024 * 1024) throw new Error('Image is larger than 15 MB')
      const data = await readFile(abs)
      return { text: `Image ${basename(abs)} (${Math.round(info.size / 1024)} KB)`, images: [{ mime: mimeOf(abs), base64: data.toString('base64') }] }
    }
    if (/\.pdf$/i.test(abs)) {
      throw new Error('PDF files cannot be read directly. Extract the text with a shell tool such as `pdftotext` first.')
    }

    const handle = await open(abs, 'r')
    let buffer: Buffer
    try {
      buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES))
      await handle.read(buffer, 0, buffer.length, 0)
    } finally {
      await handle.close()
    }
    if (looksBinary(buffer)) throw new Error(`${basename(abs)} looks like a binary file and cannot be read as text`)

    const lines = buffer.toString('utf8').split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const total = lines.length
    const offset = Math.max(1, Math.floor(num(input, 'offset') ?? 1))
    const limit = Math.max(1, Math.floor(num(input, 'limit') ?? MAX_READ_LINES))
    if (offset > total && total > 0) throw new Error(`offset ${offset} is past the end of the file (${total} lines)`)

    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const width = String(offset + slice.length - 1).length
    const body = slice
      .map((line, i) => `${String(offset + i).padStart(width)}\t${line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + ' [line truncated]' : line}`)
      .join('\n')

    const end = offset + slice.length - 1
    const notes: string[] = []
    if (end < total) notes.push(`[Showing lines ${offset}-${end} of ${total}. Use offset to read more.]`)
    if (info.size > MAX_READ_BYTES) notes.push(`[File is ${Math.round(info.size / 1024 / 1024)} MB, only the first 8 MB was loaded.]`)
    if (total === 0) notes.push('[File is empty]')
    return { text: [body, ...notes].filter(Boolean).join('\n'), meta: { lines: slice.length } }
  }
}

export const grepTool: ToolDef = {
  name: 'Grep',
  kind: 'grep',
  parallel: true,
  description:
    'Search file contents with a regular expression (ripgrep syntax). Respects .gitignore. Use `output_mode` "files_with_matches" (default) to find which files match, "content" to see matching lines, "count" for per-file counts.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the working directory.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts" or "src/**/*.{ts,tsx}".' },
      output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
      case_insensitive: { type: 'boolean' },
      context: { type: 'integer', description: 'Lines of context around each match, for "content" mode.' },
      multiline: { type: 'boolean', description: 'Let patterns span lines.' },
      head_limit: { type: 'integer', description: 'Maximum lines of output. Defaults to 200.' }
    },
    required: ['pattern']
  },
  present(input, ctx) {
    const scope = input.path ? ` in ${displayPath(ctx.cwd, String(input.path))}` : input.glob ? ` in ${String(input.glob)}` : ''
    return { title: `Grep ${JSON.stringify(String(input.pattern ?? ''))}${scope}`, meta: { query: String(input.pattern ?? '') } }
  },
  async execute(input, ctx) {
    const pattern = str(input, 'pattern', true)
    const mode = str(input, 'output_mode') ?? 'files_with_matches'
    const target = input.path ? resolvePath(ctx.cwd, str(input, 'path', true)) : ctx.cwd
    if (!(await exists(target))) throw new Error(`Path not found: ${target}`)

    const args = ['--color', 'never', '--no-messages', '--max-columns', '400', '--max-columns-preview']
    if (mode === 'files_with_matches') args.push('--files-with-matches', '--sortr', 'modified')
    else if (mode === 'count') args.push('--count')
    else args.push('--line-number', '--no-heading')
    if (bool(input, 'case_insensitive')) args.push('--ignore-case')
    if (bool(input, 'multiline')) args.push('--multiline', '--multiline-dotall')
    const context = num(input, 'context')
    if (mode === 'content' && context) args.push('--context', String(Math.min(20, Math.max(0, Math.floor(context)))))
    const glob = str(input, 'glob')
    if (glob) args.push('--glob', glob)
    args.push('--regexp', pattern, target)

    const result = await runRg(args, ctx.cwd, ctx.signal)
    if (result.code > 1 && !result.stdout) throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`)

    const prefix = target.endsWith('/') ? target : target + '/'
    const lines = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
    if (lines.length === 0) return { text: 'No matches found.', meta: { matches: 0 } }

    const limit = Math.max(1, Math.floor(num(input, 'head_limit') ?? 200))
    const shown = lines.slice(0, limit)
    const more = lines.length > limit ? `\n[${lines.length - limit} more lines not shown. Narrow the search or raise head_limit.]` : ''
    const matches = mode === 'content' ? lines.filter((l) => /^[^:]*:\d+:/.test(l) || /^\d+:/.test(l)).length : lines.length
    return { text: truncateEnd(shown.join('\n'), 60000) + more, meta: { matches } }
  }
}

export const globTool: ToolDef = {
  name: 'Glob',
  kind: 'glob',
  parallel: true,
  description:
    'Find files by name pattern, e.g. "**/*.tsx" or "src/**/test_*.py". Respects .gitignore. Results are sorted by most recently modified.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match file paths against.' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the working directory.' }
    },
    required: ['pattern']
  },
  present(input, ctx) {
    const scope = input.path ? ` in ${displayPath(ctx.cwd, String(input.path))}` : ''
    return { title: `Glob ${String(input.pattern ?? '')}${scope}`, meta: { query: String(input.pattern ?? '') } }
  },
  async execute(input, ctx) {
    const pattern = str(input, 'pattern', true)
    const root = input.path ? resolvePath(ctx.cwd, str(input, 'path', true)) : ctx.cwd
    if (!(await exists(root))) throw new Error(`Directory not found: ${root}`)
    const result = await runRg(['--files', '--hidden', '--glob', '!.git', '--glob', pattern, '--sortr', 'modified'], root, ctx.signal)
    if (result.code > 1 && !result.stdout) throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`)
    const files = result.stdout.split('\n').filter(Boolean)
    if (files.length === 0) return { text: 'No files found.', meta: { matches: 0 } }
    const shown = files.slice(0, 200)
    const more = files.length > 200 ? `\n[${files.length - 200} more files not shown. Use a narrower pattern.]` : ''
    return { text: shown.join('\n') + more, meta: { matches: files.length } }
  }
}

export const listTool: ToolDef = {
  name: 'List',
  kind: 'list',
  parallel: true,
  description:
    'List a directory. Directories end with "/". Dependency and build folders such as node_modules and .git are shown but not expanded. Use `depth` up to 3 to see nested contents.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list. Defaults to the working directory.' },
      depth: { type: 'integer', description: 'How many levels to descend, 1 to 3. Defaults to 1.' }
    }
  },
  present(input, ctx) {
    return { title: `List ${displayPath(ctx.cwd, String(input.path ?? '.'))}` }
  },
  async execute(input, ctx) {
    const root = resolvePath(ctx.cwd, str(input, 'path') ?? '.')
    const info = await stat(root).catch(() => null)
    if (!info) throw new Error(`Directory not found: ${root}`)
    if (!info.isDirectory()) throw new Error(`${root} is a file. Use Read to see its contents.`)
    const maxDepth = Math.min(3, Math.max(1, Math.floor(num(input, 'depth') ?? 1)))
    const lines: string[] = []
    let truncated = false

    const walk = async (dir: string, depth: number, indent: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (entry.name === '.DS_Store') continue
        if (lines.length >= 500) {
          truncated = true
          return
        }
        if (entry.isDirectory()) {
          lines.push(`${indent}${entry.name}/`)
          if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name), depth + 1, indent + '  ')
        } else {
          lines.push(`${indent}${entry.name}`)
        }
      }
    }
    await walk(root, 1, '')
    if (lines.length === 0) return { text: `${root} is empty.`, meta: { matches: 0 } }
    return {
      text: `${root}\n${lines.join('\n')}${truncated ? '\n[Listing truncated at 500 entries.]' : ''}`,
      meta: { matches: lines.length }
    }
  }
}

export const editTool: ToolDef = {
  name: 'Edit',
  kind: 'edit',
  description:
    `Apply a V4A (apply_patch) patch using @galaxysj/v4a. Pass only patch. Read existing files first and include enough context to identify each hunk. Paths must be inside the working directory; relative paths are preferred. One patch can update, add, delete or move multiple files. This is not a unified git diff: use bare @@ or @@ followed by a context anchor, not numeric line ranges.

Example:
*** Begin Patch
*** Update File: src/example.ts
@@
-const value = 1
+const value = 2
*** Add File: src/new.ts
+export const ready = true
+
*** End Patch

Update File hunks use a space for unchanged context, - for removed lines and + for added lines. Add File content lines all start with +; include a final + line for a trailing newline. Delete File needs only its header. To rename, put *** Move to: destination directly after *** Update File: source and include the update hunks. Use *** End of File when a hunk must match the file's end.`,
  parameters: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'Complete V4A patch, starting with *** Begin Patch and ending with *** End Patch.' }
    },
    required: ['patch'],
    additionalProperties: false
  },
  present(input, ctx) {
    const paths = patchFiles(parseEditPatch(str(input, 'patch', true), ctx.cwd), ctx.cwd)
    return { title: `Edit ${paths.length === 1 ? basename(paths[0]) : plural(paths.length, 'file')}`, detail: paths.map((path) => displayPath(ctx.cwd, path)).join(', ') }
  },
  approval(input, ctx) {
    const patch = str(input, 'patch', true)
    const operations = parseEditPatch(patch, ctx.cwd).operations
    return {
      action: {
        tool: 'Edit',
        engine: '@galaxysj/v4a',
        inside_workspace: true,
        files: operations.map((operation) => ({ type: operation.type, path: resolvePath(ctx.cwd, operation.path), ...(operation.type === 'update' && operation.moveTo ? { moveTo: resolvePath(ctx.cwd, operation.moveTo) } : {}) })),
        patch
      },
      sessionKey: 'edit',
      sessionLabel: 'Allow all edits in this chat'
    }
  },
  async execute(input, ctx) {
    const patch = str(input, 'patch', true)
    const proposed = await previewEditPatch(patch, ctx.cwd)
    const item = ctx.session.item<ToolItem>(ctx.itemId)
    ctx.session.update<ToolItem>(ctx.itemId, { meta: { ...item?.meta, diffs: proposed } })
    const diffs = await applyEditPatch(patch, ctx.cwd, ctx.signal)
    return {
      text: `Applied patch to ${plural(diffs.length, 'file')}.${diffs.length ? '\n' + diffs.map((diff) => `${diff.created ? 'A' : diff.deleted ? 'D' : 'M'} ${diff.path}`).join('\n') : ''}`,
      meta: { diffs }
    }
  }
}

export const createTool: ToolDef = {
  name: 'Create',
  kind: 'create',
  description:
    'Write a file with the given content, creating parent directories as needed. Overwrites the file if it exists, so prefer Edit for changes to existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to write.' },
      content: { type: 'string', description: 'Full content of the file.' }
    },
    required: ['path', 'content']
  },
  present(input, ctx) {
    const abs = resolvePath(ctx.cwd, String(input.path ?? ''))
    return { title: `Create ${basename(abs)}`, detail: displayPath(ctx.cwd, abs) }
  },
  approval(input, ctx) {
    const abs = resolvePath(ctx.cwd, String(input.path ?? ''))
    const content = String(input.content ?? '')
    return {
      action: {
        tool: 'Create',
        file: abs,
        inside_workspace: abs.startsWith(ctx.cwd + '/'),
        bytes: content.length,
        content_preview: content.slice(0, 1500)
      },
      sessionKey: 'edit',
      sessionLabel: 'Allow all edits in this chat'
    }
  },
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, str(input, 'path', true))
    if (typeof input.content !== 'string') throw new ToolInputError('Missing required parameter: content')
    const info = await stat(abs).catch(() => null)
    if (info?.isDirectory()) throw new Error(`${abs} is a directory`)
    const before = info ? await readFile(abs, 'utf8').catch(() => '') : null
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf8')
    const diff = makeDiff(abs, before, input.content)
    const lines = input.content === '' ? 0 : input.content.split('\n').length
    return {
      text: `${before === null ? 'Created' : 'Overwrote'} ${abs} (${plural(lines, 'line')}).`,
      meta: { diffs: [diff] }
    }
  }
}
