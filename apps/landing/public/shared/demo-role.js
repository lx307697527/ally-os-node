// ════════════════════════════════════════════════════════════════
// AN-DEMO role — shared by public/quote/index.html, public/client/index.html,
// public/schedule/index.html, and public/admin/index.html (feature/role-and-links,
// feature/admin-role; FEAT-060 p13 role-as-URL-path). Presentation-only: there
// is no auth, no account, no server.
//
// *** SECURITY NOTE — READ BEFORE REUSING ANY OF THIS ***
// Which surface renders is NOT access control. Fine for a demo/prototype; a
// serious vulnerability if this pattern (or this code) ever shipped to a real
// product.
//
// Source of truth: the URL path prefix this file was served under —
// `/visitor/…`, `/client/…`, `/admin/…` — and ONLY that. There is no toggle
// anymore: each of these four static files lives at one fixed path, so its
// role is fixed for the lifetime of the page (no runtime role change, hence
// no "an-role-change" event to dispatch). `getRole()` is kept as a stable,
// read-only API — public/client/index.html's admin-menu-item gate reads it —
// rather than removed, so that gate degrades correctly (this file always
// loads at /client/, so it now always reads 'client', and the admin item
// simply never appears there, matching the fact that admin has its own
// separate page at /admin/ and no toggle exists to reach it from here).
// ════════════════════════════════════════════════════════════════
(function () {
  var VALID = { visitor: true, client: true, admin: true };

  function currentRole() {
    var segments = window.location.pathname.split('/').filter(Boolean);
    var first = segments[0];
    return VALID[first] ? first : 'visitor';
  }

  window.ANDemo = { getRole: currentRole };
})();
