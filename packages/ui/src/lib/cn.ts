// The one class-name composer — clsx, so a component can take conditional and
// caller-supplied classes and emit them all. Ported from ally-os packages/ui.
//
// Deliberately NOT `twMerge(clsx(inputs))`: tailwind-merge resolves conflicts
// from the DEFAULT Tailwind theme and cannot tell this package's custom `@theme`
// names apart (recipe `text-ui` is a font size, `text-ink` a colour — both
// `text-*`, so twMerge silently keeps only the last). The remedy is ordering plus
// the closed-vocabulary props (variant/size/shape) components take instead of
// free-form class overrides.
import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
