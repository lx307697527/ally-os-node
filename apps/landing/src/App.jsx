import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Header from './components/Header.jsx';
import Footer from './components/Footer.jsx';
import { DemoRoleProvider } from './contexts/DemoRoleContext.jsx';
import Home from './views/Home.jsx';
import Services from './views/Services.jsx';
import ContractManufacturing from './views/ContractManufacturing.jsx';
import PrivateLabel from './views/PrivateLabel.jsx';
import CapsuleManufacturing from './views/CapsuleManufacturing.jsx';
import VitaminManufacturing from './views/VitaminManufacturing.jsx';
import StickPackManufacturing from './views/StickPackManufacturing.jsx';
import Facility from './views/Facility.jsx';
import Certifications from './views/Certifications.jsx';
import About from './views/About.jsx';
import Faq from './views/Faq.jsx';
// [#3556] Ad landing page. Deliberately absent from Header/Footer navigation.
import WorkWithUs from './views/WorkWithUs.jsx';
// [FEAT-839] Page B of the /work-with-us A/B test. Not in the nav, noindex.
import WorkWithUsB from './views/WorkWithUsB.jsx';
import ThankYouBooked from './views/ThankYouBooked.jsx';
import Contact from './views/Contact.jsx';
// [FEAT-589 / #3902] The two legal pages, served here rather than redirected
// to the portal's copies. The text is the portal's, verbatim — see either view.
import PrivacyPolicy from './views/PrivacyPolicy.jsx';
import TermsOfService from './views/TermsOfService.jsx';
import { readRoleBasename } from './lib/demoRole.js';
import { TITLES, CHROMELESS_KEYS, NOINDEX_KEYS, canonicalUrl, pageKeyFromPathname } from './lib/pages.js';

// #45 slice 1: the old repo mounted three more things inside this tree, all
// cut here because their backends do not exist in the new system yet:
//   * ChatWidget (the AI assistant) — #48 rebuilds it against the new API;
//   * useVisitorTracking / useTouchpointCapture (Supabase-RPC beacons) — #49
//     owns visitor tracking and will design it against the new stack.
// The SEO side-effects below (title / canonical / noindex / scroll) are the
// load-bearing part of this Layout and are ported verbatim.

// Canonical header/footer layout wrapping every page-view, mirroring the source
// file's single <header>/<main>/<footer> shell that the old hash-router toggled
// section[data-page] visibility inside of. react-router now owns which view renders
// (via <Outlet/>), so this layout only needs to reproduce the two side-effects the
// old router's activate()/goToPage() used to run on every navigation: scroll to top,
// and set document.title from the same TITLES map.
//
// [FEAT-589 / #3902] One page renders WITHOUT the site Header and Footer:
// `/work-with-us`, the ad landing page, which the legacy standalone page served
// with no navigation at all and a three-item footer of its own (the view renders
// that footer itself). It stays UNDER this Layout rather than getting a sibling
// route, because the three side-effects here must keep running for it and the
// navigation side-effects must mount exactly once per visit: a second route
// element would be a second mount. So the chrome is a branch on the page key,
// not a second layout.
function Layout() {
  const location = useLocation();
  const chromeless = CHROMELESS_KEYS.has(pageKeyFromPathname(location.pathname));

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  useEffect(() => {
    const key = pageKeyFromPathname(location.pathname);
    document.title = TITLES[key] || 'Ally Nutra';
    // [FEAT-672 / #4535] One canonical link, kept in step with the route the
    // same way the title is. Reused rather than appended per navigation, and
    // removed on a path that is not a page, so the head never carries two.
    const href = canonicalUrl(key);
    let link = document.head.querySelector('link[rel="canonical"]');
    if (href === null) {
      link?.remove();
    } else {
      if (link === null) {
        link = document.createElement('link');
        link.setAttribute('rel', 'canonical');
        document.head.appendChild(link);
      }
      link.setAttribute('href', href);
    }
    // [FEAT-839] `noindex` for a page that must stay out of search (the A/B test's
    // page B). Same discipline as the canonical link: one tag, present only on the
    // pages that need it, and removed again on navigation away.
    let robots = document.head.querySelector('meta[name="robots"]');
    if (NOINDEX_KEYS.has(key)) {
      if (robots === null) {
        robots = document.createElement('meta');
        robots.setAttribute('name', 'robots');
        document.head.appendChild(robots);
      }
      robots.setAttribute('content', 'noindex');
    } else {
      robots?.remove();
    }
  }, [location.pathname]);

  return (
    <>
      {chromeless ? null : <Header />}
      <main>
        <Outlet />
      </main>
      {chromeless ? null : <Footer />}
    </>
  );
}

export default function App() {
  // [FEAT-586, issue #3873] The site routes on the real path now, so every page
  // has its own address (`/about`, not `/#/about`) — which is what lets a search
  // engine index them separately and stops an in-page `#anchor` from being read
  // as a route.
  //
  // `basename` is not optional here. The role prefix (`/visitor/...`) is a real
  // path segment, and without this the router would look `/visitor/about` up as
  // a route, match nothing, and fall through to `<Route path="*">` — the
  // homepage. Read at render time rather than at module load, because
  // `main.jsx` rewrites a legacy `#/` address just before the first render and
  // this must see the corrected path. See `readRoleBasename`'s own note for why
  // `readRoleFromLocation()` cannot answer this.
  return (
    <DemoRoleProvider>
      <BrowserRouter basename={readRoleBasename()}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="/home" element={<Home />} />
            <Route path="/services" element={<Services />} />
            {/* [#3556] Not in the nav: an ad destination, per Dasi 2026-08-08. */}
            <Route path="/work-with-us" element={<WorkWithUs />} />
            {/* [FEAT-839] A/B test page B — not in the nav, noindex, not in the sitemap. */}
            <Route path="/work-with-us-b" element={<WorkWithUsB />} />
            <Route path="/thank-you-booked" element={<ThankYouBooked />} />
            <Route path="/contract-manufacturing" element={<ContractManufacturing />} />
            <Route path="/private-label" element={<PrivateLabel />} />
            <Route path="/capsule-manufacturing" element={<CapsuleManufacturing />} />
            <Route path="/vitamin-manufacturing" element={<VitaminManufacturing />} />
            <Route path="/stick-pack-manufacturing" element={<StickPackManufacturing />} />
            <Route path="/facility" element={<Facility />} />
            <Route path="/certifications" element={<Certifications />} />
            <Route path="/about" element={<About />} />
            <Route path="/faq" element={<Faq />} />
            <Route path="/contact" element={<Contact />} />
            {/* [FEAT-589 / #3902] Legal pages. Site header and footer like any
                other content page; linked from the ad page's minimal footer. */}
            <Route path="/privacy-policy" element={<PrivacyPolicy />} />
            <Route path="/terms-of-service" element={<TermsOfService />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </DemoRoleProvider>
  );
}
