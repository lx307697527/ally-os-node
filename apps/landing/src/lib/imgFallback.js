// Mirrors the source file's two inline onerror="" variants used across every content
// <img>: most hide the broken image AND tint the parent to the navy fallback color;
// a handful (certifications lab photos, the facility clean-room photo) only hide the
// image without tinting the parent. Kept as two named handlers so each <img> can use
// the exact same behavior it had in the static markup.
export function hideAndTint(e) {
  e.currentTarget.style.display = 'none';
  if (e.currentTarget.parentElement) {
    e.currentTarget.parentElement.style.background = '#1E3A5F';
  }
}

export function hideOnly(e) {
  e.currentTarget.style.display = 'none';
}
