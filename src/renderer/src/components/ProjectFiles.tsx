import { ChevronRight, Code, FileImage, FileText, Folder, FolderOpen, PanelRight, Search, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import type { ProjectFileEntry } from '@shared/types'
import { basename, cn } from '../lib/utils'
import type { OpenFile, PanelTab } from '../store'
import { useStore } from '../store'
import { IconButton, Spinner } from './ui'

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
  const rows = (entries: ProjectFileEntry[], depth = 0): ReactNode => entries.map((entry) => {
    const open = expanded.has(entry.relativePath)
    return <div key={entry.path}>
      <button type="button" onClick={() => choose(entry)} onDoubleClick={() => { if (!entry.directory) useStore.getState().openFile(entry.path) }} title={entry.relativePath} className={cn('flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-[12px] transition-colors hover:bg-hover', selected?.path === entry.path ? 'bg-hover text-fg' : 'text-muted')} style={{ paddingLeft: 8 + depth * 14 }}>
        {entry.directory ? <><ChevronRight size={12} className={cn('shrink-0 text-subtle transition-transform', open && 'rotate-90')} />{open ? <FolderOpen size={14} className="shrink-0 text-subtle" /> : <Folder size={14} className="shrink-0 text-subtle" />}</> : <><span className="w-3 shrink-0" /><FileIcon name={entry.name} /></>}
        <span className="min-w-0 truncate">{filter.trim() ? entry.relativePath : entry.name}</span>
        {loading.has(entry.relativePath) && <Spinner size={11} />}
      </button>
      {entry.directory && open && rows(folders[entry.relativePath] ?? [], depth + 1)}
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
        <div className="flex shrink-0 items-center gap-1 p-2"><div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line px-2"><Search size={12} className="shrink-0 text-subtle" /><input aria-label="Filter project files" placeholder="Filter files…" value={filter} onChange={(event) => setFilter(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[11.5px] placeholder:text-subtle" /></div><IconButton label="Refresh files" size="sm" onClick={() => setRevision((value) => value + 1)}><RotateCw size={12} /></IconButton></div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-3">{error && <div className="p-2 text-[11.5px] text-danger">{error}</div>}{loading.has('') || searching ? <div className="p-2"><Spinner size={13} className="text-subtle" /></div> : rows(filter.trim() ? results : folders[''] ?? [])}{filter.trim() && !searching && !results.length && <div className="p-2 text-[11.5px] text-subtle">No matching files.</div>}</div>
      </div>
    </div>
  </div>
}
