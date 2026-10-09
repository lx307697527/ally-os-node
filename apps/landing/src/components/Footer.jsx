import { Link } from 'react-router-dom';
import logoWhite from '../assets/images/logo-white.png';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <img className="footer-logo-img" src={logoWhite} alt="" width="783" height="627" />
            <p>Full-service supplement manufacturer — capsules, sachets, stick packs, and pouches.</p>
            <a href="tel:+18887205888" className="btn btn-primary">Call: (888) 720-5888</a>
          </div>
          <div className="footer-col">
            <h2>Quick Links</h2>
            <ul>
              <li><Link to="/home">Home</Link></li>
              <li><Link to="/services">Our Services</Link></li>
              <li><Link to="/certifications">Certifications</Link></li>
            </ul>
          </div>
          <div className="footer-col">
            <h2>Services</h2>
            <ul>
              <li><Link to="/services">Custom Manufacturing</Link></li>
              <li><Link to="/services">Packaging Design</Link></li>
              <li><Link to="/services">Amazon FBA Preparation</Link></li>
            </ul>
          </div>
          <div className="footer-col">
            <h2>Contact Us</h2>
            <ul>
              <li><a href="mailto:support@allynutra.com">support@allynutra.com</a></li>
              <li><a href="tel:+18887205888">(888) 720-5888</a></li>
              <li>631 Ridgely St, STE 1, Dover DE 19904</li>
              <li><a href="https://www.instagram.com/allynutra/" target="_blank" rel="noopener noreferrer">Follow us on Instagram</a></li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Ally Nutra. All rights reserved.</span>
          <span><Link to="/privacy-policy">Privacy Policy</Link> · <Link to="/terms-of-service">Terms of Service</Link></span>
        </div>
      </div>
    </footer>
  );
}
