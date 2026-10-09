import { Link } from 'react-router-dom';

// [FEAT-589 / #3902] /terms-of-service, served by this app at its own address.
//
// THE TEXT IS A VERBATIM COPY of the portal's `apps/portal/app/terms-of-service/
// page.tsx`, itself a verbatim port of the legacy site's
// `src/pages/TermsOfService.tsx` (FEAT-499 / #3334, "Last updated: June 20,
// 2026"): twenty-three numbered sections in the same order with the same
// wording, plus the unnumbered cross-reference that closes the page. Not a
// rewrite and not an update — the reasons are argued once in
// ./PrivacyPolicy.jsx (three live copies of one document, the date moves with
// the text, the portal's copy is the registered one and stays untouched) and
// are not repeated here.
//
// The three cross-references to the privacy page (sections 10, 22 and the
// closing paragraph) are in-app `Link`s, so the role prefix survives them.

/** The date the copied text carries — see ./PrivacyPolicy.jsx. */
export const LAST_UPDATED = 'September 28, 2026';

export default function TermsOfService() {
  return (
    <section className="legal" aria-labelledby="terms-h1" data-testid="terms-of-service">
      <section className="hero on-navy legal-hero">
        <div className="container">
          <h1 id="terms-h1">Terms of Service</h1>
          <p className="legal-updated">Last updated: {LAST_UPDATED}</p>
        </div>
      </section>

      <section className="section legal-body">
        <div className="container">
          <section className="legal-section">
            <h2>1. Acceptance of Terms</h2>
            <p>
              By accessing or using the website, services, or any associated content
              of Ally Nutra ("Company," "we," "our," or "us"), including our website
              at allynutra.com and our supplement manufacturing services, you agree
              to be bound by these Terms of Service ("Terms"). These Terms apply to
              all visitors, users, and customers of our website and services. If you
              do not agree to these Terms, please do not use our website or
              services.
            </p>
            <p>
              These Terms constitute a legally binding agreement between you and
              Ally Nutra. We reserve the right to modify these Terms at any time,
              and such modifications will be effective immediately upon posting.
              Your continued use of our website or services after any changes
              constitutes your acceptance of the revised Terms. We encourage you to
              review these Terms periodically.
            </p>
          </section>

          <section className="legal-section">
            <h2>2. Website Use Terms</h2>

            <h3>Acceptable Use</h3>
            <p>
              You agree to use our website only for lawful purposes and in a manner
              that does not infringe upon or restrict the use and enjoyment of the
              site by any third party.
            </p>

            <h3>Prohibited Activities</h3>
            <p>
              You agree not to:
            </p>
            <ul className="legal-list">
              <li>
                Use automated tools, bots, scrapers, or other means to access,
                collect data from, or interact with our website without our prior
                written consent
              </li>
              <li>
                Attempt to reverse engineer, decompile, or disassemble any software
                or technology used on our website
              </li>
              <li>
                Upload, transmit, or distribute any viruses, malware, or other
                harmful code
              </li>
              <li>
                Interfere with or disrupt the operation, security, or performance of
                our website or servers
              </li>
              <li>
                Impersonate any person or entity, or misrepresent your affiliation
                with any person or entity
              </li>
              <li>
                Use our website to engage in any illegal, fraudulent, or deceptive
                activity
              </li>
              <li>
                Circumvent, disable, or otherwise interfere with any
                security-related features of our website
              </li>
            </ul>

            <h3>Account Security</h3>
            <p>
              If you create an account on our website, you are responsible for
              maintaining the confidentiality of your login credentials and for all
              activities that occur under your account. You agree to notify us
              immediately of any unauthorized use of your account. We reserve the
              right to suspend or terminate accounts that we believe have been
              compromised or are being used in violation of these Terms.
            </p>

            <h3>Age Requirement</h3>
            <p>
              You must be at least 18 years of age to use our website and services.
              By using our website, you represent and warrant that you are at least
              18 years old.
            </p>
          </section>

          <section className="legal-section">
            <h2>3. Services Description</h2>
            <p>
              Ally Nutra provides supplement manufacturing, packaging, and related
              services for dietary supplements. Our services include but are not
              limited to:
            </p>
            <ul className="legal-list">
              <li>Custom capsule filling and encapsulation</li>
              <li>Powder blending and formulation assistance</li>
              <li>Packaging and labeling services</li>
              <li>Amazon FBA preparation</li>
              <li>Quality control and testing coordination</li>
              <li>Regulatory compliance guidance</li>
            </ul>
          </section>

          <section className="legal-section">
            <h2>4. Customer Responsibilities</h2>
            <p>
              As a customer of Ally Nutra, you agree to:
            </p>
            <ul className="legal-list">
              <li>
                Provide accurate and complete information regarding your product
                formulations, ingredients, and specifications
              </li>
              <li>
                Ensure all ingredients and materials you provide comply with
                applicable FDA regulations and are safe for intended use
              </li>
              <li>
                Obtain all necessary licenses, permits, and certifications required
                to sell your products
              </li>
              <li>
                Verify that your product labels comply with FDA labeling
                requirements for dietary supplements
              </li>
              <li>
                Maintain adequate product liability insurance for your finished
                products
              </li>
              <li>
                Respond promptly to requests for information or approvals during the
                manufacturing process
              </li>
            </ul>
          </section>

          <section className="legal-section">
            <h2>5. Regulatory Compliance</h2>
            <p>
              Ally Nutra operates in accordance with Current Good Manufacturing
              Practices (cGMP) as required by 21 CFR Part 111 for dietary
              supplements. However, we are not responsible for:
            </p>
            <ul className="legal-list">
              <li>
                The regulatory status or safety of ingredients provided by customers
              </li>
              <li>Claims made on customer product labels or marketing materials</li>
              <li>
                Ensuring customer products meet all applicable regulations in their
                intended markets
              </li>
              <li>Obtaining FDA approval or registration for customer products</li>
            </ul>
            <p>
              Customers are solely responsible for ensuring their products and
              product claims comply with all applicable federal, state, and local
              regulations.
            </p>
          </section>

          <section className="legal-section">
            <h2>6. Quotes, Orders, and Payment</h2>

            <h3>Quotes</h3>
            <p>
              All quotes provided by Ally Nutra are estimates based on information
              provided at the time of the quote request. Final pricing may vary
              based on actual ingredient costs, production requirements, and order
              specifications. Quotes are valid for 30 days unless otherwise
              specified.
            </p>

            <h3>Orders and Deposits</h3>
            <p>
              Orders are confirmed upon receipt of a signed production agreement and
              the required deposit. A minimum deposit of 50% is required to begin
              production on most orders. The remaining balance is due prior to
              shipment.
            </p>

            <h3>Payment Terms</h3>
            <p>
              Payment is accepted via wire transfer, ACH, or major credit cards.
              Late payments may incur interest charges of 1.5% per month on unpaid
              balances. We reserve the right to hold or cancel orders with
              outstanding balances.
            </p>
          </section>

          <section className="legal-section">
            <h2>7. Production and Delivery</h2>
            <p>
              Production timelines are estimates and may be affected by factors
              including ingredient availability, production schedules, and order
              complexity. We will communicate any significant delays as soon as they
              are known.
            </p>
            <p>
              Risk of loss and title to products passes to the customer upon
              delivery to the shipping carrier. Customers are responsible for
              providing accurate shipping information and for any additional charges
              resulting from address corrections or redelivery attempts.
            </p>
          </section>

          <section className="legal-section">
            <h2>8. Quality and Acceptance</h2>
            <p>
              All products are manufactured according to approved specifications and
              undergo quality control testing. Customers must inspect products upon
              receipt and report any defects or discrepancies within 10 business
              days of delivery.
            </p>
            <p>
              Claims for defective products must be accompanied by supporting
              documentation and samples for our review. We will work in good faith
              to resolve quality issues, which may include replacement, rework, or
              credit at our discretion.
            </p>
          </section>

          <section className="legal-section">
            <h2>9. Refund and Returns Policy</h2>
            <p>
              Due to the custom nature of our manufacturing services, the following
              refund and return terms apply:
            </p>
            <ul className="legal-list">
              <li>
                <strong>Custom Products:</strong> Custom manufactured products are
                non-refundable unless determined to be defective per Section 8
                (Quality and Acceptance).
              </li>
              <li>
                <strong>Deposits:</strong> Deposits are non-refundable once
                production has commenced, as materials may have already been
                procured and production resources allocated.
              </li>
              <li>
                <strong>Cancellation Before Production:</strong> If you cancel an
                order before production begins, your deposit may be refunded minus
                an administrative fee to cover planning and sourcing costs already
                incurred.
              </li>
              <li>
                <strong>Defective Products:</strong> Claims for defective products
                must be filed within 10 business days of delivery. Resolution is at
                our discretion and may include replacement, rework, or credit.
              </li>
            </ul>
          </section>

          <section className="legal-section">
            <h2>10. SMS/Text Messaging Terms</h2>
            <p>
              By opting in to the Ally Nutra Appointment Notifications program (for
              example, by checking the SMS consent box on our booking or quote
              forms), you agree to the following:
            </p>
            <ul className="legal-list">
              <li>
                Program: The Ally Nutra Appointment Notifications program sends
                transactional text messages about your appointments and account.
              </li>
              <li>
                You consent to receive transactional text messages from Ally Nutra
                related to your appointments and account — such as booking
                confirmations and reminders — at the phone number you provided.
              </li>
              <li>
                Consent to receive text messages is not a condition of purchasing
                any goods or services.
              </li>
              <li>Message frequency varies.</li>
              <li>
                Standard message and data rates may apply. Contact your wireless
                carrier for details.
              </li>
              <li>
                To opt out, reply <strong>STOP</strong> to any message. To get help,
                reply <strong>HELP</strong> or contact us at support@allynutra.com.
              </li>
              <li>
                Wireless carriers are not liable for delayed or undelivered
                messages.
              </li>
            </ul>
            <p>
              <strong>SMS / Text Messaging Consent and Data Sharing.</strong> Mobile
              opt-in information, phone numbers collected for SMS, and SMS consent
              are never shared with, sold to, rented to, or transferred to any third
              parties or affiliates for any purpose, including marketing,
              promotional, or lead-generation purposes. This provision applies
              notwithstanding any other data-sharing or disclosure terms described
              elsewhere in these Terms or our Privacy Policy. Consent to receive SMS
              is given directly to Ally Nutra LLC and is used solely to deliver the
              messages described in our messaging program.
            </p>
            <p>
              For more information about how we handle your phone number and
              messaging data, please see our{' '}
              <Link to="/privacy-policy" className="legal-link">
                Privacy Policy
              </Link>
              .
            </p>
          </section>

          <section className="legal-section">
            <h2>11. AI-Powered Chat Widget</h2>
            <p>
              Our website features an AI-powered chat widget to help answer your
              questions. By using the chat widget, you acknowledge and agree that:
            </p>
            <ul className="legal-list">
              <li>
                Chat responses are generated by an artificial intelligence system
                and are provided for informational purposes only.
              </li>
              <li>
                AI-generated responses do not constitute professional, legal,
                medical, regulatory, or manufacturing advice. You should
                independently verify all information provided.
              </li>
              <li>
                Your chat messages are stored on our servers (including message
                content, timestamps, and session identifiers) for quality assurance
                and service improvement purposes.
              </li>
              <li>
                The chat widget uses bot protection to prevent abuse.
              </li>
              <li>
                Ally Nutra may review chat logs to improve service quality and the
                accuracy of AI responses.
              </li>
            </ul>
          </section>

          <section className="legal-section">
            <h2>12. User-Generated Content</h2>
            <p>
              When you submit content through our website (including chat messages,
              form submissions, and any other information you provide), you:
            </p>
            <ul className="legal-list">
              <li>
                Grant Ally Nutra a non-exclusive, royalty-free license to use,
                store, and process the submitted content for the purpose of
                delivering our services and improving our website.
              </li>
              <li>
                Represent that the content does not violate any applicable laws,
                infringe upon the rights of any third party, or contain defamatory,
                obscene, or otherwise objectionable material.
              </li>
              <li>
                Acknowledge that Ally Nutra may delete user-generated content at any
                time without prior notice.
              </li>
            </ul>
          </section>

          <section className="legal-section">
            <h2>13. Electronic Communications Consent</h2>
            <p>
              By using our website, creating an account, or submitting forms, you
              consent to receive electronic communications from Ally Nutra,
              including:
            </p>
            <ul className="legal-list">
              <li>
                Transactional emails (quote confirmations, order updates,
                appointment reminders)
              </li>
              <li>
                Marketing emails and newsletters (with your consent, and with the
                ability to unsubscribe at any time)
              </li>
              <li>SMS/MMS messages (with your express consent per Section 10)</li>
              <li>In-app notifications and chat messages</li>
            </ul>
            <p>
              You agree that electronic communications satisfy any legal requirement
              that such communications be in writing.
            </p>
          </section>

          <section className="legal-section">
            <h2>14. Intellectual Property</h2>
            <p>
              Customers retain all rights to their formulations, trade secrets, and
              proprietary information. Ally Nutra agrees to maintain the
              confidentiality of customer formulations and business information.
            </p>
            <p>
              All content on the Ally Nutra website, including text, graphics,
              logos, and images, is the property of Ally Nutra and protected by
              copyright and trademark laws. Unauthorized use is prohibited.
            </p>
          </section>

          <section className="legal-section">
            <h2>15. Website Disclaimer</h2>
            <p>
              THE WEBSITE AND ALL CONTENT, FEATURES, AND FUNCTIONALITY ARE PROVIDED
              ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY KIND,
              EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED
              WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
              NON-INFRINGEMENT.
            </p>
            <p>
              Ally Nutra does not warrant that the website will be uninterrupted,
              error-free, or free of viruses or other harmful components. Content on
              this website, including information provided through our AI chat
              widget, is for general informational purposes only and does not
              constitute medical, legal, or regulatory advice. You should not rely
              on website content as a substitute for professional advice.
            </p>
          </section>

          <section className="legal-section">
            <h2>16. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, Ally Nutra's liability for any
              claims arising from our services shall not exceed the amount paid by
              the customer for the specific order giving rise to the claim.
            </p>
            <p>
              In no event shall Ally Nutra be liable for any indirect, incidental,
              special, consequential, or punitive damages, including loss of
              profits, revenue, or business opportunities, regardless of whether we
              were advised of the possibility of such damages.
            </p>
          </section>

          <section className="legal-section">
            <h2>17. Indemnification</h2>
            <p>
              You agree to indemnify, defend, and hold harmless Ally Nutra, its
              officers, directors, employees, and agents from any claims, damages,
              losses, or expenses (including reasonable attorneys' fees) arising
              from:
            </p>
            <ul className="legal-list">
              <li>Your use of our website or services</li>
              <li>Your violation of these Terms</li>
              <li>
                Your products, including any claims related to product safety,
                efficacy, or labeling
              </li>
              <li>Your violation of any applicable laws or regulations</li>
              <li>Any third-party claims related to your products</li>
              <li>Any content you submit through our website</li>
            </ul>
          </section>

          <section className="legal-section">
            <h2>18. Force Majeure</h2>
            <p>
              Ally Nutra shall not be liable for any failure or delay in performing
              our obligations due to circumstances beyond our reasonable control,
              including but not limited to acts of God, natural disasters,
              pandemics, government actions, supply chain disruptions, or labor
              disputes.
            </p>
          </section>

          <section className="legal-section">
            <h2>19. Termination</h2>
            <p>
              Either party may terminate the business relationship at any time by
              providing written notice. Upon termination, all outstanding invoices
              become immediately due and payable. Cancellation of orders in progress
              may be subject to cancellation fees to cover materials and production
              costs incurred.
            </p>
            <p>
              We reserve the right to suspend or terminate your access to our
              website and services at any time, without notice, for conduct that we
              believe violates these Terms or is harmful to other users, us, or
              third parties.
            </p>
          </section>

          <section className="legal-section">
            <h2>20. Governing Law and Dispute Resolution</h2>
            <p>
              These Terms shall be governed by and construed in accordance with the
              laws of the State of Delaware, without regard to its conflict of law
              provisions. Any disputes arising from these Terms or our services
              shall be resolved through binding arbitration in Dover, Delaware, in
              accordance with the rules of the American Arbitration Association.
            </p>
          </section>

          <section className="legal-section">
            <h2>21. Severability</h2>
            <p>
              If any provision of these Terms is found to be unenforceable or
              invalid, that provision shall be limited or eliminated to the minimum
              extent necessary, and the remaining provisions shall remain in full
              force and effect.
            </p>
          </section>

          <section className="legal-section">
            <h2>22. Entire Agreement</h2>
            <p>
              These Terms, together with our{' '}
              <Link to="/privacy-policy" className="legal-link">
                Privacy Policy
              </Link>{' '}
              and any production agreements and order confirmations, constitute the
              entire agreement between you and Ally Nutra regarding our website and
              services and supersede all prior agreements and understandings.
            </p>
          </section>

          <section className="legal-section">
            <h2>23. Contact Information</h2>
            <p>
              If you have any questions about these Terms of Service, please contact
              us at:
            </p>
            <div className="legal-contact">
              <p className="legal-contact-name">Ally Nutra</p>
              <p>
                631 Ridgely St, STE 1
                <br />
                Dover, DE 19904
              </p>
              <p>Email: support@allynutra.com</p>
              <p>Phone: (888) 720-5888</p>
            </div>
          </section>

          <section className="legal-section legal-see-also">
            <p>
              See also our{' '}
              <Link to="/privacy-policy" className="legal-link">
                Privacy Policy
              </Link>{' '}
              for information about how we collect, use, and protect your personal
              information.
            </p>
          </section>
        </div>
      </section>
    </section>
  );
}
