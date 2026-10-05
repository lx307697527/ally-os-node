// The barrel — what the package exports today. CSS entries are imported by name
// (`@ally/ui/tokens.css` / `theme.css`), not from here: a JS entry that pulled
// CSS would drag it into every consumer's bundle whether their Tailwind build
// knows about it or not.
//
// This is the slice-1 subset of ally-os packages/ui: the components the sign-in
// surface and the internal shell consume. The rest of the library (Select,
// Dialog/ModalFrame, DenseTable, Toast, …) ports with the pages that need it —
// the token layer below them is already complete, so later components render
// identically the day they land.
export { Button, type ButtonProps, type ButtonShape, type ButtonSize, type ButtonVariant } from "./Button.tsx";
export { Card, type CardProps } from "./Card.tsx";
export { Input, type InputProps } from "./Input.tsx";
// The Menu family. `POPUP_SURFACE` / `POPUP_ROW` stay unexported on purpose:
// they are the ruling's recipe, and a call site that could paste them somewhere
// else would be a second dropdown.
export {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  POPUP_LAYER,
  type MenuAlign,
  type MenuSize,
  type MenuProps,
  type MenuTriggerProps,
  type MenuPopupProps,
  type MenuGroupLabelProps,
  type MenuItemProps,
} from "./Menu.tsx";
export { Heading, Paragraph, linkStyles } from "./Typography.tsx";
// The Toast family — brand notice only for now; `card`/`slide` (FEAT-638) port
// with the bell's popup slice (see Toast.tsx header).
export {
  Toast,
  ToastViewport,
  TOAST_ENTER_MS,
  TOAST_LEAVE_MS,
  type ToastAction,
  type ToastPosition,
  type ToastProps,
  type ToastViewportProps,
} from "./Toast.tsx";
export { cn } from "./lib/cn.ts";
