import { ChevronDown, Laptop, UserRound } from 'lucide-react'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { availableSubscriptions } from '@shared/catalog'
import { cn } from '../lib/utils'
import { useRunConfig, useStore } from '../store'
import { SUBSCRIPTION_LABELS } from './ModelPicker'
import { MenuItem, MenuSeparator, Popover, Spinner } from './ui'

export function SubscriptionPicker(): ReactNode {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const { subscription } = useRunConfig()
  const settings = useStore((s) => s.settings)
  const statuses = useStore((s) => s.accountStatuses)
  const loading = useStore((s) => s.accountsLoading)
  const models = useStore((s) => s.models)
  const pickSubscription = useStore((s) => s.pickSubscription)
  const refresh = useStore((s) => s.refreshAccounts)
  const subscriptions = availableSubscriptions(settings, statuses)
  const close = useCallback(() => setOpen(false), [])
  const Icon = subscription === 'Default' ? Laptop : UserRound

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label="Subscription"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose a subscription"
        onClick={() => {
          setOpen(!open)
          if (!open) void refresh()
        }}
        className={cn('flex h-7 min-w-0 max-w-[150px] items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg', open && 'bg-hover text-fg')}
      >
        <Icon size={13.5} className="shrink-0" />
        <span className="truncate">{subscription === 'Default' ? 'Local' : subscription ? SUBSCRIPTION_LABELS[subscription] : 'Subscription'}</span>
        <ChevronDown size={12} className={cn('picker-chevron shrink-0 opacity-60', open && 'rotate-180')} />
      </button>
      <Popover open={open} onClose={close} anchor={anchor} placement="top-start" className="w-[244px] p-1">
        <div className="flex h-7 items-center justify-between px-2 text-[11px] font-medium text-subtle">
          <span className={cn(loading && 'shimmer')}>Subscription</span>
          {loading && <Spinner size={11} />}
        </div>
        <div role="menu" aria-label="Subscriptions">
          {subscriptions.map((entry) => {
            const local = entry === 'Default'
            const hasModels = models.some((model) => model.enabled && model.subscription === entry)
            return (
              <div key={entry}>
                {!local && entry === subscriptions[1] && <MenuSeparator />}
                <MenuItem
                  icon={local ? <Laptop size={13.5} /> : <UserRound size={13.5} />}
                  label={local ? 'Local' : SUBSCRIPTION_LABELS[entry]}
                  selected={entry === subscription}
                  disabled={!hasModels}
                  onClick={() => {
                    pickSubscription(entry)
                    close()
                  }}
                />
              </div>
            )
          })}
        </div>
        {!loading && subscriptions.length === 1 && (
          <div className="border-t border-line px-2 pb-1.5 pt-2 text-[11.5px] leading-snug text-subtle">Signed-in AI accounts appear here.</div>
        )}
      </Popover>
    </>
  )
}
