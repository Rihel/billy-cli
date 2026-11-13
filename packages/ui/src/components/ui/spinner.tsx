import { cn } from '#lib/utils.ts'
import { Loader2Icon } from 'lucide-react'

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    // output 自带 status 角色；contents 不生成盒子，保持原有布局
    <output aria-label="Loading" className="contents">
      <Loader2Icon
        data-slot="spinner"
        aria-hidden
        className={cn('size-4 animate-spin', className)}
        {...props}
      />
    </output>
  )
}

export { Spinner }
