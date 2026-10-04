// [FEAT-179] Input — recipe source: the `.control` block in the ally-os admin
// stylesheet (size + hover/focus/disabled states; the focus ring is
// --focus-ring, hover deepens the border to the secondary ink). Ported verbatim
// from ally-os packages/ui (#129 slice 1).
import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "./lib/cn.ts";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, type = "text", ...rest }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        type === "checkbox" || type === "radio" ? "size-4 shrink-0 accent-brand cursor-pointer disabled:cursor-not-allowed focus-visible:outline-brand" : "rounded-control border border-line bg-card p-[var(--pad-control)] " +
          "font-sans text-ui leading-[var(--lh-ui)] tracking-normal normal-case text-ink " +
          "transition-[border-color,background-color] duration-[var(--dur)] ease-[var(--ease)] " +
          "hover:border-ink-soft focus:border-brand-2 focus:shadow-focus focus:outline-none " +
          "placeholder:text-ink-soft disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-soft",
        className,
      )}
      {...rest}
    />
  );
});
