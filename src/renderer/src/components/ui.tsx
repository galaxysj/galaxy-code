import { Check, ChevronDown, Copy, Loader2 } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { cn, copyText } from '../lib/utils'

export function Spinner({ size = 14, className }: { size?: number; className?: string }): ReactNode {
  return <Loader2 size={size} className={cn('spin shrink-0', className)} />
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: 'sm' | 'md'
}

export function IconButton({ label, active, size = 'md', className, children, ...rest }: IconButtonProps): ReactNode {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        'no-drag relative z-10 inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35',
        size === 'sm' ? 'h-6 w-6' : 'h-7 w-7',
        active && 'bg-active text-fg',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

export function Button({ variant = 'secondary', size = 'md', className, children, ...rest }: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' ? 'h-6.5 px-2 text-[12px]' : 'h-7.5 px-3 text-[12.5px]',
        variant === 'primary' && 'bg-accent text-on-accent hover:opacity-90',
        variant === 'secondary' && 'border border-line-strong bg-elev text-fg hover:bg-hover',
        variant === 'ghost' && 'text-muted hover:bg-hover hover:text-fg',
        variant === 'danger' && 'border border-danger/40 text-danger hover:bg-danger/10',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange(next: boolean): void; disabled?: boolean; label?: string }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-line-strong'
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[14px] w-[14px] rounded-full transition-all',
          checked ? 'left-[14px] bg-on-accent' : 'left-[2px] bg-elev'
        )}
      />
    </button>
  )
}

export type Placement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end'

interface PopoverProps {
  open: boolean
  onClose(): void
  anchor: RefObject<HTMLElement | null>
  placement?: Placement
  offset?: number
  className?: string
  children: ReactNode
}

let openPopovers = 0
const popoverListeners = new Set<() => void>()

function subscribePopovers(listener: () => void): () => void {
  popoverListeners.add(listener)
  return () => popoverListeners.delete(listener)
}

/** Whether a popover is on screen. Native views sit above all HTML, so they must step aside for it. */
export function usePopoverShown(): boolean {
  return useSyncExternalStore(subscribePopovers, () => openPopovers > 0)
}

/** A floating panel anchored to an element. Closes on outside press or Escape, and flips to stay on screen. */
export function Popover({ open, onClose, anchor, placement = 'bottom-start', offset = 6, className, children }: PopoverProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [present, setPresent] = useState(open)
  const [style, setStyle] = useState<{ left: number; top: number; origin: string } | null>(null)

  const position = useCallback(() => {
    const target = anchor.current
    const panel = ref.current
    if (!target || !panel) return
    const rect = target.getBoundingClientRect()
    const width = panel.offsetWidth
    const height = panel.offsetHeight
    const margin = 8
    let vertical = placement.startsWith('top') ? 'top' : 'bottom'
    if (vertical === 'top' && rect.top - height - offset < margin && window.innerHeight - rect.bottom > rect.top) vertical = 'bottom'
    if (vertical === 'bottom' && rect.bottom + height + offset > window.innerHeight - margin && rect.top > window.innerHeight - rect.bottom) vertical = 'top'
    const top = vertical === 'top' ? rect.top - height - offset : rect.bottom + offset
    let left = placement.endsWith('end') ? rect.right - width : rect.left
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))
    setStyle({
      left,
      top: Math.max(margin, Math.min(top, window.innerHeight - height - margin)),
      origin: `${vertical === 'top' ? 'bottom' : 'top'} ${placement.endsWith('end') ? 'right' : 'left'}`
    })
  }, [anchor, placement, offset])

  useLayoutEffect(() => {
    if (!open) return
    setPresent(true)
    position()
    const panel = ref.current
    const observer = panel ? new ResizeObserver(position) : null
    if (panel) observer?.observe(panel)
    window.addEventListener('resize', position)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', position)
    }
  }, [open, position])

  const shown = open || present
  useLayoutEffect(() => {
    if (!shown) return
    openPopovers++
    popoverListeners.forEach((listener) => listener())
    return () => {
      openPopovers--
      popoverListeners.forEach((listener) => listener())
    }
  }, [shown])

  // Keep the panel mounted briefly so closing has the same visual continuity as opening.
  useEffect(() => {
    if (open || !present) return
    const timer = window.setTimeout(() => {
      setPresent(false)
      setStyle(null)
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140)
    return () => window.clearTimeout(timer)
  }, [open, present])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, anchor])

  if (!open && !present) return null
  return createPortal(
    <div
      ref={ref}
      data-popover
      data-state={open ? 'open' : 'closed'}
      data-side={style?.origin.startsWith('bottom') ? 'top' : 'bottom'}
      inert={!open}
      className={cn('popover-panel no-drag fixed z-50 rounded-xl bg-elev shadow-pop', !style && 'invisible', className)}
      style={{ left: style?.left ?? 0, top: style?.top ?? 0, transformOrigin: style?.origin }}
    >
      {children}
    </div>,
    document.body
  )
}

interface MenuItemProps {
  icon?: ReactNode
  label: ReactNode
  hint?: ReactNode
  selected?: boolean
  danger?: boolean
  disabled?: boolean
  onClick(): void
}

export function MenuItem({ icon, label, hint, selected, danger, disabled, onClick }: MenuItemProps): ReactNode {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-40',
        danger ? 'text-danger' : 'text-fg'
      )}
    >
      {icon !== undefined && <span className={cn('flex w-4 shrink-0 justify-center', danger ? 'text-danger' : 'text-muted')}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-subtle">{hint}</span>}
      {selected && <Check size={13} className="shrink-0 text-fg" />}
    </button>
  )
}

export interface DropdownOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  hint?: ReactNode
  /** Hover text for the button while this option is selected. */
  title?: string
}

interface DropdownProps<T extends string> {
  value: T
  options: DropdownOption<T>[]
  onChange(value: T): void
  label: string
  disabled?: boolean
  placement?: Placement
  className?: string
  menuClassName?: string
}

/** A select in the app's own menu style, in place of the OS dropdown. */
export function Dropdown<T extends string>({ value, options, onChange, label, disabled, placement = 'bottom-start', className, menuClassName }: DropdownProps<T>): ReactNode {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const selected = options.find((option) => option.value === value)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={selected?.title}
        onClick={() => setOpen((current) => !current)}
        className={cn('inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-elev px-2 text-[12px] text-fg transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-45', className)}
      >
        {selected?.icon && <span className="flex shrink-0 text-muted">{selected.icon}</span>}
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label}</span>
        <ChevronDown size={13} className="shrink-0 text-muted" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement={placement} className={cn('max-h-80 min-w-44 overflow-y-auto p-1', menuClassName)}>
        {options.map((option) => (
          <MenuItem key={option.value} icon={option.icon} label={option.label} hint={option.hint} selected={option.value === value} onClick={() => { setOpen(false); onChange(option.value) }} />
        ))}
      </Popover>
    </>
  )
}

export function MenuSeparator(): ReactNode {
  return <div className="my-1 h-px bg-line" />
}

/** A skill's small icon. With a brand color an SVG takes that color; a skill with no icon colors its fallback. */
export function SkillIcon({ icon, color, size, fallback }: { icon?: string; color?: string; size: number; fallback: ReactNode }): ReactNode {
  if (!icon) return <span className="inline-flex" style={{ color }}>{fallback}</span>
  if (!color || !icon.startsWith('data:image/svg')) return <img src={icon} alt="" width={size} height={size} className="shrink-0" draggable={false} />
  const mask = `url("${icon}") center / contain no-repeat`
  return <span aria-hidden="true" className="inline-block shrink-0" style={{ width: size, height: size, backgroundColor: color, mask, WebkitMask: mask }} />
}

interface ModalProps {
  onClose(): void
  children: ReactNode
  className?: string
}

export function Modal({ onClose, children, className }: ModalProps): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div
      className="fade-in no-drag fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={cn('pop-in max-h-full overflow-hidden rounded-2xl bg-bg shadow-pop', className)}>{children}</div>
    </div>,
    document.body
  )
}

export function CopyButton({ text, label = 'Copy', size = 13, className }: { text: string | (() => string); label?: string; size?: number; className?: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <IconButton
      label={copied ? 'Copied' : label}
      size="sm"
      className={className}
      onClick={(event) => {
        event.stopPropagation()
        void copyText(typeof text === 'function' ? text() : text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </IconButton>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): ReactNode {
  const { className, ...rest } = props
  return (
    <input
      spellCheck={false}
      autoComplete="off"
      className={cn(
        'h-7.5 w-full rounded-md border border-line-strong bg-inset px-2.5 text-[12.5px] text-fg placeholder:text-subtle focus:border-fg/40',
        className
      )}
      {...rest}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md'
}: {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange(value: T): void
  size?: 'sm' | 'md'
}): ReactNode {
  return (
    <div className={cn('inline-flex rounded-md bg-hover p-0.5', size === 'sm' ? 'text-[11.5px]' : 'text-[12px]')}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            'inline-flex items-center gap-1 rounded-[5px] transition-colors',
            size === 'sm' ? 'h-5 px-1.5' : 'h-6 px-2.5',
            value === option.value ? 'bg-elev text-fg shadow-[0_0_0_1px_var(--border)]' : 'text-muted hover:text-fg'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
