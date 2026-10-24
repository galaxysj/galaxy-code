import { Brain, Check, ChevronDown, CircleAlert, Cpu, ListTodo, RefreshCw, Search, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AcpConfigOption } from '@shared/types'
import { cn } from '../lib/utils'
import { useChatId, useRunConfig, useStore } from '../store'
import { Popover, Spinner } from './ui'

const CATEGORY_ORDER = ['model', 'thought_level', 'mode']

function iconFor(category: string | null): typeof Cpu {
  if (category === 'model') return Cpu
  if (category === 'thought_level') return Brain
  if (category === 'mode') return ListTodo
  return SlidersHorizontal
}

/** Agents often prefix choices with their provider; the pill only has room for the rest. */
function shortName(name: string): string {
  const slash = name.lastIndexOf('/')
  return slash >= 0 && slash < name.length - 1 ? name.slice(slash + 1) : name
}

function OptionPicker({ option, value, onPick }: { option: AcpConfigOption; value: string; onPick(value: string): void }): ReactNode {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const current = option.options.find((choice) => choice.value === value) ?? option.options.find((choice) => choice.value === option.currentValue)
  const searchable = option.options.length > 8
  const Icon = iconFor(option.category)

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = option.options.filter((choice) => !needle || `${choice.name} ${choice.value} ${choice.group ?? ''}`.toLowerCase().includes(needle))
    const out: { group: string; choices: typeof visible }[] = []
    for (const choice of visible) {
      const group = choice.group ?? ''
      const last = out[out.length - 1]
      if (last && last.group === group) last.choices.push(choice)
      else out.push({ group, choices: [choice] })
    }
    return out
  }, [option.options, query])

  const pick = (next: string): void => {
    onPick(next)
    setOpen(false)
    setQuery('')
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        title={option.description ?? option.name}
        onClick={() => setOpen(!open)}
        className={cn(
          'flex h-7 min-w-0 max-w-[180px] items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg',
          open && 'bg-hover text-fg'
        )}
      >
        <Icon size={13} className="shrink-0 text-subtle" />
        <span className="truncate">{current ? shortName(current.name) : option.name}</span>
        <ChevronDown size={12} className={cn('picker-chevron shrink-0 text-subtle', open && 'rotate-180')} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="top-start" offset={8} className="w-[280px] overflow-hidden rounded-2xl!">
        {searchable ? (
          <div className="flex h-9 items-center gap-1 border-b border-line px-3">
            <Search size={13} className="shrink-0 text-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && groups[0]?.choices[0]) pick(groups[0].choices[0].value)
              }}
              placeholder={`Search ${option.name.toLowerCase()}`}
              className="ml-1 h-full min-w-0 flex-1 bg-transparent text-[12.5px] placeholder:text-subtle"
            />
          </div>
        ) : (
          <div className="flex h-8 items-center px-3 text-[11px] font-medium text-subtle">{option.name}</div>
        )}
        <div className="max-h-[300px] overflow-y-auto p-1">
          {groups.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-subtle">Nothing matches.</div>}
          {groups.map((group, index) => (
            <div key={`${group.group}:${index}`} className="mb-1 last:mb-0">
              {group.group && <div className="flex h-6 items-center px-2 text-[11px] font-medium text-subtle">{group.group}</div>}
              {group.choices.map((choice) => {
                const selected = choice.value === current?.value
                return (
                  <button
                    key={choice.value}
                    type="button"
                    onClick={() => pick(choice.value)}
                    className={cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-hover', selected ? 'text-fg' : 'text-muted')}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{choice.name}</span>
                      {choice.description && <span className="block text-[11px] leading-snug text-subtle">{choice.description}</span>}
                    </span>
                    <span className="flex w-3.5 shrink-0 justify-end pt-[1px]">{selected && <Check size={13} />}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </Popover>
    </>
  )
}

/** Sits beside the + button in ACP chats: one picker per session option the agent reports. */
export function AcpOptions(): ReactNode {
  const { model, acp } = useRunConfig()
  const load = useStore((s) => s.loadAcpOptions)
  const setOption = useStore((s) => s.setAcpOption)
  const chatId = useChatId()
  const agentId = acp?.agentId

  useEffect(() => {
    if (agentId) void load(agentId, false, chatId)
  }, [agentId, load])

  const options = useMemo(() => {
    const rank = (option: AcpConfigOption): number => {
      const index = CATEGORY_ORDER.indexOf(option.category ?? '')
      return index < 0 ? CATEGORY_ORDER.length : index
    }
    return [...(acp?.options ?? [])].sort((a, b) => rank(a) - rank(b))
  }, [acp?.options])

  if (!acp) return null
  if (options.length === 0) {
    if (acp.loading) {
      return (
        <span className="flex h-7 items-center gap-1.5 px-2 text-[12.5px] text-subtle">
          <Spinner size={12} /> Loading {model?.name ?? 'agent'} options
        </span>
      )
    }
    return (
      <button
        type="button"
        title={acp.error ? `${acp.error}. Click to try again.` : 'Ask the agent for its options again'}
        onClick={() => void load(acp.agentId, true, chatId)}
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
      >
        {acp.error ? <CircleAlert size={13} className="shrink-0 text-warn" /> : <RefreshCw size={12} className="shrink-0 text-subtle" />}
        <span className="truncate">{acp.error ? 'Options unavailable' : `${model?.name ?? 'Agent'} default`}</span>
      </button>
    )
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5">
      {options.map((option) => (
        <OptionPicker key={option.id} option={option} value={acp.values[option.id] ?? option.currentValue} onPick={(value) => setOption(option.id, value, chatId)} />
      ))}
    </div>
  )
}
