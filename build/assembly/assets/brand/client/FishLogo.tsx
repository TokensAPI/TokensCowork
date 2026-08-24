import type { IconProps } from './icons/props.ts'

/** Render the formal product Logo at the host-requested size. */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <img
      src="/tokensharness-logo.png"
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
