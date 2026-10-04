// [FEAT-179] Card — recipe source: `.card` / `.card:hover` in the ally-os
// admin stylesheet (hover is the amber edge + shadow-md through the motion
// scale's named duration). Ported verbatim from ally-os packages/ui (#129 slice 1).
import { createElement, type HTMLAttributes, type FormHTMLAttributes, type ReactElement } from "react";

import { cn } from "./lib/cn.ts";

export type CardProps = (
  | (HTMLAttributes<HTMLElement> & { as?: "div" | "section" | "article" | "dl" | "aside" })
  | (FormHTMLAttributes<HTMLFormElement> & { as: "form" })
) & { padding?: "default" | "none" | "sm" | "md" | "lg"; spacing?: "default" | "none"; elevation?: "default" | "subtle" };

export function Card({ as: Tag = "div", padding = "default", spacing = "default", elevation = "default", className, ...rest }: CardProps): ReactElement {
  return createElement(Tag, {
      "data-slot": "card",
      ...rest,
      className: cn(
        "rounded-card border border-line bg-panel " +
          "transition-[border-color,box-shadow] duration-[var(--dur)] ease-[var(--ease)] " +
          "hover:border-accent-soft hover:shadow-overlay",
        { default: "p-[var(--pad-card)]", none: "p-0", sm: "p-3", md: "p-4", lg: "p-6" }[padding],
        elevation === "subtle" ? "shadow-[var(--shadow-sm)]" : "shadow-card",
        spacing === "default" ? "mb-4" : "mb-0",
        className,
      ),
    });
}
