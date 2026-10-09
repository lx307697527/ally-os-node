import { useState } from 'react';
import ProductCard from './ProductCard.jsx';
import KindsPopup from './KindsPopup.jsx';
import { VARIETIES_BY_FORMAT } from '../data/productVarieties.js';

// [BUG-699] A card's kinds come from VARIETIES_BY_FORMAT, keyed by its title (or
// varietiesKey), and a card may have NO entry — the Tubs / Canisters / Jars card
// shipped with none [FEAT-721, 2026-09-24], and a format has no kinds to show
// until sourced ones are added. Such a card renders without a popup trigger instead of
// handing KindsPopup `undefined`, which threw on `.format` and blanked the whole
// page (no error boundary above it). An entry with an empty list counts as none
// too — a popup with no rows is not a list of kinds.
function kindsFor(product) {
  const entry = VARIETIES_BY_FORMAT[product.varietiesKey || product.title];
  return entry && entry.varieties?.length ? entry : null;
}

// [owner directive 2026-09-28, layout pass] The off-screen card-height probe is
// gone. It measured every card front and pinned all cards to the tallest one's
// explicit height, which the owner rejected — the shorter cards showed a band
// of empty space between the description and the bottom-pinned kinds link.
// Nothing needs that shared explicit height anymore: the kinds moved into
// KindsPopup (2026-09-20 directive), so there is no flip back-face to keep
// aligned, and the CSS grid row itself equalizes the five cards
// (align-items: stretch) while each card's content flows to its natural size
// — only the spec/kinds footer sits on the shared bottom edge, via
// .product-spec's margin-top:auto.
//
// One popup at a time; opening another card's popup swaps the content (the
// previous one's cleanup returns focus to its trigger before the new one takes
// focus, which keeps focus where the user last acted).
export default function ProductCardsGrid({ products }) {
  const [popup, setPopup] = useState(null); // { varieties, triggerRef } | null

  function handleOpenVarieties(product, triggerRef) {
    setPopup({ varieties: kindsFor(product), triggerRef });
  }

  return (
    <div className="product-cards-wrap">
      <div className="product-grid">
        {products.map((p) => (
          <ProductCard
            key={p.title}
            product={p}
            onOpenVarieties={kindsFor(p) ? handleOpenVarieties : undefined}
          />
        ))}
      </div>

      {popup && (
        <KindsPopup varieties={popup.varieties} triggerRef={popup.triggerRef} onClose={() => setPopup(null)} />
      )}
    </div>
  );
}
