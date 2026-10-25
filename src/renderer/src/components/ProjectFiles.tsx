import { ChevronRight, Code, Copy, ExternalLink, FileImage, FilePlus, FileText, Folder, FolderOpen, FolderPlus, PanelRight, Pencil, Search, RotateCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ProjectFileEntry } from '@shared/types'
import { basename, cn } from '../lib/utils'
import type { OpenFile, PanelTab } from '../store'
import { useStore } from '../store'
import { cleanError } from './Settings'
import { IconButton, MenuItem, MenuSeparator, Popover, Spinner } from './ui'

/** Two-letter badges for common source files, keyed by extension. */
const BADGES: Record<string, [string, string]> = {
  ts: ['TS', 'bg-blue-500/12 text-blue-500'],
  tsx: ['TS', 'bg-blue-500/12 text-blue-500'],
  mts: ['TS', 'bg-blue-500/12 text-blue-500'],
  js: ['JS', 'bg-yellow-500/15 text-yellow-600'],
  jsx: ['JS', 'bg-yellow-500/15 text-yellow-600'],
  mjs: ['JS', 'bg-yellow-500/15 text-yellow-600'],
  py: ['PY', 'bg-sky-500/12 text-sky-600'],
  rs: ['RS', 'bg-orange-500/12 text-orange-600'],
  go: ['GO', 'bg-cyan-500/12 text-cyan-600'],
  swift: ['SW', 'bg-orange-500/12 text-orange-500'],
  java: ['JV', 'bg-red-500/12 text-red-500'],
  kt: ['KT', 'bg-violet-500/12 text-violet-500'],
  rb: ['RB', 'bg-red-500/12 text-red-500'],
  css: ['CS', 'bg-indigo-500/12 text-indigo-500'],
  scss: ['SC', 'bg-pink-500/12 text-pink-500'],
  html: ['<>', 'bg-orange-500/12 text-orange-500'],
  md: ['MD', 'bg-zinc-500/12 text-muted'],
  sh: ['SH', 'bg-green-500/12 text-green-600']
}

export function FileIcon({ name, size = 14 }: { name: string; size?: number }): ReactNode {
  const ext = name.match(/\.([^.]+)$/)?.[1].toLowerCase() ?? ''
  const badge = BADGES[ext]
  if (badge) {
    return (
      <span className={cn('inline-flex shrink-0 items-center justify-center rounded-[3px] font-semibold leading-none', badge[1])} style={{ width: size + 2, height: size + 2, fontSize: Math.round(size * 0.55) }}>
        {badge[0]}
      </span>
    )
  }
  if (/^(json|jsonc|yaml|yml|toml)$/.test(ext)) return <Code size={size} className="shrink-0 text-orange-500" />
  if (/^(png|jpe?g|gif|svg|webp|ico)$/.test(ext)) return <FileImage size={size} className="shrink-0 text-pink-500" />
  return <FileText size={size} className="shrink-0 text-subtle" />
}

/** The folder holding a project-relative path, '' for the project root. */
const parentOf = (relativePath: string): string => relativePath.slice(0, Math.max(0, Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'))))

const REVEAL_LABEL = /Mac/i.test(navigator.platform) ? 'Reveal in Finder' : 'Show in Folder'

/** Inline name field for a new or renamed entry. Enter or leaving the field saves; Escape cancels. */
function NameInput({ initial, depth, directory, onSubmit, onCancel }: { initial: string; depth: number; directory: boolean; onSubmit(name: string): void; onCancel(): void }): ReactNode {
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const field = input.current
    if (!field) return
    field.focus()
    // Select the name without its extension, as Finder does.
    const dot = directory ? -1 : initial.lastIndexOf('.')
    field.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial, directory])
  const finish = (save: boolean): void => {
    if (done.current) return
    done.current = true
    const name = input.current?.value.trim() ?? ''
    if (save && name && name !== initial) onSubmit(name)
    else onCancel()
  }
  return <div className="flex h-7 w-full min-w-0 items-center gap-1.5 pr-2" style={{ paddingLeft: 8 + depth * 14 }}>
    <span className="w-3 shrink-0" />
    {directory ? <Folder size={14} className="shrink-0 text-subtle" /> : <FileIcon name={initial || 'file'} />}
    <input
      ref={input}
      aria-label={directory ? 'Folder name' : 'File name'}
      defaultValue={initial}
      spellCheck={false}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); finish(true) }
        else if (event.key === 'Escape') { event.preventDefault(); finish(false) }
      }}
      onBlur={() => finish(true)}
      className="h-6 min-w-0 flex-1 rounded border border-fg/40 bg-inset px-1.5 text-[12px] text-fg outline-none"
    />
  </div>
}

export function ProjectFilesPane({ tab, available, renderFile }: { tab: Extract<PanelTab, { type: 'files' }>; available: boolean; renderFile(file: OpenFile): ReactNode }): ReactNode {
  const [folders, setFolders] = useState<Record<string, ProjectFileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [results, setResults] = useState<ProjectFileEntry[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<OpenFile | null>(null)
  const [treeOpen, setTreeOpen] = useState(true)
  const treeId = useId()
  const [revision, setRevision] = useState(0)
  const [creating, setCreating] = useState<{ parent: string; directory: boolean } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ entry: ProjectFileEntry | null; x: number; y: number } | null>(null)
  const menuAnchor = useRef<HTMLDivElement>(null)
  const notify = useStore((s) => s.notify)
  const load = useCallback(async (relativePath: string) => {
    setLoading((previous) => new Set(previous).add(relativePath))
    try {
      const entries = await window.galaxy.files.listProject(tab.projectId, relativePath, tab.chatId ?? undefined)
      setFolders((previous) => ({ ...previous, [relativePath]: entries }))
      setError('')
    } catch (error) { setError(String(error)) }
    finally { setLoading((previous) => { const next = new Set(previous); next.delete(relativePath); return next }) }
  }, [tab.projectId, tab.chatId])
  useEffect(() => {
    if (!available) return
    setFolders({})
    setSelected((file) => file ? { ...file, nonce: file.nonce + 1 } : file)
    void load('')
    for (const folder of expanded) void load(folder)
  }, [load, revision, tab.nonce, available])
  useEffect(() => {
    if (!filter.trim() || !available) { setResults([]); setSearching(false); return }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      void window.galaxy.files.searchProject(tab.projectId, filter.trim(), tab.chatId ?? undefined).then((entries) => { if (!cancelled) setResults(entries) }).catch((error) => { if (!cancelled) setError(String(error)) }).finally(() => { if (!cancelled) setSearching(false) })
    }, 180)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [filter, tab.projectId, tab.chatId, available, revision])
  const choose = (entry: ProjectFileEntry): void => {
    if (!entry.directory) { setSelected((current) => ({ path: entry.path, nonce: current?.path === entry.path ? current.nonce + 1 : 0 })); return }
    setExpanded((previous) => { const next = new Set(previous); if (next.has(entry.relativePath)) next.delete(entry.relativePath); else next.add(entry.relativePath); return next })
    if (!folders[entry.relativePath]) void load(entry.relativePath)
  }
  /** Where the + button creates: the selected file's folder, or the project root. */
  const selectedFolder = (): string => {
    if (!selected) return ''
    // Entry paths come from the resolved project root, which may differ from `tab.root`, so look the file up instead of slicing.
    const entry = [...Object.values(folders).flat(), ...results].find((item) => item.path === selected.path)
    return entry ? parentOf(entry.relativePath) : ''
  }
  /** Starts a new file or folder in `parent`, opening that folder and every folder above it first. */
  const startCreate = (parent: string, directory: boolean): void => {
    setFilter('')
    setRenaming(null)
    const chain = parent ? parent.split(/[\\/]/).map((_, index, parts) => parts.slice(0, index + 1).join('/')) : []
    if (chain.length) setExpanded((previous) => new Set([...previous, ...chain]))
    for (const folder of chain) if (!folders[folder]) void load(folder)
    setCreating({ parent, directory })
  }
  const create = async (parent: string, name: string, directory: boolean): Promise<void> => {
    try {
      const entry = await window.galaxy.files.createEntry(tab.projectId, parent, name, directory, tab.chatId ?? undefined)
      // A name with slashes may have made folders on the way, so reload from where it started.
      await load(parent)
      if (!directory) setSelected({ path: entry.path, nonce: 0 })
    } catch (error) { notify(cleanError(error), 'error') }
  }
  const rename = async (entry: ProjectFileEntry, name: string): Promise<void> => {
    try {
      const renamed = await window.galaxy.files.renameEntry(tab.projectId, entry.relativePath, name, tab.chatId ?? undefined)
      await load(parentOf(entry.relativePath))
      if (entry.directory) {
        setExpanded((previous) => new Set([...previous].map((path) => path === entry.relativePath || path.startsWith(`${entry.relativePath}/`) ? renamed.relativePath + path.slice(entry.relativePath.length) : path)))
        setFolders({})
        setRevision((value) => value + 1)
      }
      setSelected((file) => file && (file.path === entry.path || file.path.startsWith(`${entry.path}/`)) ? { path: renamed.path + file.path.slice(entry.path.length), nonce: file.nonce + 1 } : file)
    } catch (error) { notify(cleanError(error), 'error') }
  }
  const trash = async (entry: ProjectFileEntry): Promise<void> => {
    try {
      await window.galaxy.files.trashEntry(tab.projectId, entry.relativePath, tab.chatId ?? undefined)
      await load(parentOf(entry.relativePath))
      setSelected((file) => file && (file.path === entry.path || file.path.startsWith(`${entry.path}/`)) ? null : file)
      notify(`Moved ${entry.name} to the Trash.`)
    } catch (error) { notify(cleanError(error), 'error') }
  }
  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).then(() => notify('Copied to the clipboard.'), () => notify('Could not copy to the clipboard.', 'error'))
  }
  const act = (run: () => void): void => {
    setMenu(null)
    run()
  }
  const createRow = (parent: string, depth: number): ReactNode => creating && creating.parent === parent && !filter.trim()
    ? <NameInput key={`new:${parent}`} initial="" depth={depth} directory={creating.directory} onCancel={() => setCreating(null)} onSubmit={(name) => { setCreating(null); void create(parent, name, creating.directory) }} />
    : null
  const rows = (entries: ProjectFileEntry[], depth = 0): ReactNode => entries.map((entry) => {
    const open = expanded.has(entry.relativePath)
    if (renaming === entry.relativePath) {
      return <div key={entry.path}>
        <NameInput initial={entry.name} depth={depth} directory={entry.directory} onCancel={() => setRenaming(null)} onSubmit={(name) => { setRenaming(null); void rename(entry, name) }} />
        {entry.directory && open && <>{createRow(entry.relativePath, depth + 1)}{rows(folders[entry.relativePath] ?? [], depth + 1)}</>}
      </div>
    }
    return <div key={entry.path}>
      <button type="button" onClick={() => choose(entry)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ entry, x: event.clientX, y: event.clientY }) }} onDoubleClick={() => { if (!entry.directory) useStore.getState().openFile(entry.path) }} title={entry.relativePath} className={cn('flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-[12px] transition-colors hover:bg-hover', selected?.path === entry.path ? 'bg-hover text-fg' : 'text-muted')} style={{ paddingLeft: 8 + depth * 14 }}>
        {entry.directory ? <><ChevronRight size={12} className={cn('shrink-0 text-subtle transition-transform', open && 'rotate-90')} />{open ? <FolderOpen size={14} className="shrink-0 text-subtle" /> : <Folder size={14} className="shrink-0 text-subtle" />}</> : <><span className="w-3 shrink-0" /><FileIcon name={entry.name} /></>}
        <span className="min-w-0 truncate">{filter.trim() ? entry.relativePath : entry.name}</span>
        {loading.has(entry.relativePath) && <Spinner size={11} />}
      </button>
      {entry.directory && open && <>{createRow(entry.relativePath, depth + 1)}{rows(folders[entry.relativePath] ?? [], depth + 1)}</>}
    </div>
  })
  if (!available) return <div className="flex h-full items-center justify-center text-[12px] text-subtle">Choose a project to browse files.</div>
  return <div className="flex h-full min-w-0 flex-col">
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-3 text-[11.5px] text-muted">
      <FolderOpen size={13} className="shrink-0" /><span className="truncate" title={tab.root}>{basename(tab.root)}</span>
      {selected && <><ChevronRight size={11} className="shrink-0 text-subtle" /><span className="min-w-0 flex-1 truncate font-mono">{selected.path.slice(tab.root.length + 1)}</span></>}
      <button type="button" aria-label={treeOpen ? 'Hide file tree' : 'Show file tree'} title={treeOpen ? 'Hide file tree' : 'Show file tree'} aria-expanded={treeOpen} aria-controls={treeId} onClick={() => setTreeOpen((open) => !open)} className={cn('ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-hover hover:text-fg', treeOpen && 'bg-hover text-fg')}><PanelRight size={14} /></button>
    </div>
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1">
        {selected ? renderFile(selected) : <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
          <FileText size={24} className="text-subtle" />
          <span className="text-[13px] font-medium text-muted">Open a file</span>
          <span className="max-w-[240px] text-[12px] leading-relaxed text-subtle">Select a file from the file tree to view or edit it here.</span>
          {!treeOpen && <button type="button" onClick={() => setTreeOpen(true)} className="mt-1 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-fg">Show file tree</button>}
        </div>}
      </div>
      <div id={treeId} hidden={!treeOpen} className={cn('min-h-0 w-[40%] min-w-[150px] max-w-[220px] shrink-0 flex-col border-l border-line', treeOpen ? 'flex' : 'hidden')}>
        <div className="flex shrink-0 items-center gap-1 p-2"><div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line px-2"><Search size={12} className="shrink-0 text-subtle" /><input aria-label="Filter project files" placeholder="Filter files…" value={filter} onChange={(event) => setFilter(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[11.5px] placeholder:text-subtle" /></div><IconButton label="New file" size="sm" onClick={() => startCreate(selectedFolder(), false)}><FilePlus size={12.5} /></IconButton><IconButton label="Refresh files" size="sm" onClick={() => setRevision((value) => value + 1)}><RotateCw size={12} /></IconButton></div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-3" onContextMenu={(event) => { event.preventDefault(); setMenu({ entry: null, x: event.clientX, y: event.clientY }) }}>{error && <div className="p-2 text-[11.5px] text-danger">{error}</div>}{loading.has('') || searching ? <div className="p-2"><Spinner size={13} className="text-subtle" /></div> : <>{createRow('', 0)}{rows(filter.trim() ? results : folders[''] ?? [])}</>}{filter.trim() && !searching && !results.length && <div className="p-2 text-[11.5px] text-subtle">No matching files.</div>}</div>
      </div>
    </div>
    <div ref={menuAnchor} className="no-drag pointer-events-none fixed h-px w-px" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
    <Popover open={!!menu} onClose={() => setMenu(null)} anchor={menuAnchor} placement="bottom-start" offset={0} className="w-56">
      {menu && (() => {
        const entry = menu.entry
        // New entries go inside a folder, or next to a file.
        const folder = entry ? (entry.directory ? entry.relativePath : parentOf(entry.relativePath)) : ''
        return <>
          {entry && !entry.directory && <>
            <MenuItem icon={<FileText size={14} />} label="Open" onClick={() => act(() => choose(entry))} />
            <MenuItem icon={<ExternalLink size={14} />} label="Open in Editor Tab" onClick={() => act(() => useStore.getState().openFile(entry.path))} />
            <MenuSeparator />
          </>}
          <MenuItem icon={<FilePlus size={14} />} label="New File…" onClick={() => act(() => startCreate(folder, false))} />
          <MenuItem icon={<FolderPlus size={14} />} label="New Folder…" onClick={() => act(() => startCreate(folder, true))} />
          {entry && <>
            <MenuSeparator />
            <MenuItem icon={<Pencil size={14} />} label="Rename…" onClick={() => act(() => { setCreating(null); setRenaming(entry.relativePath) })} />
            <MenuItem icon={<Copy size={14} />} label="Copy Path" onClick={() => act(() => copy(entry.path))} />
            <MenuItem icon={<Copy size={14} />} label="Copy Relative Path" onClick={() => act(() => copy(entry.relativePath))} />
            <MenuItem icon={<FolderOpen size={14} />} label={REVEAL_LABEL} onClick={() => act(() => void window.galaxy.files.reveal(entry.path))} />
            <MenuSeparator />
            <MenuItem icon={<Trash2 size={14} />} label="Move to Trash" danger onClick={() => act(() => void trash(entry))} />
          </>}
        </>
      })()}
    </Popover>
  </div>
}
