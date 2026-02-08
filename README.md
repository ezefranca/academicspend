# Cite & Spend

Estimate article processing charges (APCs) for any researcher using their ORCID iD. Powered by [OpenAlex](https://openalex.org).

Fully client-side. No backend. No accounts. No trackers. No cookies.

**Live:** [ezefranca.com/academicspend](https://ezefranca.com/academicspend/)

## Features

- Enter an ORCID iD to generate an itemized receipt of estimated APCs
- Fetches works from OpenAlex with cursor-based pagination (up to 2,000 works)
- Multi-strategy ORCID resolution (direct lookup, filter search, ORCID public API name fallback)
- Two-tier fee logic: Known (explicit APC paid or DOAJ list price from OpenAlex) and Unknown (no data)
- Summary cards, spend-by-year bar chart, top publishers chart, Ouch-o-Meter
- Collapsible sortable/filterable ledger table with OA status badges
- Export to CSV and JSON
- Shareable URLs with `?orcid=` query parameter
- API-like JSON response with `?format=json&orcid=`
- Embeddable widget generator (badge, card, or full styles)
- Social share buttons (X, LinkedIn, Bluesky) and downloadable receipt image (PNG)
- Light and dark mode (auto + manual toggle)
- Responsive layout for mobile and desktop
- localStorage cache (24h) with manual refresh
- SEO: Open Graph, Twitter Cards, JSON-LD structured data, dynamic meta tags
- Comprehensive legal disclaimers
- Accessible: keyboard navigation, ARIA labels, focus rings, sufficient contrast

## Quick Start

1. Clone or download this repository
2. Open `index.html` in a browser
3. Enter an ORCID iD and click "Generate receipt"

No build step required. All files are plain HTML, CSS, and vanilla JavaScript.

## Deploy to GitHub Pages

1. Push this repository to GitHub
2. Go to **Settings** > **Pages**
3. Under "Source", select **Deploy from a branch**
4. Choose the branch (e.g. `main`) and root `/` directory
5. Click **Save**
6. Your site will be available at `https://<username>.github.io/<repo-name>/`

### Custom domain

If using a custom domain (e.g. `ezefranca.com/academicspend`):

1. In **Settings** > **Pages**, add your custom domain
2. All relative paths (`assets/styles.css`, etc.) work correctly from the root

### Base path for project pages

All asset paths are relative (no leading `/`), so the site works at any subdirectory without configuration.

## URL Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `orcid` | ORCID iD to look up | `?orcid=0000-0002-1825-0097` |
| `format` | Response format (`json` for API mode) | `?format=json&orcid=0000-0002-1825-0097` |

## API-like JSON Endpoint

Append `?format=json&orcid=XXXX-XXXX-XXXX-XXXX` to the site URL to get a JSON response rendered in the browser. This is not a real API, but a static page that fetches data client-side and displays it as formatted JSON.

Example: `https://ezefranca.com/academicspend/?format=json&orcid=0000-0002-1825-0097`

## Embeddable Widget

After generating a receipt, scroll down to the "Embed on your website" section to get HTML embed code. Three styles are available:

- **Badge** - compact inline badge
- **Card** - summary card with researcher name and total
- **Full** - full card with breakdown details

## Social Sharing

After generating a receipt, use the share buttons to post results to X, LinkedIn, or Bluesky. You can also download a 1080x1080 PNG receipt image suitable for Instagram, TikTok, and other platforms.

## ORCID Resolution

The app uses multiple strategies to resolve an ORCID to an OpenAlex author profile:

1. **Direct lookup** via `/authors/https://orcid.org/XXXX`
2. **Filter search** via `/authors?filter=orcid:XXXX`
3. **Name fallback** - fetches the researcher's name from the ORCID public API, then searches OpenAlex by name (shows a disambiguation warning)

## Privacy

- No accounts required
- All data is fetched client-side from OpenAlex (and optionally ORCID public API)
- Optional localStorage cache stores fetched data for 24 hours
- No third-party trackers, analytics, or cookies
- No data is sent to any server other than OpenAlex and ORCID

## Data Source

All publication data comes from [OpenAlex](https://openalex.org), an open catalog of the global research system.

## Limitations

- APCs vary by journal, year, article type, and negotiated agreements
- Fee waivers, institutional memberships, and discounts are not captured
- Only works with explicit APC data in OpenAlex (paid or DOAJ list price) are counted
- Currency conversions use hardcoded approximate rates (as of 2025-01-15)
- Some works may lack publisher or venue information in OpenAlex
- Author disambiguation in OpenAlex may merge or split profiles incorrectly

## File Structure

```
/
  index.html          Main page
  404.html            Custom 404 page (academic receipt joke)
  README.md           This file
  assets/
    styles.css        All styles (light/dark mode, responsive)
    app.js            All application logic (single IIFE)
    icons/
      favicon.svg     Site favicon
      og-image.svg    Open Graph social preview image
```

## License

MIT

---

Not affiliated with ORCID or OpenAlex. All estimates are provided as-is with no guarantees.
