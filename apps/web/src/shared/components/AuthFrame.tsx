// [FEAT-179 phase 4] Sign-in shares the former login recipe. Ported from
// ally-os apps/allyos AuthFrame.tsx (#129 slice 1).
import type { HTMLAttributes, LabelHTMLAttributes, ReactElement } from "react";
import { cn } from "@ally/ui";

// THE FRAME IS THE PAGE, not a box floating on one: an outer margin is not part
// of any box's painted background, so above and below the content the page
// would show the `<html>` element's navy through. That navy is deliberate — it
// is the fallback ground for browsers without `overscroll-behavior` — which is
// why the fix is here rather than in `index.html`: the signed-in shell
// (`ShellFrame`) already covers it the same way, by being full height with a
// ground of its own.
//
// `min-h-dvh`, not `min-h-screen`: `100vh` on a phone counts the area behind
// the address bar, which would leave a strip below the fold that nothing can
// scroll to. No inner `overflow` anywhere — a `flex-1` item keeps
// `min-height: auto`, so a card taller than the viewport grows this element
// past `min-h-dvh` and the PAGE scrolls, which cannot clip a centred child.
export function AuthFrame({ className, children, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div className={cn("flex min-h-dvh flex-col bg-page", className)} {...props}>
      {/* The mark and nothing else. No navigation: before sign-in the only
          sensible destination is this very page. Height, left padding, asset
          and alt text are the app bar's own — `ShellFrame.tsx`'s `ShellHeader`
          and `InternalShell.tsx`'s brand block — so the two bars cannot drift
          apart by accident. `bg-brand` and the app bar's
          `bg-[var(--surface-navy)]` are both aliases of `--ally-navy`. */}
      <div
        data-slot="auth-brand-bar"
        className="flex h-[var(--app-bar-h)] shrink-0 items-center bg-brand p-[var(--pad-brand)]"
      >
        <img className="block h-[var(--logo-height)] w-auto" src="/logo-white.png" alt="Ally Nutra" />
      </div>
      <div data-slot="auth-content" className="flex flex-1 items-center justify-center p-[var(--space-8)]">
        {/* `[&>*:last-child]:mb-0` earns its keep: `Card` carries `mb-4` by
            default, and `items-center` centres the MARGIN box — so a card with
            a bottom margin sits half that margin above true centre. */}
        <div className="w-full max-w-[var(--width-login)] [&>*:last-child]:mb-0">{children}</div>
      </div>
    </div>
  );
}

export function AuthLabel({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>): ReactElement {
  return <label className={cn("mt-4 mb-1 block font-mono text-xs font-semibold tracking-[var(--ls-meta)] text-ink-soft", className)} {...props} />;
}
