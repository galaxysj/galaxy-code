import { Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, Search, Settings2, Sparkles, Zap } from 'lucide-react'
import { AUTO_MODEL } from '@shared/catalog'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { AcpAgents } from '@shared/acp-registry'
import { EFFORT_LABELS, type Effort, type ResolvedModel, type Subscription } from '@shared/types'
import { cn } from '../lib/utils'
import { rememberedRunOptions, useChatId, useRunConfig, useStore } from '../store'
import { Popover, Switch } from './ui'

function FastIcon({ size = 12 }: { size?: number }): ReactNode {
  return <Zap size={size} fill="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-fg" />
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
  /** Leaves out the Ultra stop, for modes that cannot run with it. */
  allowUltra: boolean
  onChange(next: { effort?: Effort; ultra: boolean }): void
}

/** A pill slider over the model's efforts. Ultra, when the model has it, is the final stop. */
function EffortSlider({ model, effort, ultra, allowUltra, onChange }: EffortSliderProps): ReactNode {
  const track = useRef<HTMLDivElement>(null)
  const stops = useMemo<Stop[]>(() => [...model.efforts, ...(model.ultraEffort && allowUltra ? (['ultra'] as const) : [])], [model, allowUltra])
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

function ModelList({ current, subscription, allowUltra, onPick, onBack, onClose }: { current: ResolvedModel | null; subscription: Subscription | null; allowUltra: boolean; onPick(key: string): void; onBack(): void; onClose(): void }): ReactNode {
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
                {entry.ultraEffort && allowUltra && <span className="shrink-0 text-[10.5px] text-ultra/80">Ultra</span>}
                {entry.fastMode && <Zap size={11} className="shrink-0 text-subtle" />}
                <span className="flex w-3.5 shrink-0 justify-end">{entry.key === current?.key && <Check size={13} />}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <ConfigureModels onOpen={onClose} />
    </div>
  )
}

/** Short label for a context size: 300K, 1M. */
function contextLabel(tokens: number): string {
  if (tokens >= 900_000 && tokens <= 1_100_000) return '1M'
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(2)}M` : `${Math.round(tokens / 1000)}K`
}

/** A model's effort and speed in a few words, as the list shows them beside its name. */
function optionSummary(model: ResolvedModel, options: { effort: Effort | null; ultra: boolean; fast: boolean; ultrafast: boolean; context?: number | null }, allowUltra: boolean): string {
  if (model.auto) return ''
  const effort = options.ultra && allowUltra && model.ultraEffort ? 'Ultra' : options.effort ? EFFORT_LABELS[options.effort] : ''
  const speed = options.ultrafast ? 'Ultrafast' : options.fast ? 'Fast' : ''
  const context = options.context != null && options.context !== (model.contextOptions?.[0] ?? model.contextWindow ?? 200_000) ? contextLabel(options.context) : ''
  return [context, effort, speed].filter(Boolean).join(' ')
}

/** Opens Settings > Models, below a divider at the foot of either picker's list. */
function ConfigureModels({ onOpen }: { onOpen(): void }): ReactNode {
  return (
    <div className="shrink-0 border-t border-line p-1">
      <button type="button" onClick={() => { onOpen(); useStore.setState({ settingsOpen: 'models' }) }} className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg">
        <Settings2 size={13} className="shrink-0" />
        <span>Configure models</span>
      </button>
    </div>
  )
}

function MenuHeading({ children }: { children: ReactNode }): ReactNode {
  return <div className="px-2 pb-0.5 pt-1.5 text-[10.5px] text-subtle">{children}</div>
}

function MenuRow({ label, checked, onClick, className }: { label: ReactNode; checked: boolean; onClick(): void; className?: string }): ReactNode {
  return (
    <button type="button" onClick={onClick} className={cn('flex h-6 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors hover:bg-hover', className ?? 'text-fg')}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check size={12} className="shrink-0 text-muted" />}
    </button>
  )
}

/** The Default style: every model in a list, with the picked model's context, effort and options in a menu beside it. */
function ListPicker({ noUltra }: { noUltra: boolean }): ReactNode {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  /** The model whose options menu is open; it opens from the row's Edit button. */
  const [editing, setEditing] = useState<string | null>(null)
  /** Vertical center of the row whose Edit opened the options, so they open around it. */
  const [editCenter, setEditCenter] = useState(0)
  const listBox = useRef<HTMLDivElement>(null)
  const sideBox = useRef<HTMLDivElement>(null)
  const [sideTop, setSideTop] = useState(0)
  const [sideOnLeft, setSideOnLeft] = useState(false)
  /** Height left for the models: the whole picker, search to Configure models, scrolls as one when the window is short. */
  const [listHeight, setListHeight] = useState(280)
  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      // The popover opens below, or above when there is more room there; 16px of margins and gap, ~64px of search and Auto.
      const room = Math.max(window.innerHeight - rect.bottom, rect.top) - 16 - 64
      setListHeight(Math.max(80, Math.min(280, room)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])
  const models = useStore((s) => s.models)
  const pickModel = useStore((s) => s.pickModel)
  const setRunOptions = useStore((s) => s.setRunOptions)
  const chatId = useChatId()
  const config = useRunConfig()
  const { model, subscription, effort, fast, ultrafast, context } = config
  const ultra = config.ultra && !noUltra
  const auto = !!model?.auto
  // Effort and speed in words, such as "High Fast", instead of the slider style's icons.
  const label = !model || auto ? '' : optionSummary(model, { effort, ultra, fast, ultrafast, context }, !noUltra)
  const needle = query.trim().toLowerCase()
  const visible = models.filter((m) => m.enabled && !m.auto && m.subscription === subscription && (!needle || m.name.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle)))
  const current = { effort, ultra, fast, ultrafast }
  // Open the options around the Edit row, kept within the list's height.
  useLayoutEffect(() => {
    if (!open || !editing) return
    const measure = (): void => {
      const side = sideBox.current?.offsetHeight ?? 0
      const list = listBox.current
      if (!list) return
      setSideTop(Math.max(0, Math.min(editCenter - side / 2, list.offsetHeight - side)))
      const rect = list.getBoundingClientRect()
      setSideOnLeft(window.innerWidth - rect.right < 180 + 6 + 8 && rect.left > window.innerWidth - rect.right)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, editing, editCenter, model?.key])
  const hasOptions = (entry: ResolvedModel): boolean => entry.efforts.length > 0 || entry.fastMode || !!entry.contextOptions?.length
  const side = model && !auto && editing === model.key && hasOptions(model)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        onClick={() => { setEditing(null); setOpen((value) => !value) }}
        className={cn('flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg', open && 'bg-hover text-fg', ultra && 'aurora-ring')}
      >
        <span className="truncate">{model?.name ?? 'Select a model'}</span>
        {label && <span className={cn('shrink-0', ultra ? 'aurora-text font-medium' : 'text-subtle')}>{label}</span>}
        <ChevronDown size={12} className={cn('picker-chevron shrink-0 text-subtle', open && 'rotate-180')} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" offset={8} className="flex! items-start gap-1.5 bg-transparent! shadow-none!">
        <div ref={listBox} className="picker-scroll flex w-[228px] shrink-0 flex-col overflow-y-auto overscroll-contain rounded-lg bg-elev shadow-pop" style={{ maxHeight: listHeight + 64 + 37 }}>
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" className="h-8 shrink-0 bg-transparent px-3 text-[12px] placeholder:text-subtle" />
          {subscription === 'Default' && !needle && (
            <div className="flex h-8 shrink-0 items-center justify-between border-b border-line px-3 text-[12px]">
              <span>Auto</span>
              <Switch checked={auto} onChange={(on) => pickModel(on ? AUTO_MODEL.key : (visible[0]?.key ?? AUTO_MODEL.key), chatId)} label="Auto" />
            </div>
          )}
          <div className="shrink-0 p-1">
            {visible.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-subtle">{subscription ? 'No models match.' : 'Choose a signed-in subscription or Local.'}</div>}
            {visible.map((entry) => {
              const checked = entry.key === model?.key
              const options = checked ? { ...current, context } : rememberedRunOptions(entry)
              const summary = optionSummary(entry, options, !noUltra)
              const defaultFast = entry.fastMode && (entry.defaultSpeed === 'Fast' || entry.defaultSpeed === 'Ultrafast')
              const defaultUltrafast = defaultFast && entry.ultrafastMode && entry.defaultSpeed === 'Ultrafast'
              const isDefault = (options.effort ?? entry.defaultEffort) === entry.defaultEffort && !options.ultra && options.fast === defaultFast && options.ultrafast === defaultUltrafast && (options.context == null || options.context === (entry.contextOptions?.[0] ?? entry.contextWindow))
              return (
                <div key={entry.key} className="group/model flex h-6 w-full items-center rounded-md transition-colors hover:bg-hover">
                  <button type="button" onClick={() => { pickModel(entry.key, chatId); setEditing(null) }} className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left text-[12px] text-fg">
                    <span className="min-w-0 flex-1 truncate">{entry.name}{summary && <span className="text-subtle"> {summary}</span>}</span>
                  </button>
                  {/* The far right shows a check on the picked model; hovering swaps it for Edit, which opens the model's options. */}
                  <span className="mx-1 flex h-5 w-14 shrink-0 items-center justify-end gap-0.5">
                    {hasOptions(entry) && !isDefault && (
                      <button
                        type="button"
                        title="Reset to defaults"
                        aria-label={`Reset ${entry.name} to defaults`}
                        onClick={() => useStore.getState().resetModelOptions(entry.key, chatId)}
                        className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:text-fg group-hover/model:flex group-focus-within/model:flex"
                      >
                        <RotateCcw size={12} />
                      </button>
                    )}
                    {checked && editing !== entry.key && <Check size={12} className={cn('mr-1 text-muted', hasOptions(entry) && 'group-hover/model:hidden')} />}
                    {hasOptions(entry) && (
                      <button type="button" onClick={(event) => { if (!checked) pickModel(entry.key, chatId); const row = event.currentTarget.closest('.group\\/model') as HTMLElement; const box = listBox.current!.getBoundingClientRect(); const rect = row.getBoundingClientRect(); setEditCenter(rect.top - box.top + rect.height / 2); setEditing((value) => value === entry.key ? null : entry.key) }} className={cn('h-5 rounded px-1.5 text-[11px] text-muted hover:text-fg', editing === entry.key ? 'text-fg' : 'hidden group-hover/model:block')}>Edit</button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
          <ConfigureModels onOpen={() => setOpen(false)} />
        </div>
        {/* Keep options out of the popover's measured width so toggling Edit never moves the model list. */}
        {side && (
          <div ref={sideBox} style={{ top: sideTop, ...(sideOnLeft ? { right: 'calc(100% + 6px)' } : { left: 'calc(100% + 6px)' }) }} className="absolute w-[180px] rounded-lg bg-elev p-1 shadow-pop">
            {!!model.contextOptions?.length && <>
              <MenuHeading>Context</MenuHeading>
              {model.contextOptions.map((size) => <MenuRow key={size} label={contextLabel(size)} checked={(context != null && model.contextOptions?.includes(context) ? context : model.contextOptions?.[0]) === size} onClick={() => setRunOptions({ context: size }, chatId)} />)}
            </>}
            {model.efforts.length > 0 && <>
              {!!model.contextOptions?.length && <div className="my-1 border-t border-line" />}
              <MenuHeading>Effort</MenuHeading>
              {model.efforts.map((value) => <MenuRow key={value} label={EFFORT_LABELS[value]} checked={!ultra && (effort ?? model.defaultEffort) === value} onClick={() => setRunOptions({ effort: value, ultra: false }, chatId)} />)}
              {/* Ultra sits below the highest effort, in purple. */}
              {model.ultraEffort && !noUltra && <MenuRow label="Ultra" checked={ultra} onClick={() => setRunOptions({ ultra: true }, chatId)} className="font-medium text-ultra" />}
            </>}
            {model.fastMode && <>
              <div className="my-1 border-t border-line" />
              <MenuHeading>Options</MenuHeading>
              <div className="flex h-6 items-center justify-between rounded-md px-2 text-[12px] text-fg transition-colors hover:bg-hover"><span>Fast</span><Switch checked={fast && !ultrafast} onChange={(on) => setRunOptions({ fast: on, ultrafast: false }, chatId)} label="Fast" /></div>
              {model.ultrafastMode && <div className="flex h-6 items-center justify-between rounded-md px-2 text-[12px] text-fg transition-colors hover:bg-hover"><span>Ultrafast</span><Switch checked={ultrafast} onChange={(on) => setRunOptions({ fast: on, ultrafast: on }, chatId)} label="Ultrafast" /></div>}
            </>}
          </div>
        )}
      </Popover>
    </>
  )
}

/** Picks the style chosen in Settings > General > Composer. `noUltra` hides Ultra, for modes that cannot run with it. */
export function ModelPicker({ noUltra = false }: { noUltra?: boolean }): ReactNode {
  const style = useStore((s) => s.settings.modelPickerStyle ?? 'default')
  return style === 'slider' ? <SliderPicker noUltra={noUltra} /> : <ListPicker noUltra={noUltra} />
}

/** The Slider style: one model, with an effort slider. */
function SliderPicker({ noUltra }: { noUltra: boolean }): ReactNode {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState(false)
  const pickModel = useStore((s) => s.pickModel)
  const setRunOptions = useStore((s) => s.setRunOptions)
  const chatId = useChatId()
  const config = useRunConfig()
  const { model, subscription, effort, fast, ultrafast } = config
  const ultra = config.ultra && !noUltra

  const close = useCallback(() => {
    setOpen(false)
  }, [])

  const auto = !!model?.auto
  const hasEffort = !!model && !auto && model.efforts.length > 0
  const label = !model ? '' : auto ? 'Auto' : ultra ? 'Ultra' : effort ? EFFORT_LABELS[effort] : 'Standard'
  // Reset goes back to the model's DefaultSpeed from models.ts.
  const defaultFast = !!model?.fastMode && (model.defaultSpeed === 'Fast' || model.defaultSpeed === 'Ultrafast')
  const defaultUltrafast = defaultFast && !!model?.ultrafastMode && model.defaultSpeed === 'Ultrafast'
  const isDefault = !!model && !ultra && fast === defaultFast && ultrafast === defaultUltrafast && effort === model.defaultEffort
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
            allowUltra={!noUltra}
            onBack={() => (model ? setListing(false) : close())}
            onClose={close}
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
                  fast ? 'text-fg hover:bg-hover' : 'text-muted hover:bg-hover hover:text-fg'
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
                disabled={auto || isDefault || (!hasEffort && fast === defaultFast && ultrafast === defaultUltrafast)}
                onClick={() => setRunOptions({ ...(model.defaultEffort ? { effort: model.defaultEffort } : {}), ultra: false, fast: defaultFast, ultrafast: defaultUltrafast }, chatId)}
                className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-25"
              >
                <RotateCcw size={13} />
              </button>
            </div>
            {auto && <p className="mt-2 px-1 text-center text-[11.5px] leading-snug text-subtle">Picks the best model for each request automatically.</p>}
            {hasEffort && (
              <div className="mt-2.5" title={ultra ? `Ultra orchestrates parallel subagents at ${EFFORT_LABELS[model.ultraEffort as Effort].toLowerCase()} effort` : undefined}>
                <EffortSlider model={model} effort={effort} ultra={ultra} allowUltra={!noUltra} onChange={(next) => setRunOptions(next, chatId)} />
              </div>
            )}
          </div>
        )}
      </Popover>
    </>
  )
}
