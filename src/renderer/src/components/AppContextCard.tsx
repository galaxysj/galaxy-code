import { AppWindow, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Attachment } from '@shared/types'
import { cn } from '../lib/utils'

/** One App Context capture: the window washed out behind the app's icon and name. */
export function AppContextCard({ file, small, onOpen, onRemove }: { file: Attachment; small?: boolean; onOpen(file: Attachment): void; onRemove?(): void }): ReactNode {
  const context = file.appContext
  return (
    <div className="group/att relative shrink-0">
      <button
        type="button"
        onClick={() => onOpen(file)}
        title={`Preview ${context?.app}`}
        className={cn('relative block overflow-hidden rounded-2xl border border-line bg-inset', small ? 'h-[108px] w-[144px]' : 'h-[132px] w-[176px]')}
      >
        {file.preview && <img src={file.preview} alt="" draggable={false} className="absolute inset-0 h-full w-full object-contain" />}
        <span className="absolute inset-0 bg-elev opacity-60" />
        <span className="relative flex h-full w-full flex-col items-center justify-center gap-1.5 px-2">
          {context?.icon ? <img src={context.icon} alt="" width={small ? 34 : 42} height={small ? 34 : 42} draggable={false} className="max-w-none drop-shadow" /> : <AppWindow size={small ? 26 : 30} className="text-muted" />}
          <span className={cn('max-w-full truncate font-medium text-fg', small ? 'text-[12px]' : 'text-[13px]')}>{context?.app}</span>
        </span>
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} title="Remove" className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-fg text-bg opacity-0 transition-opacity group-hover/att:opacity-100">
          <X size={11} strokeWidth={3} />
        </button>
      )}
    </div>
  )
}
