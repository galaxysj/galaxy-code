import { Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, Search, Sparkles, Zap } from 'lucide-react'
import { AUTO_MODEL } from '@shared/catalog'
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { AcpAgents } from '@shared/acp-registry'
import { EFFORT_LABELS, type Effort, type ResolvedModel, type Subscription } from '@shared/types'
import { cn } from '../lib/utils'
import { useChatId, useRunConfig, useStore } from '../store'
import { Popover } from './ui'

function FastIcon({ size = 12 }: { size?: number }): ReactNode {
  return <Zap size={size} fill="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-black" />
}

function UltrafastIcon({ size = 12 }: { size?: number }): ReactNode {
  return <Zap size={size} fill="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[#4a7cf6]" />
}

export const SUBSCRIPTION_LABELS: Record<Subscription, string> = {
  Default: 'OpenRouter',
  Claude: 'Claude',
  Codex: 'Codex',
  ...Object.fromEntries(AcpAgents.map((agent) => [agent.DisplayName, agent.DisplayName]))
}

type Stop = Effort | 'ultra'

const TRACK_HEIGHT = 22
const THUMB = 22
/** Distance from each end of the track to its first and last stop. */
const INSET = TRACK_HEIGHT / 2

interface EffortSliderProps {
  model: ResolvedModel
  effort: Effort | null
  ultra: boolean
  onChange(next: { effort?: Effort; ultra: boolean }): void
}

/** A pill slider over the model's efforts. Ultra, when the model has it, is the final stop. */
function EffortSlider({ model, effort, ultra, onChange }: EffortSliderProps): ReactNode {
  const track = useRef<HTMLDivElement>(null)
  const stops = useMemo<Stop[]>(() => [...model.efforts, ...(model.ultraEffort ? (['ultra'] as const) : [])], [model])
  const last = stops.length - 1
  const index = ultra ? last : Math.max(0, stops.indexOf(effort ?? model.defaultEffort ?? model.efforts[0]))

  const select = useCallback(
    (next: number) => {
      const stop = stops[Math.max(0, Math.min(last, next))]
      if (stop === 'ultra') onChange({ ultra: true })
      else onChange({ effort: stop, ultra: false })
    },
    [stops, last, onChange]
  )

  const fromPointer = (event: PointerEvent): void => {
    const el = track.current
    if (!el || last === 0) return
    const rect = el.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - INSET) / (rect.width - INSET * 2)))
    const next = Math.round(ratio * last)
    if (next !== index) select(next)
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      select(index + 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      select(index - 1)
    }
  }

  // Stops are spread between the insets, so the thumb sits flush inside both ends.
  const at = (i: number): string => (last === 0 ? `calc(100% - ${INSET}px)` : `calc(${INSET}px + (100% - ${INSET * 2}px) * ${i / last})`)
  const label = ultra ? 'Ultra' : EFFORT_LABELS[stops[index] as Effort]

  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Reasoning effort"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={label}
      onKeyDown={onKey}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        fromPointer(event)
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) fromPointer(event)
      }}
      className={cn('relative w-full cursor-pointer touch-none rounded-full bg-active outline-none', ultra && 'aurora-glow')}
      style={{ height: TRACK_HEIGHT }}
    >
      <div
        className={cn('slider-fill absolute inset-y-0 left-0 rounded-full', ultra ? 'aurora-fill' : 'bg-[var(--slider)]')}
        style={{ width: `calc(${at(index)} + ${INSET}px)` }}
      />
      {stops.map((stop, i) => (
        <span
          key={stop}
          className={cn(
            'absolute top-1/2 h-[4px] w-[4px] -translate-x-1/2 -translate-y-1/2 rounded-full',
            i < index ? 'bg-white/55' : i === index ? 'bg-transparent' : stop === 'ultra' ? 'bg-ultra' : 'bg-fg/30'
          )}
          style={{ left: at(i) }}
        />
      ))}
      <span
        className="slider-thumb absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3),0_0_0_0.5px_rgba(0,0,0,0.12)]"
        style={{ left: at(index), width: THUMB, height: THUMB }}
      />
    </div>
  )
}

function ModelList({ current, subscription, onPick, onBack }: { current: ResolvedModel | null; subscription: Subscription | null; onPick(key: string): void; onBack(): void }): ReactNode {
  const models = useStore((s) => s.models)
  const hasKey = useStore((s) => s.secrets.openRouterKey)
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = models.filter((m) => m.enabled && !m.auto && m.subscription === subscription && (!needle || m.name.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle)))
    return subscription && visible.length > 0 ? [{ subscription, models: visible }] : []
  }, [models, query, subscription])

  return (
    <div className="picker-view">
      <div className="flex h-9 items-center gap-1 border-b border-line pl-1 pr-3">
        <button type="button" title="Back" onClick={onBack} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg">
          <ChevronLeft size={15} />
        </button>
        <Search size={13} className="shrink-0 text-subtle" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && groups[0]?.models[0]) onPick(groups[0].models[0].key)
          }}
          placeholder="Search models"
          className="ml-1 h-full min-w-0 flex-1 bg-transparent text-[12.5px] placeholder:text-subtle"
        />
      </div>
      <div className="max-h-[300px] overflow-y-auto p-1">
        {subscription === 'Default' && !query.trim() && (
          <button
            type="button"
            onClick={() => onPick(AUTO_MODEL.key)}
            className={cn('mb-1 flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors hover:bg-hover', current?.auto ? 'text-fg' : 'text-muted')}
          >
            <Sparkles size={12} className="shrink-0 text-subtle" />
            <span className="min-w-0 flex-1 truncate">Auto</span>
            <span className="flex w-3.5 shrink-0 justify-end">{current?.auto && <Check size={13} />}</span>
          </button>
        )}
        {groups.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-subtle">{subscription ? 'No models match.' : 'Choose a signed-in subscription or Local.'}</div>}
        {groups.map((group) => (
          <div key={group.subscription} className="mb-1 last:mb-0">
            <div className="flex h-6 items-center justify-between px-2 text-[11px] font-medium text-subtle">
              <span>{group.subscription === 'Default' ? 'Local' : (SUBSCRIPTION_LABELS[group.subscription] ?? group.subscription)}</span>
              {group.subscription === 'Default' && !hasKey && (
                <button type="button" className="text-warn hover:underline" onClick={() => useStore.setState({ settingsOpen: 'providers' })}>
                  Add API key
                </button>
              )}
            </div>
            {group.models.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => onPick(entry.key)}
                className={cn(
                  'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors hover:bg-hover',
                  entry.key === current?.key ? 'text-fg' : 'text-muted'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.ultraEffort && <span className="shrink-0 text-[10.5px] text-ultra/80">Ultra</span>}
                {entry.fastMode && <Zap size={11} className="shrink-0 text-subtle" />}
                <span className="flex w-3.5 shrink-0 justify-end">{entry.key === current?.key && <Check size={13} />}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function ModelPicker(): ReactNode {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState(false)
  const pickModel = useStore((s) => s.pickModel)
  const setRunOptions = useStore((s) => s.setRunOptions)
  const chatId = useChatId()
  const { model, subscription, effort, ultra, fast, ultrafast } = useRunConfig()

  const close = useCallback(() => {
    setOpen(false)
  }, [])

  const auto = !!model?.auto
  const hasEffort = !!model && !auto && model.efforts.length > 0
  const label = !model ? '' : auto ? 'Auto' : ultra ? 'Ultra' : effort ? EFFORT_LABELS[effort] : 'Standard'
  const isDefault = !!model && !ultra && !fast && effort === model.defaultEffort
  const speedIcon = ultrafast ? <UltrafastIcon /> : fast ? <FastIcon /> : null
  // Off, Fast, then Ultrafast where the model has it.
  const nextSpeed = (): { fast: boolean; ultrafast: boolean } =>
    !fast ? { fast: true, ultrafast: false } : !ultrafast && model?.ultrafastMode ? { fast: true, ultrafast: true } : { fast: false, ultrafast: false }
  const speedTitle = !model?.fastMode
    ? 'This model has no Fast mode'
    : ultrafast
      ? 'Ultrafast is on. Fastest output, billed at the highest rate.'
      : fast
        ? model.ultrafastMode
          ? 'Fast is on. Click again for Ultrafast.'
          : 'Fast is on. Faster output, billed at a higher rate.'
        : 'Turn on Fast'

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (open) close()
          else {
            setListing(false)
            setOpen(true)
          }
        }}
        className={cn(
          'flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg',
          open && 'bg-hover text-fg',
          ultra && 'aurora-ring'
        )}
      >
        {!auto && speedIcon}
        <span className="truncate">{model?.name ?? 'Select a model'}</span>
        {model && !auto && (ultra || effort) && <span className={cn('shrink-0', ultra ? 'aurora-text font-medium' : 'text-subtle')}>{label}</span>}
        <ChevronDown size={12} className={cn('picker-chevron shrink-0 text-subtle', open && 'rotate-180')} />
      </button>
      <Popover open={open} onClose={close} anchor={anchor} placement="top-end" offset={8} className={cn('overflow-hidden rounded-2xl!', listing || !model ? 'w-[264px]' : 'w-[228px]')}>
        {listing || !model ? (
          <ModelList
            current={model}
            subscription={subscription}
            onBack={() => (model ? setListing(false) : close())}
            onPick={(key) => {
              pickModel(key, chatId)
              setListing(false)
            }}
          />
        ) : (
          <div className="picker-view picker-view-back px-3 pb-3 pt-2">
            <div className="flex items-start">
              {auto ? <span className="-ml-1 h-6 w-6 shrink-0" /> : <button
                type="button"
                title={speedTitle}
                disabled={!model.fastMode}
                aria-label={ultrafast ? 'Ultrafast mode' : 'Fast mode'}
                aria-pressed={fast}
                onClick={() => setRunOptions(nextSpeed(), chatId)}
                className={cn(
                  '-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-25',
                  fast ? 'text-black hover:bg-hover' : 'text-muted hover:bg-hover hover:text-fg'
                )}
              >
                {ultrafast ? <UltrafastIcon size={13.5} /> : fast ? <FastIcon size={13.5} /> : <Zap size={13.5} strokeWidth={1.5} />}
              </button>}
              <button
                type="button"
                onClick={() => setListing(true)}
                aria-label="Choose a model"
                className="min-w-0 flex-1 rounded-lg px-1 pb-1 text-center transition-colors hover:bg-hover"
              >
                <span className={cn('block text-[13px] font-semibold leading-6', ultra ? 'aurora-text' : hasEffort ? 'text-[var(--slider)]' : 'text-fg')}>{label}</span>
                <span className="-mt-1 flex max-w-full items-center justify-center gap-0.5 text-[11.5px] leading-4 text-muted">
                  <span className="truncate">{auto ? 'Choose a model' : model.name}</span>
                  <ChevronRight size={11} className="shrink-0 opacity-70" />
                </span>
              </button>
              <button
                type="button"
                title="Reset to default"
                disabled={auto || isDefault || (!hasEffort && !fast)}
                onClick={() => setRunOptions({ ...(model.defaultEffort ? { effort: model.defaultEffort } : {}), ultra: false, fast: false, ultrafast: false }, chatId)}
                className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-25"
              >
                <RotateCcw size={13} />
              </button>
            </div>
            {auto && <p className="mt-2 px-1 text-center text-[11.5px] leading-snug text-subtle">Picks the best model for each request automatically.</p>}
            {hasEffort && (
              <div className="mt-2.5" title={ultra ? `Ultra orchestrates parallel subagents at ${EFFORT_LABELS[model.ultraEffort as Effort].toLowerCase()} effort` : undefined}>
                <EffortSlider model={model} effort={effort} ultra={ultra} onChange={(next) => setRunOptions(next, chatId)} />
              </div>
            )}
          </div>
        )}
      </Popover>
    </>
  )
}
