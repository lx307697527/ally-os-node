// The source file relies on plain <a href="#section-id"> same-page anchors plus
// `html{scroll-behavior:smooth}` for in-page jumps (e.g. "Explore the facility" ->
// #facility-areas). Under HashRouter the URL hash IS the route, so letting a plain
// href="#id" click through would make the router treat "id" as a path and navigate
// away instead of scrolling. This handler preventDefaults the click and scrolls
// manually, reproducing the original smooth-scroll behavior without touching the route.
export function scrollToId(id) {
  return (e) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}
