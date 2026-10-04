// [FEAT-432 / #2902] Button — recipe source: the Quote Builder 2 button recipe,
// ruled the system's button on 2026-09-12. Ported verbatim from ally-os
// packages/ui (#129 slice 1), minus the faces/sizes this repo has no caller for
// yet — they return with the pages that call them.
//
// Every value rides the theme bridge (src/theme.css) or a var() arbitrary value;
// nothing here is a literal.
//
// SIZE IS A HEIGHT, NOT A PADDING. The three text sizes measure from
// `--height-control-*` — the same scale the inputs measure from, so a button
// beside a field is exactly as tall as the field. One weight per face, declared
// once: `cn` is clsx and resolves no conflict, so a `font-medium` in the base
// beside a `font-semibold` in a variant would emit BOTH and let stylesheet order
// pick the winner.
import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "./lib/cn.ts";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost" | "link";
export type ButtonSize = "default" | "sm" | "icon";
export type ButtonShape = "default" | "pill";

const base =
  "inline-flex items-center justify-center gap-1.75 cursor-pointer border " +
  "font-sans tracking-normal leading-none whitespace-nowrap " +
  "transition-[background-color,border-color,color,box-shadow] duration-[var(--dur)] ease-[var(--ease)] " +
  "disabled:cursor-not-allowed disabled:bg-muted disabled:border-line disabled:text-ink-soft disabled:shadow-none";

// `icon` carries `text-ui` explicitly because the base sets no type size.
const sizes: Record<ButtonSize, string> = {
  sm: "h-[var(--height-control-sm)] px-2.75 text-ui-sm",
  default: "h-[var(--height-control-md)] px-3.25 text-control",
  icon: "p-2! aspect-square text-ui",
};

const shapes: Record<ButtonShape, string> = {
  default: "rounded-control",
  pill: "rounded-pill",
};

const variants: Record<ButtonVariant, string> = {
  danger: "bg-err border-err text-on-brand font-medium hover:opacity-90",
  // `aria-pressed:` is the ghost face's toggled state — a STATE rather than a
  // second ground, so a tab-like toggle needs no classes of its own.
  ghost:
    "bg-transparent border-transparent text-ink font-medium hover:bg-muted aria-pressed:bg-muted aria-pressed:border-line",
  link: "bg-transparent border-transparent text-brand font-medium underline-offset-4 hover:underline",
  // The quiet face: white ground, hairline border, body ink, medium.
  default: "bg-card border-line text-[var(--text-body)] font-medium hover:bg-muted hover:border-ink-soft",
  // Navy fill — the CONTROL navy (`--control-navy`), not the chrome navy the top
  // bar paints with; the two were separated by BUG-247 so a filled button beside
  // the bar is not its exact twin.
  primary:
    "bg-control-navy border-control-navy text-on-brand font-semibold hover:bg-control-navy-hover hover:border-control-navy-hover",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
}

// forwardRef: a dialog focuses a control on mount, and a plain function
// component would swallow the ref under pre-19 React semantics.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", type = "button", size = "default", shape = "default", className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-slot="button"
      className={cn(base, shapes[shape], sizes[size], variants[variant], className)}
      {...rest}
    />
  );
});
