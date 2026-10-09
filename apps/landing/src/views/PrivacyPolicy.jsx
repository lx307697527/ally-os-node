import { Link } from 'react-router-dom';

// [FEAT-589 / #3902] /privacy-policy, served by this app at its own address.
//
// THE TEXT IS A VERBATIM COPY of the portal's `apps/portal/app/privacy-policy/
// page.tsx`, which is itself a verbatim port of the legacy site's
// `src/pages/PrivacyPolicy.tsx` (FEAT-499 / #3334, "Last updated: June 20,
// 2026"). Sixteen numbered sections, same order, same wording, same date, the
// same two different phone numbers — (888) 884-2550 in section 7, (888) 720-5888
// in sections 9 and 16 — and the same external link. Not a rewrite, not a
// summary, not re-dated.
//
// ⚠️ THIS DOCUMENT NOW LIVES IN THREE PLACES: the legacy site, the portal and
// here. A change to the policy is a change to all three, and the "Last updated"
// date moves with it. `src/views/__tests__/legal-pages.test.js` compares this
// page's headings and body text against the portal source, so a tidy here that
// is not also made there goes red rather than shipping two policies for one
// company.
//
// WHY IT IS HERE AT ALL. Until this change `vercel.json` redirected the path to
// the portal's copy; the ad landing page's minimal footer (WorkWithUs.jsx) links
// here, and a footer link that leaves the site for a different domain is not
// what the legacy page did. The portal's copy is untouched — it is the URL
// registered on Intuit's App Information form and keeps being that.
//
// Cross-references between the two legal pages are in-app `Link`s, so the role
// prefix (`/visitor/…`) survives them.

/** The date the copied text carries. Asserted by the unit test — a copy that
 *  silently re-dates itself is no longer the same document. */
export const LAST_UPDATED = 'June 20, 2026';

export default function PrivacyPolicy() {
  return (
    <section className="legal" aria-labelledby="privacy-h1" data-testid="privacy-policy">
      <section className="hero on-navy legal-hero">
        <div className="container">
          <h1 id="privacy-h1">Privacy Policy</h1>
          <p className="legal-updated">Last updated: {LAST_UPDATED}</p>
        </div>
      </section>

      <section className="section legal-body">
        <div className="container">
          <section className="legal-section">
            <h2>1. Introduction</h2>
            <p>
              Ally Nutra ("we," "our," or "us") is committed to protecting your
              privacy. This Privacy Policy explains how we collect, use, disclose,
              and safeguard your information when you visit our website
              allynutra.com, use our services, or interact with us in any way.
            </p>
            <p>
              By using our website or services, you agree to the collection and use
              of information in accordance with this policy. Please also review our{' '}
              <Link to="/terms-of-service" className="legal-link">
                Terms of Service
              </Link>
              , which govern your use of our website and services.
            </p>
          </section>

          <section className="legal-section">
            <h2>2. Information We Collect</h2>

            <h3>2a. Information You Provide Directly</h3>
            <p>
              We collect personal information that you voluntarily provide when you
              interact with our website and services, including:
            </p>
            <ul className="legal-list">
              <li>
                <strong>Quote Request Forms:</strong> Full name, email address,
                phone number, company name, website URL, product format (capsules,
                powder, sachets, stick packs, pouches), quantity, servings per
                container, budget range, production timeline, whether the product is
                already in production, and additional order details.
              </li>
              <li>
                <strong>Account Registration:</strong> Email address, password
                (securely hashed and stored), full name, phone number, and company
                name.
              </li>
              <li>
                <strong>Appointment Scheduling:</strong> Full name, email address,
                phone number, appointment type, preferred date/time, and any
                additional notes.
              </li>
              <li>
                <strong>Chat Widget:</strong> Message content you submit through our
                on-site chat feature, along with your session identifier and user ID
                (if logged in).
              </li>
              <li>
                <strong>Contact Forms:</strong> Name, email address, phone number,
                company name, and your message or inquiry.
              </li>
              <li>
                <strong>SMS Consent:</strong> When you opt in to receive text
                messages, we collect your phone number and record of your consent.
              </li>
            </ul>

            <h3>2b. Information Collected Automatically</h3>
            <p>
              When you visit our website, we automatically collect certain
              information through various technologies:
            </p>
            <ul className="legal-list">
              <li>
                <strong>Visitor Session Data:</strong> IP address, browser type and
                version (user agent), pages visited, referring URL, and timestamps.
                This data is stored in our database to help us understand traffic
                patterns.
              </li>
              <li>
                <strong>Interaction Event Data:</strong> Click positions (as
                percentages of page dimensions), scroll depth milestones, viewport
                dimensions, and identifiers of elements interacted with (tag name,
                ID, and CSS classes). Mouse movement data is sampled periodically.
                This data helps us understand how visitors navigate our site and
                improve the user experience.
              </li>
              <li>
                <strong>Product Analytics (PostHog):</strong> With your consent, we
                use PostHog to collect page views, form interactions, button clicks,
                exit intent signals (time on page, scroll depth), and web
                performance metrics (Largest Contentful Paint, Interaction to Next
                Paint, Cumulative Layout Shift, First Contentful Paint, and Time to
                First Byte).
              </li>
              <li>
                <strong>Error Monitoring:</strong> We capture JavaScript errors and
                navigation breadcrumbs to improve website reliability. Error reports
                include technical details about your browser and the actions leading
                up to the error. All form inputs and text content are masked in
                error reports. Error data is stored in our own infrastructure
                (Supabase) and retained for 90 days.
              </li>
              <li>
                <strong>Bot Protection (Google reCAPTCHA v3):</strong> Google
                reCAPTCHA collects hardware and software information, such as device
                and application data, to assess whether a visitor is a human or a
                bot. This data is sent to Google and processed in accordance with{' '}
                <a
                  href="https://policies.google.com/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="legal-link"
                >
                  Google's Privacy Policy
                </a>
                .
              </li>
              <li>
                <strong>Device Information:</strong> Device type (desktop, mobile,
                tablet), operating system, screen resolution, and browser version.
              </li>
            </ul>

            <h3>2c. Cookies and Local Storage</h3>
            <p>
              We use cookies and browser local storage to operate our website and
              provide our services. The specific items stored include:
            </p>
            <ul className="legal-list">
              <li>
                <strong>Essential:</strong> Supabase authentication tokens (for
                login sessions), chat session identifiers (expire after 24 hours,
                maximum 7-day retention), and your cookie consent preference.
              </li>
              <li>
                <strong>Analytics (with consent):</strong> PostHog session and
                identification cookies for linking your activity across pages, and
                an analytics session ID used to correlate analytics with error
                reports.
              </li>
              <li>
                <strong>Third-Party:</strong> Google reCAPTCHA cookies used to
                distinguish human visitors from bots.
              </li>
            </ul>
          </section>

          <section className="legal-section">
            <h2>3. How We Use Your Information</h2>
            <p>
              We use the information we collect for the following purposes:
            </p>
            <ul className="legal-list">
              <li>Process and respond to your quote requests and inquiries</li>
              <li>Provide and manage our supplement manufacturing services</li>
              <li>
                Communicate with you about your orders, appointments, and account
              </li>
              <li>
                Send SMS/MMS notifications related to your appointments and account
                (only with your express consent)
              </li>
              <li>Send promotional emails (only with your express consent)</li>
              <li>Provide responses through our AI-powered chat widget</li>
              <li>
                Analyze website usage patterns and interaction data to improve user
                experience
              </li>
              <li>
                Monitor and resolve errors and performance issues on our website
              </li>
              <li>
                Protect against bots, spam, fraud, and unauthorized activity
              </li>
              <li>
                Comply with legal obligations and enforce our Terms of Service
              </li>
            </ul>
          </section>

          <section className="legal-section">
            <h2>4. Information Sharing and Disclosure</h2>
            <p>
              We do not sell, trade, or rent your personal information to third
              parties. We share your information with the following service
              providers who assist us in operating our website and business:
            </p>
            <ul className="legal-list">
              <li>
                <strong>Supabase:</strong> Database hosting, authentication, and
                serverless functions for storing and managing your account data,
                quote requests, and other information.
              </li>
              <li>
                <strong>PostHog:</strong> Product analytics and session replay
                services (only with your consent). Data is processed per PostHog's
                privacy policy.
              </li>
              <li>
                <strong>Error Tracking:</strong> Custom error tracking stored in our
                own infrastructure to identify and fix website issues.
              </li>
              <li>
                <strong>Google:</strong> reCAPTCHA v3 for bot protection. Google
                receives device and behavioral data to assess bot risk.
              </li>
              <li>
                <strong>Vercel:</strong> Website hosting and content delivery.
              </li>
            </ul>
            <p>
              <strong>
                We do not share, sell, or transfer mobile phone numbers or SMS
                opt-in consent to third parties or affiliates for marketing or
                promotional purposes.
              </strong>{' '}
              The service providers listed above process data only to operate our
              website and services on our behalf; none receive your mobile number
              for their own marketing.
            </p>
            <p>
              <strong>SMS / Text Messaging Consent and Data Sharing.</strong> Mobile
              opt-in information, phone numbers collected for SMS, and SMS consent
              are never shared with, sold to, rented to, or transferred to any third
              parties or affiliates for any purpose, including marketing,
              promotional, or lead-generation purposes. This provision applies
              notwithstanding any other data-sharing or disclosure terms described
              elsewhere in this policy. Consent to receive SMS is given directly to
              Ally Nutra LLC and is used solely to deliver the messages described in
              our messaging program.
            </p>
            <p>
              We may also disclose your information in the following circumstances:
            </p>
            <ul className="legal-list">
              <li>
                <strong>Legal Requirements:</strong> When required by law, subpoena,
                or in response to valid requests by government authorities.
              </li>
              <li>
                <strong>Business Transfers:</strong> In the event of a merger,
                acquisition, or sale of assets, your information may be transferred
                as part of that transaction. We will notify you of any such change.
                Mobile phone numbers and SMS opt-in consent are expressly excluded
                from any such transfer and will not be provided to any successor
                entity for marketing purposes.
              </li>
              <li>
                <strong>Protection of Rights:</strong> When we believe disclosure is
                necessary to protect our rights, your safety, or the safety of
                others, or to investigate fraud.
              </li>
            </ul>
          </section>

          <section className="legal-section">
            <h2>5. Data Retention</h2>
            <p>
              We retain your information for the following periods:
            </p>
            <ul className="legal-list">
              <li>
                <strong>Analytics Data:</strong> 90 days from the date of
                collection.
              </li>
              <li>
                <strong>Chat Sessions:</strong> Chat session identifiers on your
                device expire after 24 hours (maximum 7-day retention). Server-side
                chat messages are retained per our backup and data management
                policies.
              </li>
              <li>
                <strong>Visitor and Interaction Data:</strong> Up to 12 months from
                the date of collection.
              </li>
              <li>
                <strong>Account Data:</strong> Retained for the duration of your
                account and deleted upon your request.
              </li>
              <li>
                <strong>Quote and Lead Data:</strong> Retained for the duration of
                the business relationship and as required by applicable law.
              </li>
              <li>
                <strong>Error Logs:</strong> Retained for 90 days, then
                automatically purged.
              </li>
            </ul>
          </section>

          <section className="legal-section">
            <h2>6. Cookie Consent and Your Choices</h2>
            <p>
              When you first visit our website, a consent banner allows you to
              choose your cookie preferences:
            </p>
            <ul className="legal-list">
              <li>
                <strong>Accept All:</strong> Enables analytics tracking (PostHog),
                session replay, and interaction event collection in addition to
                essential cookies.
              </li>
              <li>
                <strong>Essential Only:</strong> Only cookies required for core
                website functionality are used, including authentication sessions
                and chat functionality. All analytics and tracking are disabled.
              </li>
            </ul>
            <p>
              Your consent preference is stored in your browser's local storage. You
              can change your preference at any time by clearing your browser's
              local storage or contacting us at support@allynutra.com.
            </p>
            <p>
              We honor the Do Not Track (DNT) signal sent by your browser. If DNT is
              enabled, analytics tracking is automatically disabled regardless of
              your consent preference.
            </p>
          </section>

          <section className="legal-section">
            <h2>7. SMS and Text Messaging</h2>
            <p>
              If you opt in to receive SMS or MMS messages from Ally Nutra (for
              example, by checking the SMS consent box on a quote request form), the
              following terms apply:
            </p>
            <ul className="legal-list">
              <li>
                You consent to receive transactional text messages related to your
                appointments and account — such as booking confirmations and
                reminders — at the phone number you provided.
              </li>
              <li>
                Consent is not a condition of purchasing any goods or services from
                Ally Nutra.
              </li>
              <li>Message frequency varies.</li>
              <li>
                Standard message and data rates may apply. Contact your wireless
                carrier for details about your messaging plan.
              </li>
              <li>
                <strong>To opt out:</strong> Reply STOP to any message to
                unsubscribe. You will receive a confirmation message and no further
                messages will be sent.
              </li>
              <li>
                <strong>For help:</strong> Reply HELP to any message, or contact us
                at support@allynutra.com or (888) 884-2550.
              </li>
              <li>
                <strong>No sharing for marketing:</strong> We do not share, sell,
                rent, or transfer your mobile phone number or SMS opt-in consent to
                any third parties or affiliates for their marketing or promotional
                purposes.
              </li>
            </ul>
            <p>
              <strong>
                Mobile information collected for SMS — including your phone number
                and your record of opt-in consent — will not be shared with third
                parties or affiliates for marketing or promotional purposes.
              </strong>{' '}
              This information is used solely by Ally Nutra to send the messages you
              requested. All of the information-sharing categories described in this
              policy exclude text messaging originator opt-in data and consent; this
              information will not be shared with any third parties.
            </p>
          </section>

          <section className="legal-section">
            <h2>8. Your Rights and Choices</h2>
            <p>
              You have the right to:
            </p>
            <ul className="legal-list">
              <li>Access the personal information we hold about you</li>
              <li>Request correction of inaccurate information</li>
              <li>Request deletion of your personal information</li>
              <li>Request a portable copy of your data</li>
              <li>
                Restrict or object to certain processing of your information
              </li>
              <li>
                Opt out of marketing emails or transactional SMS at any time
              </li>
              <li>Withdraw consent where processing is based on consent</li>
              <li>Object to automated decision-making or profiling</li>
            </ul>
            <p>
              To exercise any of these rights, please contact us at
              support@allynutra.com. We will respond to your request within 30 days.
            </p>
          </section>

          <section className="legal-section">
            <h2>9. California Privacy Rights (CCPA/CPRA)</h2>
            <p>
              If you are a California resident, you have additional rights under the
              California Consumer Privacy Act (CCPA) and the California Privacy
              Rights Act (CPRA):
            </p>
            <ul className="legal-list">
              <li>
                <strong>Right to Know:</strong> You may request information about
                the categories and specific pieces of personal information we have
                collected about you, the categories of sources, the business purpose
                for collecting it, and the categories of third parties with whom we
                share it.
              </li>
              <li>
                <strong>Right to Delete:</strong> You may request that we delete
                personal information we have collected from you, subject to certain
                exceptions.
              </li>
              <li>
                <strong>Right to Opt Out of Sale:</strong> Ally Nutra does not sell
                your personal information. We do not and will not sell personal
                information to third parties.
              </li>
              <li>
                <strong>Right to Non-Discrimination:</strong> We will not
                discriminate against you for exercising any of your CCPA rights.
              </li>
            </ul>
            <p>
              In the preceding 12 months, we have collected the following categories
              of personal information: identifiers (name, email, phone, IP address),
              commercial information (quote requests, product specifications),
              internet or network activity (browsing history, interaction data,
              search queries), and geolocation data (derived from IP address).
            </p>
            <p>
              To submit a verifiable consumer request, email us at
              support@allynutra.com or call us at (888) 720-5888. You may also
              designate an authorized agent to make a request on your behalf.
            </p>
          </section>

          <section className="legal-section">
            <h2>10. Session Replay Disclosure</h2>
            <p>
              With your consent, we use session replay technology to record and play
              back how visitors interact with our website. This helps us identify
              usability issues and improve your experience. Here is how we protect
              your privacy during session replays:
            </p>
            <ul className="legal-list">
              <li>
                Session replays are recorded for a randomly selected 10% of
                consenting visitors. If you have selected "Essential Only" cookies,
                no session replays are recorded.
              </li>
              <li>
                All form inputs (text fields, passwords, etc.) are automatically
                masked and are not visible in replays.
              </li>
              <li>
                Sensitive page elements are blocked from recording entirely.
              </li>
              <li>
                Administrative pages are excluded from analytics tracking.
              </li>
              <li>
                Our analytics service (PostHog) may record session replays when an
                error occurs to help us diagnose issues. These replays mask all text
                content and form inputs.
              </li>
            </ul>
          </section>

          <section className="legal-section">
            <h2>11. International Data Transfers</h2>
            <p>
              Ally Nutra is based in the United States, and your information is
              processed and stored in the United States. Our third-party service
              providers (including PostHog, Supabase, Google, and Vercel) may
              process data in various jurisdictions. By using our website or
              services, you consent to the transfer of your information to the
              United States and other jurisdictions where our service providers
              operate.
            </p>
          </section>

          <section className="legal-section">
            <h2>12. Data Security</h2>
            <p>
              We implement appropriate technical and organizational measures to
              protect your personal information against unauthorized access,
              alteration, disclosure, or destruction. These measures include
              encrypted data transmission (HTTPS), secure password hashing,
              row-level security on our database, and access controls for internal
              staff. However, no method of transmission over the Internet or
              electronic storage is 100% secure, and we cannot guarantee absolute
              security.
            </p>
          </section>

          <section className="legal-section">
            <h2>13. Third-Party Links</h2>
            <p>
              Our website may contain links to third-party websites. We are not
              responsible for the privacy practices or content of these external
              sites. We encourage you to review the privacy policies of any
              third-party sites you visit.
            </p>
          </section>

          <section className="legal-section">
            <h2>14. Children's Privacy</h2>
            <p>
              Our services are not directed to individuals under the age of 18. We
              do not knowingly collect personal information from children. If you
              believe we have inadvertently collected such information, please
              contact us immediately and we will take steps to delete it.
            </p>
          </section>

          <section className="legal-section">
            <h2>15. Changes to This Privacy Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify
              you of any changes by posting the new Privacy Policy on this page and
              updating the "Last updated" date. We encourage you to review this
              Privacy Policy periodically.
            </p>
          </section>

          <section className="legal-section">
            <h2>16. Contact Us</h2>
            <p>
              If you have any questions about this Privacy Policy or our privacy
              practices, please contact us at:
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
        </div>
      </section>
    </section>
  );
}
