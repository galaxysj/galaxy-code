import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ImageModel } from '@shared/models'
import type { AskQuestion, PresentedFile, TaskEntry } from '@shared/types'
import { browser, type BrowserAction } from '../services/browser'
import { memoryPath, updateMemory, type MemoryAction } from '../services/memory'
import { generateImage } from '../services/openrouter'
import { webFetch, webSearch } from '../services/web'
import { store } from '../store'
import { displayPath, errorMessage, exists, isAbortError, isImagePath, mimeOf, newId, oneLine, resolvePath, slugify, truncateEnd } from '../util'
import { makeDiff } from './diff'
import { num, plural, str, ToolInputError, type ToolDef, type ToolImage } from './types'

export const webSearchTool: ToolDef = {
  name: 'WebSearch',
  kind: 'websearch',
  parallel: true,
  description:
    'Search the web. Returns titles, URLs and snippets. Use it for anything that may have changed recently or that you are unsure about, then WebFetch the most relevant result for detail.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The search query.' } },
    required: ['query']
  },
  present(input) {
    const query = String(input.query ?? '')
    return { title: `Searched ${JSON.stringify(query)}`, meta: { query } }
  },
  async execute(input, ctx) {
    const query = str(input, 'query', true)
    const response = await webSearch(query, ctx.signal)
    if (response.results.length === 0 && !response.answer) return { text: 'No results found.', meta: { query, results: [] } }
    const list = response.results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${oneLine(r.snippet, 300)}` : ''}`)
      .join('\n')
    return {
      text: [response.answer, list && `Sources:\n${list}`].filter(Boolean).join('\n\n'),
      meta: { query, results: response.results }
    }
  }
}

export const webFetchTool: ToolDef = {
  name: 'WebFetch',
  kind: 'webfetch',
  parallel: true,
  description:
    'Fetch a URL and return its content as markdown. Long pages are returned in chunks; pass `offset` to continue reading from where the previous chunk ended.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch.' },
      offset: { type: 'integer', description: 'Character position to continue from.' }
    },
    required: ['url']
  },
  present(input) {
    const url = String(input.url ?? '')
    let label = url
    try {
      const parsed = new URL(/^https?:/i.test(url) ? url : `https://${url}`)
      label = parsed.hostname.replace(/^www\./, '') + (parsed.pathname.length > 1 ? parsed.pathname : '')
    } catch {
      // keep the raw value
    }
    return { title: `Fetched ${oneLine(label, 70)}`, meta: { url } }
  },
  async execute(input, ctx) {
    const page = await webFetch(str(input, 'url', true), ctx.signal)
    const offset = Math.max(0, Math.floor(num(input, 'offset') ?? 0))
    const CHUNK = 40_000
    const chunk = page.text.slice(offset, offset + CHUNK)
    const rest = page.text.length - offset - chunk.length
    const header = `${page.title ? `# ${page.title}\n` : ''}Source: ${page.url}\n\n`
    const footer = rest > 0 ? `\n\n[${rest.toLocaleString()} more characters. Continue with offset=${offset + chunk.length}.]` : ''
    return { text: (offset === 0 ? header : '') + chunk + footer, meta: { url: page.url } }
  }
}

const READ_ONLY_BROWSER = new Set(['snapshot', 'screenshot', 'console', 'wait', 'scroll', 'tabs'])

const hasPoint = (step: Record<string, unknown>): boolean => step.x !== undefined || step.y !== undefined

function browserSteps(input: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(input.steps) ? input.steps.map((step) => (step ?? {}) as Record<string, unknown>) : []
}

/** What one Browser step did, in the words of the timeline. */
function browserStepTitle(step: Record<string, unknown>): string {
  const action = String(step.action ?? '')
  const target = hasPoint(step) ? `(${String(step.x)}, ${String(step.y)})` : step.ref !== undefined ? `element ${String(step.ref)}` : step.selector ? String(step.selector) : ''
  switch (action) {
    case 'create':
      return `Opened ${oneLine(String(step.url || 'new browser tab'), 70)}`
    case 'navigate':
      return `Opened ${oneLine(String(step.url ?? ''), 70)}`
    case 'navigate_file':
      return `Opened ${basename(String(step.path ?? ''))}`
    case 'snapshot':
      return 'Read the page'
    case 'click':
      return `Clicked ${target}`
    case 'drag':
      return `Dragged ${target} to (${String(step.toX)}, ${String(step.toY)})`
    case 'type':
      return `Typed ${JSON.stringify(oneLine(String(step.text ?? ''), 40))}${target ? ` into ${target}` : ''}`
    case 'press':
      return `Pressed ${String(step.key ?? '')}`
    case 'scroll':
      return `Scrolled ${String(step.direction ?? 'down')}${hasPoint(step) ? ` at ${target}` : ''}`
    case 'screenshot':
      return 'Took a screenshot'
    case 'evaluate':
      return 'Ran a script in the page'
    case 'back':
      return 'Went back'
    case 'forward':
      return 'Went forward'
    case 'reload':
      return 'Reloaded the page'
    case 'wait':
      return step.selector ? `Waited for ${String(step.selector)}` : `Waited ${String(step.seconds ?? 1)}s`
    case 'console':
      return 'Read the console'
    case 'tabs':
      return 'Listed tabs'
    case 'close':
      return 'Closed browser tab'
    default:
      return `Browser ${action}`
  }
}

export const listTabsTool: ToolDef = {
  name: 'ListTabs',
  kind: 'browser',
  parallel: true,
  description: "List open browser tabs in the current chat's window, including background tabs, with their title, URL and 1-based tabIndex in sidebar order. Each window has its own tab indices. Renamed tab titles are preserved. File preview pages are excluded. Does not open a page, select a tab or change focus. Pass a returned tabIndex to Browser to control that tab.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  present() { return { title: 'Listed tabs' } },
  async execute(_input, ctx) {
    const tabs = browser.listTabsForChat(ctx.session.team?.chatId ?? ctx.session.id).map(({ title, url, tabIndex }) => ({ tabIndex, title, url }))
    return {
      text: tabs.length ? JSON.stringify(tabs, null, 2) : 'No open browser tabs. You can create one now: call Browser with {"title":"Open example.com","steps":[{"action":"create","url":"https://example.com","background":false}]}, using the requested URL. Do not wait for the user to open a tab.',
      display: tabs.length ? tabs.map((tab) => `${tab.tabIndex}. ${oneLine(tab.title, 160)}\n   ${tab.url || 'about:blank'}`).join('\n\n') : 'No open browser tabs.'
    }
  }
}

export const browserTool: ToolDef = {
  name: 'Browser',
  kind: 'browser',
  description: `Control in-app Chromium tabs in the current chat's window. tabIndex is scoped to that window; use ListTabs to find its tabs. By default tabs open and actions run in the background without opening the sidebar or changing the user's selected tab or keyboard focus. For navigate, set background:false to open the sidebar and select the target tab so the user can watch. Choose based on the user's intent: show pages they ask to open or see; keep research and implementation checks in the background. Use it to check pages you built, reproduce UI bugs, or work through sites that need interaction.

Each call has a short \`title\` and a list of \`steps\`. Steps run in order and the call stops at the first error; the result reports each step's output, and every screenshot comes back. Batch the steps you can already predict into one call, such as navigate then snapshot, or type then press then screenshot. Do not guess what you cannot know yet: refs come from a snapshot and change with the page, so click a ref in a later call, or use a CSS selector you are sure of. Coordinates come from a screenshot, so they belong in a later call too.

Instead of a ref or selector, click, type and scroll accept \`x\` and \`y\`, and drag requires them. Use them for canvases, maps, sliders and anything else a snapshot does not list. They are pixels of the tab's latest screenshot image, with the origin at its top-left, and the screenshot result states the image's size. Galaxy Code converts them for the page's device pixel ratio and any downscaling, so never adjust them yourself. Take a new screenshot after the page or its layout changes.

Actions, each a step with its own fields:
- create: open a new tab, even when ListTabs is empty. Pass the requested url, or omit it for a blank tab. Never pass tabIndex. Reveals the tab by default; use background:true for background research. An empty tab list is not a blocker: create the tab yourself.
- navigate: load \`url\` in \`tabIndex\`. As the first step, omit tabIndex to open a new tab. \`background\` defaults to true; set false to reveal and select the tab in the sidebar, or true to keep the user's current selection. This also works when navigating an existing tab. Returns its tabIndex and page outline.
- navigate_file: load the local file at \`path\` (absolute, or relative to the working directory) the same way navigate loads a url. Use it to view HTML, PDFs and images.
- snapshot: list interactive elements with numeric refs, plus the page text. Take one before clicking or typing by ref, and again after the page changes.
- click: left-click the element with \`ref\` (from the latest snapshot) or a CSS \`selector\`, or the point \`x\`, \`y\`.
- drag: press at \`x\`, \`y\`, move to \`toX\`, \`toY\`, and release.
- type: type \`text\` into the element with \`ref\` or \`selector\`, or click \`x\`, \`y\` first to focus it. \`clear\` empties the field first, \`submit\` presses Enter after.
- press: press \`key\`, e.g. "Enter", "Escape", "Tab", "Meta+A".
- scroll: scroll in \`direction\` (up, down, left, right) by \`amount\` steps. With \`x\` and \`y\`, wheel whatever is under that point, such as a scrollable panel.
- screenshot: capture the target tab's viewport without selecting or revealing it. Use it to judge layout and visual results, and to find coordinates.
- evaluate: run JavaScript \`script\` in the page and return its value.
- back, forward, reload: history navigation.
- wait: pause for \`seconds\`, or until \`selector\` appears.
- console: recent console messages from the page.
- tabs: list browser tabs with title, URL and 1-based tabIndex in sidebar order. ListTabs provides the same list. File preview pages are excluded.
- close: close the tab at tabIndex.
Use tabIndex as the only browser tab selector. A step without tabIndex stays on the previous step's tab, so only the first step of a call that continues an existing tab needs it, and later steps need it only to switch tabs. Use create to open a second tab in one call. After close, the next step must name its tabIndex. Indices can change when tabs move or close; use ListTabs to refresh them. Controls work even if the user has another tab selected.
Examples: {"title":"Open example.com and read the page","steps":[{"action":"navigate","url":"https://example.com"},{"action":"snapshot"}]} reads a page in a new background tab. {"title":"Show the local app","steps":[{"action":"navigate","url":"http://localhost:5000","background":false},{"action":"screenshot"}]} opens and shows the page to the user. {"title":"Submit the search","steps":[{"action":"type","tabIndex":1,"selector":"input[name=q]","text":"hello","submit":true},{"action":"screenshot"}]} works in tab 1. {"title":"Open the third link","steps":[{"action":"click","tabIndex":1,"ref":3}]} is a single step. {"title":"Drag the slider to the right","steps":[{"action":"drag","tabIndex":1,"x":120,"y":340,"toX":480,"toY":340}]} uses coordinates from a screenshot.`,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short action title displayed in the tool log, starting with a verb, for example "Open example.com and read the page".', maxLength: 120 },
      steps: {
        type: 'array',
        minItems: 1,
        description: 'Browser actions to run in order. One step is fine; batch the ones you can predict.',
        items: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['create', 'navigate', 'navigate_file', 'snapshot', 'click', 'drag', 'type', 'press', 'scroll', 'screenshot', 'evaluate', 'back', 'forward', 'reload', 'wait', 'console', 'tabs', 'close']
            },
            url: { type: 'string' },
            path: { type: 'string', description: 'navigate_file only: the local file to open.' },
            background: { type: 'boolean', description: 'create defaults to false (show the new tab); navigate defaults to true (background). false reveals the sidebar and selects the tab. Use false when the user asks to open or show a page; true for background research and checks.' },
            tabIndex: { type: 'integer', minimum: 1, description: 'The only browser tab selector: 1-based index from ListTabs, create, or navigate. Omit to stay on the previous step\'s tab. The first step needs it to act on an existing tab, and omits it for tabs, create, or navigate to a new tab.' },
            ref: { type: 'integer', description: 'Element ref from the latest snapshot.' },
            selector: { type: 'string', description: 'CSS selector, as an alternative to ref.' },
            x: { type: 'number', description: 'Horizontal pixel in the latest screenshot image, as an alternative to ref or selector.' },
            y: { type: 'number', description: 'Vertical pixel in the latest screenshot image, as an alternative to ref or selector.' },
            toX: { type: 'number', description: 'drag only: horizontal pixel where the drag ends.' },
            toY: { type: 'number', description: 'drag only: vertical pixel where the drag ends.' },
            text: { type: 'string' },
            clear: { type: 'boolean' },
            submit: { type: 'boolean' },
            key: { type: 'string' },
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
            amount: { type: 'integer' },
            script: { type: 'string' },
            seconds: { type: 'number' }
          },
          required: ['action']
        }
      }
    },
    required: ['title', 'steps']
  },
  present(input) {
    const steps = browserSteps(input)
    const labels = steps.map(browserStepTitle)
    const title = typeof input.title === 'string' ? oneLine(input.title.trim(), 120) : ''
    const opened = steps.find((step) => (step.action === 'navigate' || step.action === 'create') && step.url)
    return { title: title || labels[0] || 'Browser', detail: labels.join(' · ') || undefined, meta: opened ? { url: String(opened.url) } : undefined }
  },
  approval(input) {
    const steps = browserSteps(input)
    // A scroll at a point is real input to the page, unlike scrolling the window.
    if (steps.every((step) => READ_ONLY_BROWSER.has(String(step.action)) && !hasPoint(step))) return null
    // Only the steps are judged; the title is the model's own description of them.
    return {
      action: { tool: 'Browser', steps },
      sessionKey: 'browser',
      sessionLabel: 'Allow browser control in this chat'
    }
  },
  async execute(input, ctx) {
    const steps = browserSteps(input)
    if (steps.length === 0) throw new ToolInputError('`steps` must be a non-empty array')
    const outputs: string[] = []
    const images: ToolImage[] = []
    const files: string[] = []
    const urls: string[] = []
    const finished = () => ({ text: outputs.join('\n\n'), images: images.length ? images : undefined, meta: { urls, ...(files.length ? { images: files } : {}) } })
    let tabIndex: number | undefined
    for (const [index, step] of steps.entries()) {
      const label = `Step ${index + 1} of ${steps.length}: ${String(step.action ?? '')}`
      try {
        ctx.signal.throwIfAborted()
        if (step.action === 'navigate_file' && !step.path) throw new ToolInputError('`path` is required for navigate_file')
        const target = step.action === 'navigate_file' ? { ...step, action: 'navigate', url: pathToFileURL(resolvePath(ctx.cwd, String(step.path))).href } : step
        const action = { ...target, tabIndex: num(step, 'tabIndex') ?? tabIndex } as unknown as BrowserAction
        const result = await browser.act(ctx.session.team?.chatId ?? ctx.session.id, action, ctx.signal)
        if (action.action === 'close' && result.tabId) ctx.session.emitUi({ type: 'close-panel-tab', tabId: result.tabId })
        // A closed tab leaves nothing to continue on; listing tabs does not move off the current one.
        tabIndex = action.action === 'close' ? undefined : result.tabIndex ?? tabIndex
        if (result.url) urls.push(result.url)
        outputs.push(steps.length > 1 ? `${label}\n${result.text}` : result.text)
        if (result.image) {
          // Keep a copy on disk so the screenshot survives in the timeline.
          const dir = join(tmpdir(), 'galaxy-code', 'screenshots')
          await mkdir(dir, { recursive: true })
          const file = join(dir, `${newId()}.jpg`)
          await writeFile(file, Buffer.from(result.image.base64, 'base64'))
          images.push(result.image)
          files.push(file)
        }
      } catch (err) {
        if (steps.length === 1 || isAbortError(err) || ctx.signal.aborted) throw err
        const skipped = steps.length - index - 1
        outputs.push(`${label} failed${skipped ? `, ${plural(skipped, 'later step')} not run` : ''}: ${errorMessage(err)}`)
        return { ...finished(), isError: true }
      }
    }
    return finished()
  }
}

function parseQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions
  if (!Array.isArray(raw) || raw.length === 0) throw new ToolInputError('`questions` must be a non-empty array')
  return raw.slice(0, 4).map((entry, index) => {
    const q = (entry ?? {}) as Record<string, unknown>
    const question = typeof q.question === 'string' ? q.question.trim() : ''
    if (!question) throw new ToolInputError(`questions[${index}].question is required`)
    const options = Array.isArray(q.options)
      ? q.options
          .map((o) => {
            if (typeof o === 'string') return { label: o }
            const option = (o ?? {}) as Record<string, unknown>
            return { label: String(option.label ?? '').trim(), description: option.description ? String(option.description) : undefined }
          })
          .filter((o) => o.label)
          .slice(0, 6)
      : []
    return {
      header: typeof q.header === 'string' ? q.header.slice(0, 24) : undefined,
      question,
      options,
      multiSelect: q.multiSelect === true || q.multi_select === true
    }
  })
}

export const askTool: ToolDef = {
  name: 'Ask',
  kind: 'ask',
  description:
    'Ask the user one to four questions and wait for the answers. Use it only when a decision is genuinely theirs to make and you cannot resolve it from the request, the code, or a sensible default. Offer two to four concrete options per question, put the one you recommend first. The user can always type their own answer.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: 'Very short label, at most 12 characters.' },
            question: { type: 'string', description: 'The full question.' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Short choice text.' },
                  description: { type: 'string', description: 'What choosing this means.' }
                },
                required: ['label']
              }
            },
            multiSelect: { type: 'boolean', description: 'Allow more than one option to be chosen.' }
          },
          required: ['question', 'options']
        }
      }
    },
    required: ['questions']
  },
  present(input) {
    const first = Array.isArray(input.questions) ? (input.questions[0] as { question?: string } | undefined) : undefined
    return { title: oneLine(first?.question ?? 'Question', 90) }
  },
  async execute(input, ctx) {
    const questions = parseQuestions(input)
    const answers = await ctx.session.ask(ctx.itemId, questions)
    if (!answers) {
      return { text: 'The user dismissed the question without answering. Proceed with your best judgment or stop and wait for direction.', meta: { questions }, isError: true }
    }
    const text = questions.map((q) => `Q: ${q.question}\nA: ${answers[q.question] ?? '(no answer)'}`).join('\n\n')
    return { text, meta: { questions, answers } }
  }
}

function parseTasks(input: Record<string, unknown>): TaskEntry[] {
  const raw = input.tasks
  if (!Array.isArray(raw)) throw new ToolInputError('`tasks` must be an array')
  return raw.map((entry) => {
    const task = (entry ?? {}) as Record<string, unknown>
    const status = task.status === 'completed' || task.status === 'in_progress' ? task.status : 'pending'
    return { content: String(task.content ?? task.title ?? '').trim(), status } as TaskEntry
  }).filter((t) => t.content)
}

export const taskTool: ToolDef = {
  name: 'Task',
  kind: 'task',
  description:
    'Create or update the task list for the current work. Each call replaces the whole list, so always send every task with its current status. Use it for work with more complex steps: write the list before starting, keep exactly one task in_progress, and mark each task completed as soon as it is done. Skip it for simple requests.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What needs doing, in the imperative.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
          },
          required: ['content', 'status']
        }
      }
    },
    required: ['tasks']
  },
  present(input) {
    const tasks = Array.isArray(input.tasks) ? (input.tasks as { status?: string }[]) : []
    const done = tasks.filter((t) => t.status === 'completed').length
    return { title: done === 0 ? `Planned ${plural(tasks.length, 'task')}` : `Updated tasks (${done}/${tasks.length} done)` }
  },
  async execute(input) {
    const tasks = parseTasks(input)
    const done = tasks.filter((t) => t.status === 'completed').length
    return { text: `Task list updated: ${done} of ${tasks.length} completed.`, meta: { tasks } }
  }
}

export const presentTool: ToolDef = {
  name: 'Present',
  kind: 'present',
  description:
    'Hand finished deliverables to the user. Call it once at the end of work that produces files the user asked for, such as a report, a document, a generated image, a built page. The files appear as cards the user can open. Do not use it for source files changed along the way.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short name for what is being delivered.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Paths of the finished files.' },
      summary: { type: 'string', description: 'One or two sentences on what was made.' }
    },
    required: ['files']
  },
  present(input) {
    const files = Array.isArray(input.files) ? input.files : []
    return { title: input.title ? String(input.title) : `Presented ${plural(files.length, 'file')}` }
  },
  async execute(input, ctx) {
    const paths = Array.isArray(input.files) ? input.files.map(String) : []
    if (paths.length === 0) throw new ToolInputError('`files` must list at least one path')
    const files: PresentedFile[] = []
    const missing: string[] = []
    for (const p of paths) {
      const abs = resolvePath(ctx.cwd, p)
      const info = await stat(abs).catch(() => null)
      if (!info || !info.isFile()) missing.push(p)
      else files.push({ path: abs, name: basename(abs), mime: mimeOf(abs), size: info.size })
    }
    if (files.length === 0) throw new Error(`None of the files exist: ${missing.join(', ')}`)
    return {
      text: `Presented ${plural(files.length, 'file')} to the user.${missing.length ? ` Not found: ${missing.join(', ')}` : ''}`,
      meta: { files, summary: input.summary ? String(input.summary) : undefined }
    }
  }
}

export const openTool: ToolDef = {
  name: 'Open',
  kind: 'open',
  description:
    'Open a tab beside the chat. type=file (default) opens path at line. type=review opens workspace changes. It never runs commands; use Bash for anything the user asks to run in a terminal. Existing tabs stay open. It does not return file content; use Read for that.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['file', 'review'] },
      path: { type: 'string', description: 'File to open.' },
      line: { type: 'integer', description: 'Line to scroll to.' }
    },
    required: []
  },
  present(input, ctx) {
    if (input.type === 'review') return { title: 'Opened review' }
    const abs = resolvePath(ctx.cwd, String(input.path ?? ''))
    return { title: `Opened ${basename(abs)}`, detail: displayPath(ctx.cwd, abs) }
  },
  async execute(input, ctx) {
    if (input.type === 'terminal') throw new ToolInputError('Open cannot open terminals. Run the command with Bash instead.')
    if (input.type === 'review') {
      const tabId = `review:${ctx.session.team?.chatId ?? ctx.session.id}`
      ctx.session.emitUi({ type: 'open-panel', chatId: ctx.session.id, pane: 'review', cwd: ctx.cwd, tabId })
      return { text: `Opened review tab ${tabId}.` }
    }
    const abs = resolvePath(ctx.cwd, str(input, 'path', true))
    if (!(await exists(abs))) throw new Error(`File not found: ${abs}`)
    const line = num(input, 'line')
    ctx.session.emitUi({ type: 'open-file', chatId: ctx.session.id, path: abs, line: line ? Math.floor(line) : undefined })
    return { text: `Opened ${abs} beside the chat.`, meta: { files: [{ path: abs, name: basename(abs), mime: mimeOf(abs), size: 0 }] } }
  }
}

export const memoryTool: ToolDef = {
  name: 'Memory',
  kind: 'memory',
  description:
    'Update the persistent memory file (~/.galaxy/MEMORY.md), which is loaded into every future chat, across all projects. Save actively, without being asked, whenever something could help a later chat: how the user wants you to work, corrections they gave, preferences, project conventions and decisions that are not obvious from the code. Do not save what the code or git history already records, or details that only matter to this chat. The file is a list of topics, each a `# Topic` heading followed by Markdown. Actions: "add" appends `content` under `topic`, creating the topic if needed, "replace" swaps `old_text` for `content`, "remove" deletes `old_text`, "rewrite" replaces the whole file with `content`.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'replace', 'remove', 'rewrite'] },
      topic: { type: 'string', description: 'add only: the topic heading to file this under, without the #. Reuse an existing topic when one fits.' },
      content: { type: 'string', description: 'The memory to store as Markdown, written so it makes sense on its own later.' },
      old_text: { type: 'string', description: 'Existing text to replace or remove.' }
    },
    required: ['action']
  },
  present(input) {
    const action = String(input.action ?? 'add')
    return { title: action === 'remove' ? 'Removed memory' : 'Saved memory', detail: oneLine(String(input.content ?? input.old_text ?? ''), 160) }
  },
  async execute(input, ctx) {
    const action = str(input, 'action', true)
    let change: MemoryAction
    if (action === 'add') change = { action, content: str(input, 'content', true), topic: typeof input.topic === 'string' ? input.topic : undefined }
    else if (action === 'replace') change = { action, old_text: str(input, 'old_text', true), content: str(input, 'content', true) }
    else if (action === 'remove') change = { action, old_text: str(input, 'old_text', true) }
    else if (action === 'rewrite') change = { action, content: str(input, 'content', true) }
    else throw new ToolInputError(`Unknown action: ${action}`)

    const result = await updateMemory(ctx.session.projectPath, change)
    return {
      text: `Memory updated at ${result.path}.`,
      meta: { diffs: [makeDiff(memoryPath(ctx.session.projectPath), result.before || null, result.after)] }
    }
  }
}

/** The image model chosen in Settings, or the first built-in one. */
function activeImageModel(): { id: string; name: string } {
  const key = store.settings.imageModelKey
  const chosen = ImageModel.find((m) => `${m.Subscription}:${m.ID}` === key) ?? ImageModel[0]
  if (!chosen) throw new Error('No image model is configured')
  return { id: chosen.ID, name: chosen.DisplayName }
}

export const imageGenerationTool: ToolDef = {
  name: 'ImageGeneration',
  kind: 'image',
  description:
    'Generate an image from a text prompt, or edit existing images by passing them as `reference_images`. The result is saved to disk and shown to the user and to you. Describe subject, composition, style, lighting and any exact text to render. Give `path` to choose where it is saved, otherwise it goes to a generated-images folder in the working directory.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to generate, in detail.' },
      path: { type: 'string', description: 'Where to save the image.' },
      aspect_ratio: { type: 'string', description: 'For example "1:1", "16:9", "9:16", "4:3".' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths of images to edit or use as reference.' }
    },
    required: ['prompt']
  },
  present(input) {
    return { title: 'Generated an image', detail: oneLine(String(input.prompt ?? ''), 200) }
  },
  approval(input) {
    return {
      action: { tool: 'ImageGeneration', prompt: String(input.prompt ?? '').slice(0, 1000), note: 'Calls a paid image model and writes one image file.' },
      sessionKey: 'image',
      sessionLabel: 'Allow image generation in this chat'
    }
  },
  async execute(input, ctx) {
    const prompt = str(input, 'prompt', true)
    const model = activeImageModel()

    const references: string[] = []
    if (Array.isArray(input.reference_images)) {
      for (const ref of input.reference_images.slice(0, 6)) {
        const abs = resolvePath(ctx.cwd, String(ref))
        if (!isImagePath(abs)) throw new ToolInputError(`${ref} is not an image file`)
        const data = await readFile(abs).catch(() => null)
        if (!data) throw new Error(`Reference image not found: ${abs}`)
        references.push(`data:${mimeOf(abs)};base64,${data.toString('base64')}`)
      }
    }

    const images = await generateImage(model.id, prompt, { aspectRatio: str(input, 'aspect_ratio'), references, signal: ctx.signal })
    const saved: string[] = []
    for (let i = 0; i < images.length; i++) {
      const image = images[i]
      const ext = image.mime.includes('jpeg') ? '.jpg' : image.mime.includes('webp') ? '.webp' : '.png'
      let target: string
      const requested = str(input, 'path')
      if (requested) {
        const abs = resolvePath(ctx.cwd, requested)
        const base = extname(abs) ? abs.slice(0, -extname(abs).length) : abs
        target = `${base}${i > 0 ? `-${i + 1}` : ''}${extname(abs) || ext}`
      } else {
        target = join(ctx.cwd, 'generated-images', `${slugify(prompt, 40)}-${newId().slice(0, 4).toLowerCase()}${i > 0 ? `-${i + 1}` : ''}${ext}`)
      }
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, image.data)
      saved.push(target)
    }
    return {
      text: `Generated with ${model.name} and saved to:\n${saved.join('\n')}`,
      images: images.slice(0, 2).map((image) => ({ mime: image.mime, base64: image.data.toString('base64') })),
      meta: { images: saved, summary: truncateEnd(prompt, 400) }
    }
  }
}
