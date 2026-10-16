import { cn } from "@/lib/utils"

/** Pen marker: filled when Online, a lifted (hollow) pen when Offline. */
export function PenMark({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full",
        online ? "bg-online" : "border-[1.5px] border-muted-foreground",
        className
      )}
    />
  )
}
