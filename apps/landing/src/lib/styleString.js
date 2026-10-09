// Ported inline `style="prop:value;prop2:value2;"` strings from the original static
// HTML are parsed into React style objects at render time via sx(), instead of being
// hand-transcribed into camelCase object literals one property at a time. The source
// file has hundreds of inline styles; parsing the original CSS-declaration text
// verbatim (copy-pasted as a JS string) removes the main source of transcription
// error a manual property-by-property port would introduce. Values here never
// contain a colon (no url()/time literals), so a naive split on ':' is safe.
export function sx(str) {
  if (!str) return undefined;
  const out = {};
  str.split(';').forEach((decl) => {
    const trimmed = decl.trim();
    if (!trimmed) return;
    const idx = trimmed.indexOf(':');
    if (idx === -1) return;
    const prop = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!prop || !value) return;
    const camel = prop.startsWith('--')
      ? prop
      : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = value;
  });
  return out;
}
