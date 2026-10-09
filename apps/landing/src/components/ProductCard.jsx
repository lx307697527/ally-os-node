import { useRef } from 'react';
import { hideAndTint } from '../lib/imgFallback.js';

// [owner directive 2026-09-20] The flip is gone: clicking the card opens the kinds
// popup directly (KindsPopup.jsx) instead of flipping to a back face. The front's
// wording, image, and "The kinds of …" chip are unchanged — only the interaction
// changed. The kinds content that lived on the back face moved into the popup
// verbatim (heading / intro / name / spec / note per kind); nothing was rewritten,
// removed, or added.
//
// Fronts keep their four format images (client clarification). The kinds list comes
// from productVarieties.js, whose every entry traces to the Phase 0 audit (see that
// file's header).
//
// [BUG-699] `onOpenVarieties` is absent for a card with no kinds to show (see
// ProductCardsGrid's kindsFor). Such a card is a plain, non-interactive face: no
// button, no "The kinds of …" chip, no popup — it never promises a list it cannot
// open.
//
// [owner directive 2026-09-28, layout pass] No cardHeight prop anymore — the
// grid row stretches the cards to one height and the content inside flows to
// its natural size (see ProductCardsGrid's header comment).
export default function ProductCard({ product, onOpenVarieties }) {
  const frontRef = useRef(null);
  const hasKinds = typeof onOpenVarieties === 'function';
  const Face = hasKinds ? 'button' : 'div';
  const faceProps = hasKinds
    ? {
        type: 'button',
        ref: frontRef,
        'aria-haspopup': 'dialog',
        'aria-label': `${product.title} — show the kinds`,
        onClick: () => onOpenVarieties(product, frontRef),
      }
    : {};

  return (
    <div className="product-card">
      <div className="card-inner">
        <Face {...faceProps} className={`card-face card-front${hasKinds ? '' : ' card-front-static'}`}>
          <div className={`card-front-photo${product.photoSquare ? ' square' : ''}`}>
            <img
              src={product.img}
              width="900"
              height="675"
              alt={product.alt}
              loading="lazy"
              onError={hideAndTint}
              style={product.imageScale ? { '--card-photo-scale': product.imageScale } : undefined}
            />
          </div>
          <div className="product-body">
            <span className="product-format">{product.format}</span>
            <h3>{product.title}</h3>
            <p className="product-desc">{product.desc}</p>
            <div className="product-spec">{product.spec}</div>
            {hasKinds && (
              <span className="flip-affordance mono-chip" aria-hidden="true">The kinds of {product.title.toLowerCase()} →</span>
            )}
          </div>
        </Face>
      </div>
    </div>
  );
}
