import { useEffect, useRef, useState } from 'react';
import { sx } from '../lib/styleString.js';

// Approved verbatim source: https://allynutra.com/work-with-us (2026-09-19).
// Issue #3865 requires this page to contain exactly these five entries and no
// locally invented FAQ claims.
const FAQ_ITEMS = [
  {
    question: "What's your minimum order value?",
    answer: "It's less about a unit count and more about order value. Typically $10k and up. Tell us your formula and format on the call and we'll tell you where your run lands.",
  },
  {
    question: 'How fast can you actually deliver?',
    answer: "Quotes usually come back within 1-3 days. Production takes 4-8 weeks, depending on raw material lead times, which we check before we give you a date. We'd rather give you the real date than the one you want to hear, and then hit it.",
  },
  {
    question: 'Do you help develop the formula and flavors?',
    answer: 'Yes. Simple formula development is usually included at no additional cost, while custom flavor development starts at $1,500. We’ll work with you to get the flavor right—and if we can’t deliver a result you’re happy with, we’ll refund the flavor development fee.',
  },
  {
    question: 'Can you ship directly to Amazon FBA?',
    answer: 'Yes. We can help you label and prep to FBA requirements, then ship into the fulfillment center. You can also have it sent to your own warehouse or 3PL.',
  },
  {
    question: 'Do you handle labels and packaging design?',
    answer: "We design packaging in house and make sure label copy meets FDA requirements for dietary supplements. If you already have a designer, we'll work from their files.",
  },
];

function AccordionItem({ index, question, answer }) {
  const [open, setOpen] = useState(true);
  const [openHeight, setOpenHeight] = useState(0);
  const panelRef = useRef(null);

  useEffect(() => {
    if (panelRef.current) setOpenHeight(panelRef.current.scrollHeight + 20);
  }, []);

  function toggle() {
    if (!open && panelRef.current) setOpenHeight(panelRef.current.scrollHeight + 20);
    setOpen((value) => !value);
  }

  return (
    <div className="accordion-item" data-open={open ? 'true' : 'false'}>
      <button
        className="accordion-trigger"
        aria-expanded={open}
        aria-controls={`faq-panel-${index}`}
        id={`faq-trigger-${index}`}
        onClick={toggle}
      >
        <span className="q-mark">Q.{String(index + 1).padStart(2, '0')}</span>
        <span className="q-text">{question}</span>
        <span className="accordion-icon" aria-hidden="true"></span>
      </button>
      <div
        className="accordion-panel"
        id={`faq-panel-${index}`}
        role="region"
        aria-labelledby={`faq-trigger-${index}`}
        aria-hidden={!open}
        ref={panelRef}
        style={{ maxHeight: open ? `${openHeight}px` : '0px' }}
      >
        <div className="accordion-panel-inner">
          <p>{answer}</p>
        </div>
      </div>
    </div>
  );
}

export default function Faq() {
  return (
    <section aria-labelledby="faq-h1">
      <section className="hero on-navy" style={sx('padding-bottom:56px;')}>
        <div className="container" style={sx('max-width:720px;text-align:center;')}>
          <span className="eyebrow on-dark" style={sx('justify-content:center;')}>Frequently asked questions</span>
          <h1 id="faq-h1" style={sx('color:#fff;margin:14px 0 16px;')}>Questions we get often</h1>
        </div>
      </section>

      <section className="section">
        <div className="container" style={sx('max-width:820px;')}>
          {FAQ_ITEMS.map((item, index) => (
            <AccordionItem
              key={item.question}
              index={index}
              question={item.question}
              answer={item.answer}
            />
          ))}
        </div>
      </section>
    </section>
  );
}
