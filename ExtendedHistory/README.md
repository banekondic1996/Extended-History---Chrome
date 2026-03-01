# Extended History - Static Website

A professional static website for the Extended History Chrome Extension, built with pure HTML, CSS, and JavaScript.

## 📁 Project Structure

```
extended-history-website/
├── index.html          # Main landing page
├── privacy-policy.html # Comprehensive privacy policy
├── support.html        # Support and help documentation
├── terms.html          # Terms of service
├── styles.css          # All styling (responsive design)
├── script.js           # Interactive functionality
├── icon128.png         # Extension icon (128x128)
└── README.md           # This file
```

## 🚀 Features

### Pages Included

1. **Landing Page (index.html)**
   - Hero section with gradient effects
   - 12 feature cards showcasing extension capabilities
   - How it works section with step-by-step guide
   - Privacy highlights section
   - Download call-to-action
   - FAQ accordion with 7 common questions
   - Responsive footer with navigation

2. **Privacy Policy (privacy-policy.html)**
   - Comprehensive GDPR and CCPA compliant policy
   - Detailed explanation of data collection and storage
   - Chrome permissions breakdown with table
   - User rights and data control information
   - No-tracking guarantee
   - Local storage emphasis

3. **Support Page (support.html)**
   - Getting started guide
   - Common issues and solutions (6 troubleshooting cards)
   - Feature guides for all major functions
   - Technical requirements and compatibility
   - Contact information

4. **Terms of Service (terms.html)**
   - Complete legal terms
   - License agreement
   - User responsibilities
   - Disclaimers and liability limitations
   - Modification and termination clauses

## 🎨 Design Features

- **Modern UI**: Clean, professional design with gradient accents
- **Dark Theme**: Dark background with bright accent colors (blue #3b9eff and teal #2dd4a0)
- **Responsive**: Fully responsive design works on desktop, tablet, and mobile
- **Animations**: Smooth scroll animations and hover effects
- **Accessibility**: Semantic HTML and keyboard navigation support

## 🛠️ Technology Stack

- **Pure HTML5** - No frameworks or templating engines
- **Pure CSS3** - No preprocessors (SASS/LESS)
- **Pure JavaScript (ES6+)** - No jQuery or external libraries
- **Static files only** - Can be hosted anywhere

## 📦 Deployment

This is a static website that can be deployed to any web hosting service:

### Option 1: GitHub Pages
1. Create a GitHub repository
2. Upload all files to the repository
3. Go to Settings > Pages
4. Select main branch as source
5. Your site will be live at `https://yourusername.github.io/repo-name/`

### Option 2: Netlify
1. Drag and drop the entire folder to Netlify
2. Or connect your GitHub repository
3. Site will be live instantly with automatic SSL

### Option 3: Vercel
1. Install Vercel CLI: `npm install -g vercel`
2. Run `vercel` in the project directory
3. Follow the prompts

### Option 4: Traditional Hosting
1. Upload all files via FTP/SFTP to your web hosting
2. Ensure index.html is in the root directory
3. Make sure all file paths are correct

## 🔧 Customization

### Update Extension Icon
Replace `icon128.png` with your extension's actual icon (128x128px)

### Update Chrome Web Store Link
In both `index.html` and JavaScript, update the placeholder Chrome Web Store URL:
```javascript
const storeUrl = 'YOUR_ACTUAL_CHROME_STORE_URL';
```

### Change Colors
Edit CSS variables in `styles.css`:
```css
:root {
    --primary: #3b9eff;      /* Main accent color */
    --secondary: #2dd4a0;    /* Secondary accent color */
}
```

### Update Contact Information
In `support.html` and `privacy-policy.html`, update:
- Support email/form links
- GitHub issues link (if applicable)
- Social media links

## 📝 Content Updates

### Adding New FAQ Items
In `index.html`, add to the `.faq-list`:
```html
<div class="faq-item">
    <button class="faq-question">
        <span>Your question?</span>
        <span class="faq-arrow">▼</span>
    </button>
    <div class="faq-answer">
        <p>Your answer here</p>
    </div>
</div>
```

### Adding New Features
In `index.html`, add to the `.features-grid`:
```html
<div class="feature-card">
    <div class="feature-icon">🔥</div>
    <h3>Feature Title</h3>
    <p>Feature description</p>
</div>
```

## ✨ JavaScript Features

- Smooth scrolling for anchor links
- FAQ accordion functionality
- Navbar scroll effects
- Intersection Observer for animation on scroll
- Scroll to top button
- Lazy loading support
- Mobile menu ready (can be enabled)

## 🎯 SEO Optimization

The website includes:
- Semantic HTML5 structure
- Meta descriptions on all pages
- Proper heading hierarchy
- Alt tags for images
- Responsive design
- Fast loading times
- Clean URLs

## 📱 Browser Compatibility

- Chrome/Edge: Full support
- Firefox: Full support
- Safari: Full support
- Mobile browsers: Fully responsive

## 🔒 Privacy Compliance

The privacy policy covers:
- GDPR compliance (for EU users)
- CCPA compliance (for California users)
- Detailed data handling explanation
- User rights and control
- No third-party tracking

## 📄 License

This website template is provided as-is for use with the Extended History Chrome Extension.

## 🤝 Contributing

To contribute improvements:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📞 Support

For website issues or questions:
- Open an issue on GitHub
- Contact through the Chrome Web Store
- Use the support page contact form

## 🎉 Credits

Created for Extended History Chrome Extension
Design inspired by modern SaaS landing pages
Built with ❤️ using pure web technologies

---

**Note**: Remember to replace placeholder content (extension store URL, contact information, etc.) with your actual details before deploying to production.
