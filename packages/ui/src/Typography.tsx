// [FEAT-179] Typography — recipe source: h1 / h2 / h3 / p / a globals in the
// ally-os admin stylesheet. Ported verbatim from ally-os packages/ui (#129 slice 1).
import type { HTMLAttributes } from "react";
import { cn } from "./lib/cn.ts";

export const headingStyles = {
  h1: "mt-0 mb-6 font-slab text-[length:var(--fs-h1)] leading-[var(--lh-h1)] font-semibold tracking-[var(--ls-display)] text-ink",
  h2: "mt-8 mb-3 font-slab text-[length:var(--fs-h2)] leading-[var(--lh-h2)] font-semibold tracking-[var(--ls-display)] text-ink",
  h3: "mt-6 mb-2 font-mono text-[length:var(--fs-eyebrow)] font-semibold tracking-[var(--ls-eyebrow)] uppercase text-ink-soft",
} as const;

export function Heading({ as: Tag = "h2", className, ...props }: HTMLAttributes<HTMLHeadingElement> & { as?: "h1" | "h2" | "h3" }) {
  return <Tag {...props} className={cn(headingStyles[Tag], className)} />;
}

export function Paragraph({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...props} className={cn("my-4", className)} />;
}

export const linkStyles = "text-link no-underline hover:text-link-hover hover:underline";
