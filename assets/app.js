/* ==========================================================================
   Cite & Spend - Application Logic
   ========================================================================== */

(function () {
  'use strict';

  /* -----------------------------------------------------------------------
     CONFIGURATION
     ----------------------------------------------------------------------- */
  const CONFIG = {
    openAlexBase: 'https://api.openalex.org',
    perPage: 200,
    maxWorks: 2000,
    cacheHours: 24,
    retryAttempts: 3,
    retryBaseDelay: 1000,
    exampleOrcid: '0000-0002-1825-0097',
    mailto: 'citeandspend@example.com',
    userAgent: 'CiteAndSpend/1.0 (https://github.com; mailto:citeandspend@example.com)',
  };

  /* -----------------------------------------------------------------------
     EXCHANGE RATES (approximate, as of 2025-01-15)
     ----------------------------------------------------------------------- */
  const EXCHANGE_TO_USD = {
    USD: 1,
    EUR: 1.09,
    GBP: 1.27,
    CHF: 1.15,
    CAD: 0.74,
    AUD: 0.65,
    JPY: 0.0065,
    CNY: 0.14,
    KRW: 0.00073,
    INR: 0.012,
    SEK: 0.096,
    NOK: 0.094,
    DKK: 0.146,
    PLN: 0.25,
    BRL: 0.17,
    MXN: 0.058,
    SGD: 0.74,
    NZD: 0.60,
  };
  const EXCHANGE_DATE = '2025-01-15';

  /* -----------------------------------------------------------------------
     STATE
     ----------------------------------------------------------------------- */
  let state = {
    works: [],
    filteredWorks: [],
    sortField: 'year',
    sortAsc: false,
    convertCurrency: false,
    loading: false,
    orcid: '',
    researcherName: '',
  };

  /* -----------------------------------------------------------------------
     DOM REFERENCES
     ----------------------------------------------------------------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  /* -----------------------------------------------------------------------
     ORCID UTILITIES
     ----------------------------------------------------------------------- */
  function normalizeOrcid(raw) {
    const stripped = raw.replace(/[\s-]/g, '').toUpperCase();
    if (stripped.length === 16 && /^\d{15}[\dX]$/.test(stripped)) {
      return `${stripped.slice(0, 4)}-${stripped.slice(4, 8)}-${stripped.slice(8, 12)}-${stripped.slice(12, 16)}`;
    }
    return null;
  }

  function validateOrcid(raw) {
    return normalizeOrcid(raw) !== null;
  }

  /* -----------------------------------------------------------------------
     CACHE UTILITIES
     ----------------------------------------------------------------------- */
  function getCacheKey(orcid) {
    return `citespend_${orcid}`;
  }

  function getFromCache(orcid) {
    try {
      const raw = localStorage.getItem(getCacheKey(orcid));
      if (!raw) return null;
      const cached = JSON.parse(raw);
      const age = Date.now() - cached.timestamp;
      if (age > CONFIG.cacheHours * 60 * 60 * 1000) {
        localStorage.removeItem(getCacheKey(orcid));
        return null;
      }
      return cached.data;
    } catch {
      return null;
    }
  }

  function setCache(orcid, data) {
    try {
      localStorage.setItem(getCacheKey(orcid), JSON.stringify({
        timestamp: Date.now(),
        data: data,
      }));
    } catch {
      // localStorage full or unavailable
    }
  }

  /* -----------------------------------------------------------------------
     NETWORK: Fetch with retry and backoff
     ----------------------------------------------------------------------- */
  async function fetchWithRetry(url, attempt = 0) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': CONFIG.userAgent,
        },
      });

      if (res.status === 429) {
        if (attempt < CONFIG.retryAttempts) {
          const delay = CONFIG.retryBaseDelay * Math.pow(2, attempt);
          updateProgress(`Rate limited. Retrying in ${(delay / 1000).toFixed(0)}s...`);
          await sleep(delay);
          return fetchWithRetry(url, attempt + 1);
        }
        throw new Error('Rate limited by OpenAlex. Please wait a moment and try again.');
      }

      if (!res.ok) {
        throw new Error(`OpenAlex returned status ${res.status}`);
      }

      return await res.json();
    } catch (err) {
      if (err.name === 'TypeError' && attempt < CONFIG.retryAttempts) {
        const delay = CONFIG.retryBaseDelay * Math.pow(2, attempt);
        await sleep(delay);
        return fetchWithRetry(url, attempt + 1);
      }
      throw err;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* -----------------------------------------------------------------------
     OPENALEX API
     Multi-strategy resolution:
     Strategy A: /authors/{orcid_url} direct lookup
     Strategy B: /authors?filter=orcid:{orcid} search
     Strategy C: /works?filter=author.orcid:{orcid_url} fallback (skip author step)
     Then: fetch works via authorships.author.id with cursor pagination
     ----------------------------------------------------------------------- */

  /**
   * Resolve ORCID to an OpenAlex author record.
   * Tries multiple strategies because OpenAlex can be inconsistent.
   */
  async function resolveAuthor(orcid) {
    const orcidUrl = `https://orcid.org/${orcid}`;

    // Strategy A: direct lookup by ORCID URL
    try {
      updateProgress('Looking up author in OpenAlex...');
      const url = `${CONFIG.openAlexBase}/authors/${orcidUrl}?mailto=${CONFIG.mailto}`;
      const data = await fetchWithRetry(url);
      if (data && data.id) {
        return {
          id: data.id,
          idShort: data.id.replace('https://openalex.org/', ''),
          name: data.display_name || '',
          worksCount: data.works_count || 0,
          strategy: 'A',
        };
      }
    } catch {
      // Strategy A failed, try B
    }

    // Strategy B: filter search
    try {
      updateProgress('Searching OpenAlex for author...');
      const url = `${CONFIG.openAlexBase}/authors?filter=orcid:${orcid}&mailto=${CONFIG.mailto}`;
      const data = await fetchWithRetry(url);
      if (data?.results?.length > 0) {
        const author = data.results[0];
        return {
          id: author.id,
          idShort: author.id.replace('https://openalex.org/', ''),
          name: author.display_name || '',
          worksCount: author.works_count || 0,
          strategy: 'B',
        };
      }
    } catch {
      // Strategy B failed, try C
    }

    // Strategy C: skip author resolution, query works directly
    // This is the least reliable but catches edge cases
    return null;
  }

  /**
   * Strategy D: When OpenAlex has no ORCID mapping, look up the name from ORCID's
   * public API and search OpenAlex by name. Returns the best match if found.
   */
  async function resolveAuthorByName(orcid) {
    try {
      updateProgress('ORCID not linked in OpenAlex. Looking up name from ORCID...');
      const res = await fetch(`https://pub.orcid.org/v3.0/${orcid}/person`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) return null;
      const person = await res.json();

      const given = person?.name?.['given-names']?.value || '';
      const family = person?.name?.['family-name']?.value || '';
      const credit = person?.name?.['credit-name']?.value || '';
      const fullName = credit || `${given} ${family}`.trim();
      if (!fullName) return null;

      updateProgress(`Found "${fullName}" on ORCID. Searching OpenAlex...`);
      const searchUrl = `${CONFIG.openAlexBase}/authors?search=${encodeURIComponent(fullName)}&mailto=${CONFIG.mailto}`;
      const data = await fetchWithRetry(searchUrl);

      if (data?.results?.length > 0) {
        // Return the top result (highest relevance score)
        const author = data.results[0];
        return {
          id: author.id,
          idShort: author.id.replace('https://openalex.org/', ''),
          name: author.display_name || fullName,
          worksCount: author.works_count || 0,
          strategy: 'D',
          nameFromOrcid: fullName,
          warning: 'This author was matched by name because their ORCID is not linked in OpenAlex. '
            + 'Author name disambiguation may be imperfect. Some works may belong to a different researcher with a similar name.',
        };
      }
    } catch {
      // Name lookup failed
    }
    return null;
  }

  async function fetchAllWorks(orcid, bypassCache = false) {
    if (!bypassCache) {
      const cached = getFromCache(orcid);
      if (cached) {
        updateProgress('Loaded from cache.');
        return cached;
      }
    }

    // Step 1: Resolve author via ORCID-linked strategies (A, B)
    let author = await resolveAuthor(orcid);
    let authorName = author?.name || '';
    let worksFilter;
    let warning = '';

    if (author) {
      worksFilter = `authorships.author.id:${author.idShort}`;
      updateProgress(`Found ${authorName || 'author'} (${formatNumber(author.worksCount)} works). Fetching publications...`);
    } else {
      // Strategy C: try works directly by ORCID
      updateProgress('Author profile not found. Searching works by ORCID directly...');
      worksFilter = `author.orcid:https://orcid.org/${orcid}`;
    }

    // Step 2: Fetch works
    let allWorks = [];
    let cursor = '*';
    let page = 0;
    let totalCount = 0;

    while (cursor && allWorks.length < CONFIG.maxWorks) {
      const worksUrl = `${CONFIG.openAlexBase}/works?filter=${worksFilter}&per-page=${CONFIG.perPage}&cursor=${cursor}&sort=publication_year:desc&mailto=${CONFIG.mailto}`;

      const data = await fetchWithRetry(worksUrl);

      if (page === 0) {
        totalCount = data.meta?.count || 0;
        if (totalCount === 0) break; // no results, will try Strategy D
      }

      allWorks = allWorks.concat(data.results || []);
      cursor = data.meta?.next_cursor || null;
      page++;

      const target = Math.min(totalCount, CONFIG.maxWorks);
      const pct = Math.min(100, Math.round((allWorks.length / target) * 100));
      updateProgressBar(pct);
      updateProgress(`Loaded ${allWorks.length} of ~${formatNumber(target)} works...`);
    }

    // Strategy D: If nothing found, try ORCID name -> OpenAlex name search
    if (allWorks.length === 0 && !author) {
      const nameAuthor = await resolveAuthorByName(orcid);
      if (nameAuthor) {
        author = nameAuthor;
        authorName = nameAuthor.name;
        warning = nameAuthor.warning || '';
        worksFilter = `authorships.author.id:${nameAuthor.idShort}`;
        updateProgress(`Matched "${authorName}" by name (${formatNumber(nameAuthor.worksCount)} works). Fetching publications...`);

        // Fetch works for name-matched author
        cursor = '*';
        page = 0;
        totalCount = 0;

        while (cursor && allWorks.length < CONFIG.maxWorks) {
          const worksUrl = `${CONFIG.openAlexBase}/works?filter=${worksFilter}&per-page=${CONFIG.perPage}&cursor=${cursor}&sort=publication_year:desc&mailto=${CONFIG.mailto}`;
          const data = await fetchWithRetry(worksUrl);

          if (page === 0) {
            totalCount = data.meta?.count || 0;
            if (totalCount === 0) break;
          }

          allWorks = allWorks.concat(data.results || []);
          cursor = data.meta?.next_cursor || null;
          page++;

          const target = Math.min(totalCount, CONFIG.maxWorks);
          const pct = Math.min(100, Math.round((allWorks.length / target) * 100));
          updateProgressBar(pct);
          updateProgress(`Loaded ${allWorks.length} of ~${formatNumber(target)} works...`);
        }
      }
    }

    // Still nothing
    if (allWorks.length === 0) {
      return { works: [], meta: { count: 0, capped: false }, authorName: authorName };
    }

    // If we used a fallback and have no author name, try to extract from works
    if (!authorName && allWorks.length > 0) {
      const authorship = allWorks[0].authorships?.find(
        (a) => a.author?.orcid?.replace('https://orcid.org/', '') === orcid
      );
      if (authorship) {
        authorName = authorship.author?.display_name || '';
      }
    }

    const result = {
      works: allWorks,
      meta: { count: totalCount, capped: totalCount > CONFIG.maxWorks },
      authorName: authorName,
      authorId: author?.id || null,
      warning: warning || '',
    };

    setCache(orcid, result);
    return result;
  }

  /* -----------------------------------------------------------------------
     APC FEE LOGIC
     ----------------------------------------------------------------------- */
  function analyzeAPC(work) {
    const result = {
      signal: 'unknown',     // 'known' or 'unknown'
      amount: null,
      currency: 'USD',
      amountUSD: null,
      confidence: 0,
      source: '',
      oaStatus: work.open_access?.oa_status || 'unknown',
      isOA: work.open_access?.is_oa || false,
    };

    // Step 1: Check for explicit APC paid
    if (work.apc_paid && work.apc_paid.value != null && work.apc_paid.value > 0) {
      result.signal = 'known';
      result.amount = work.apc_paid.value;
      result.currency = work.apc_paid.currency || 'USD';
      result.amountUSD = work.apc_paid.value_usd || convertToUSD(result.amount, result.currency);
      result.confidence = 0.9;
      result.source = `APC paid (${work.apc_paid.provenance || 'OpenAlex'})`;
      return result;
    }

    // Step 2: Check for APC list price (from DOAJ via OpenAlex)
    if (work.apc_list && work.apc_list.value != null && work.apc_list.value > 0) {
      const oaStatus = result.oaStatus;
      if (oaStatus === 'gold' || oaStatus === 'hybrid') {
        result.signal = 'known';
        result.amount = work.apc_list.value;
        result.currency = work.apc_list.currency || 'USD';
        result.amountUSD = work.apc_list.value_usd || convertToUSD(result.amount, result.currency);
        result.confidence = 0.7;
        result.source = `List price (${work.apc_list.provenance || 'DOAJ via OpenAlex'})`;
        return result;
      }
    }

    // Step 3: Unknown — no fee data available from OpenAlex
    result.signal = 'unknown';
    result.amount = 0;
    result.amountUSD = 0;
    result.source = 'No fee data available';
    return result;
  }

  function getPublisher(work) {
    return (
      work.primary_location?.source?.host_organization_name ||
      work.primary_location?.source?.display_name ||
      ''
    );
  }

  function convertToUSD(amount, currency) {
    const rate = EXCHANGE_TO_USD[currency.toUpperCase()];
    if (rate) return Math.round(amount * rate);
    return amount; // assume USD if unknown
  }

  function getOuchFactor(amountUSD) {
    if (!amountUSD || amountUSD <= 0) return null;
    if (amountUSD < 1000) return 'low';
    if (amountUSD < 3000) return 'medium';
    return 'high';
  }

  function getOuchLabel(factor) {
    switch (factor) {
      case 'low': return 'Pocket change';
      case 'medium': return 'That adds up';
      case 'high': return 'Grant money, gone';
      default: return '';
    }
  }

  /* -----------------------------------------------------------------------
     DATA PROCESSING
     ----------------------------------------------------------------------- */
  function processWorks(rawWorks) {
    return rawWorks.map((work) => {
      const apc = analyzeAPC(work);
      const doi = work.doi || '';
      const doiUrl = doi.startsWith('https://') ? doi : (doi ? `https://doi.org/${doi}` : '');

      return {
        id: work.id,
        year: work.publication_year || 0,
        title: work.title || work.display_name || 'Untitled',
        doi: doiUrl,
        venue: work.primary_location?.source?.display_name || 'Unknown venue',
        publisher: getPublisher(work),
        oaStatus: apc.oaStatus,
        isOA: apc.isOA,
        signal: apc.signal,
        amount: apc.amount,
        currency: apc.currency,
        amountUSD: apc.amountUSD,
        confidence: apc.confidence,
        source: apc.source,
        ouchFactor: getOuchFactor(apc.amountUSD),
        type: work.type || 'unknown',
        citedByCount: work.cited_by_count || 0,
        raw: work,
      };
    });
  }

  function aggregateData(works) {
    const totals = { known: 0, unknown: 0 };
    const counts = { known: 0, unknown: 0 };
    const byYear = {};
    const byPublisher = {};
    const currencies = {};
    let minYear = Infinity;
    let maxYear = -Infinity;

    works.forEach((w) => {
      const usd = w.amountUSD || 0;
      totals[w.signal] += usd;
      counts[w.signal]++;

      if (w.currency && w.amount > 0) {
        if (!currencies[w.currency]) currencies[w.currency] = 0;
        currencies[w.currency] += w.amount;
      }

      if (w.year) {
        if (!byYear[w.year]) byYear[w.year] = { known: 0, unknown: 0 };
        byYear[w.year][w.signal] += usd;
        if (w.year < minYear) minYear = w.year;
        if (w.year > maxYear) maxYear = w.year;
      }

      if (w.publisher) {
        if (!byPublisher[w.publisher]) byPublisher[w.publisher] = 0;
        byPublisher[w.publisher] += usd;
      }
    });

    return {
      totals,
      counts,
      byYear,
      byPublisher,
      currencies,
      dateRange: minYear !== Infinity ? { min: minYear, max: maxYear } : null,
      totalUSD: totals.known,
      totalAll: totals.known + totals.unknown,
    };
  }

  /* -----------------------------------------------------------------------
     FORMAT UTILITIES
     ----------------------------------------------------------------------- */
  function formatCurrency(amount, currency = 'USD') {
    if (amount == null) return '--';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      return `${currency} ${amount.toLocaleString()}`;
    }
  }

  function formatNumber(n) {
    return (n || 0).toLocaleString();
  }

  /* -----------------------------------------------------------------------
     PROGRESS UI
     ----------------------------------------------------------------------- */
  function showProgress() {
    const el = $('#progress-section');
    if (el) el.classList.remove('hidden');
    updateProgressBar(0);
  }

  function hideProgress() {
    const el = $('#progress-section');
    if (el) el.classList.add('hidden');
  }

  function updateProgressBar(pct) {
    const bar = $('#progress-bar');
    if (!bar) return;
    bar.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', pct);
  }

  function updateProgress(msg) {
    const span = $('#progress-text span');
    if (span) span.textContent = msg;
  }

  /* -----------------------------------------------------------------------
     TOAST NOTIFICATIONS
     ----------------------------------------------------------------------- */
  function showToast(msg, duration = 3000) {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-out');
      toast.addEventListener('animationend', () => toast.remove());
    }, duration);
  }

  /* -----------------------------------------------------------------------
     RENDER: Summary Cards
     ----------------------------------------------------------------------- */
  function renderSummary(works, agg) {
    const convertMode = state.convertCurrency;

    $('#val-total').textContent = formatCurrency(agg.totalUSD);
    $('#note-total').textContent = `Known fees in USD`;

    $('#val-works').textContent = formatNumber(works.length);
    $('#note-works').textContent = agg.counts.known > 0
      ? `${agg.counts.unknown} with no fee data`
      : '';

    const knownPct = works.length > 0
      ? Math.round((agg.counts.known / works.length) * 100)
      : 0;
    $('#val-known').textContent = `${agg.counts.known}`;
    $('#note-known').textContent = `${knownPct}% of total works`;

    if (agg.dateRange) {
      $('#val-range').textContent = `${agg.dateRange.min} - ${agg.dateRange.max}`;
      const span = agg.dateRange.max - agg.dateRange.min + 1;
      $('#note-range').textContent = `${span} year${span !== 1 ? 's' : ''} of publishing`;
    }

    // Breakdown
    $('#breakdown-known').textContent = formatCurrency(agg.totals.known);
    $('#breakdown-unknown').textContent = `${agg.counts.unknown} works`;

    // Ouch-o-meter
    renderOuchMeter(agg.totalUSD);
  }

  function renderOuchMeter(totalUSD) {
    const card = $('#ouch-card');
    const bar = $('#ouch-bar');
    const verdict = $('#ouch-verdict');

    if (totalUSD <= 0) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');

    // Scale: 0 = $0, 100% = $200,000+
    const pct = Math.min(100, (totalUSD / 200000) * 100);
    bar.style.left = `${pct}%`;

    let msg = '';
    if (totalUSD < 5000) msg = 'Not bad at all. Coffee money in academic terms.';
    else if (totalUSD < 20000) msg = 'A decent used car, or a year of APCs. Your call.';
    else if (totalUSD < 50000) msg = 'That is a graduate student stipend right there.';
    else if (totalUSD < 100000) msg = 'We are approaching "small grant" territory.';
    else msg = 'This researcher has personally funded a small research program in APCs alone.';

    verdict.textContent = msg;
  }

  /* -----------------------------------------------------------------------
     RENDER: Researcher Info
     ----------------------------------------------------------------------- */
  function renderResearcherInfo(name, orcid, meta, warning) {
    const el = $('#researcher-info');
    let html = '';
    if (name) {
      html += `<h2>${escapeHTML(name)}</h2>`;
    }
    html += `<p>ORCID: <a href="https://orcid.org/${orcid}" target="_blank" rel="noopener noreferrer">${orcid}</a>`;
    if (meta.capped) {
      html += ` | <strong>Note:</strong> Results capped at ${CONFIG.maxWorks} of ${formatNumber(meta.count)} total works.`;
    }
    html += '</p>';
    if (warning) {
      html += `<p class="researcher-warning"><strong>Note:</strong> ${escapeHTML(warning)}</p>`;
    }
    el.innerHTML = html;
  }

  /* -----------------------------------------------------------------------
     RENDER: Charts (Pure SVG)
     ----------------------------------------------------------------------- */
  function renderYearChart(byYear) {
    const container = $('#chart-year');
    const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
    if (years.length === 0) {
      container.innerHTML = '<p style="color:var(--text-tertiary);font-size:13px;">No data for chart.</p>';
      return;
    }

    // -- Layout --
    const padding = { top: 24, right: 24, bottom: 72, left: 56 };
    const width = 560;
    const height = 320;
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    // Bar sizing: give each bar generous width, min 8px, max 36px
    const barGap = Math.max(2, Math.min(6, 120 / years.length));
    const barW = Math.max(8, Math.min(36, (chartW / years.length) - barGap));
    const totalBarSpace = years.length * (barW + barGap) - barGap;
    const offsetX = (chartW - totalBarSpace) / 2;

    // -- Scale --
    let maxVal = 0;
    years.forEach((y) => {
      const total = byYear[y].known || 0;
      if (total > maxVal) maxVal = total;
    });
    if (maxVal === 0) maxVal = 1;
    const niceMax = niceNumber(maxVal);
    const tickCount = 5;
    const tickStep = niceMax / tickCount;

    let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Spend by year bar chart">`;

    // Y-axis grid lines and labels
    for (let i = 0; i <= tickCount; i++) {
      const val = tickStep * i;
      const y = padding.top + chartH - (val / niceMax) * chartH;
      svg += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--border-secondary)" stroke-width="0.75" stroke-dasharray="${i === 0 ? 'none' : '3,3'}"/>`;
      svg += `<text x="${padding.left - 10}" y="${y + 4}" class="chart-label" text-anchor="end">${formatCompact(val)}</text>`;
    }

    // Baseline
    const baseY = padding.top + chartH;
    svg += `<line x1="${padding.left}" y1="${baseY}" x2="${width - padding.right}" y2="${baseY}" stroke="var(--text-tertiary)" stroke-width="1" opacity="0.3"/>`;

    // -- Smart label interval: show ~8-12 labels max, rotate if > 10 years --
    const maxLabels = 12;
    const labelInterval = Math.max(1, Math.ceil(years.length / maxLabels));
    const rotateLabels = years.length > 10;

    // Bars
    years.forEach((year, i) => {
      const known = byYear[year].known || 0;
      const x = padding.left + offsetX + i * (barW + barGap);

      // Known bar (green)
      const knownH = Math.max(known > 0 ? 1.5 : 0, (known / niceMax) * chartH);
      const knownY = baseY - knownH;
      if (known > 0) {
        svg += `<rect class="chart-bar" x="${x}" y="${knownY}" width="${barW}" height="${knownH}" rx="${Math.min(3, barW / 2)}" fill="var(--known-color)" opacity="0.85"><title>${year}: ${formatCurrency(known)}</title></rect>`;
      }

      // Year labels: rotated -45deg for legibility when many years
      const showLabel = i % labelInterval === 0 || i === years.length - 1;
      if (showLabel) {
        const lx = x + barW / 2;
        const ly = baseY + 14;
        if (rotateLabels) {
          svg += `<text x="${lx}" y="${ly}" class="chart-label" text-anchor="end" transform="rotate(-45 ${lx} ${ly})">${year}</text>`;
        } else {
          svg += `<text x="${lx}" y="${ly}" class="chart-label" text-anchor="middle">${year}</text>`;
        }
      }
    });

    // Legend
    const legendY = padding.top + 2;
    svg += `<rect x="${width - padding.right - 60}" y="${legendY}" width="10" height="10" rx="2" fill="var(--known-color)" opacity="0.85"/>`;
    svg += `<text x="${width - padding.right - 46}" y="${legendY + 9}" class="chart-label">Known</text>`;

    svg += '</svg>';
    container.innerHTML = svg;
  }

  function renderPublisherChart(byPublisher) {
    const container = $('#chart-publisher');
    const entries = Object.entries(byPublisher)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (entries.length === 0) {
      container.innerHTML = '<p style="color:var(--text-tertiary);font-size:13px;">No publisher data for chart.</p>';
      return;
    }

    const padding = { top: 10, right: 70, bottom: 10, left: 170 };
    const barH = 32;
    const gap = 8;
    const height = padding.top + padding.bottom + entries.length * (barH + gap);
    const width = 560;
    const chartW = width - padding.left - padding.right;

    const maxVal = entries[0][1] || 1;

    let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Spend by publisher horizontal bar chart">`;

    entries.forEach(([name, value], i) => {
      const y = padding.top + i * (barH + gap);
      const w = (value / maxVal) * chartW;
      const truncName = name.length > 22 ? name.slice(0, 20) + '...' : name;

      // Label (right-aligned, before bar)
      svg += `<text x="${padding.left - 10}" y="${y + barH / 2 + 5}" class="chart-label" text-anchor="end" style="font-size:12px;">${escapeHTML(truncName)}</text>`;

      // Bar with rounded ends
      svg += `<rect class="chart-bar" x="${padding.left}" y="${y}" width="${Math.max(3, w)}" height="${barH}" rx="5" fill="var(--accent)" opacity="0.75"><title>${escapeHTML(name)}: ${formatCurrency(value)}</title></rect>`;

      // Value label after bar
      svg += `<text x="${padding.left + Math.max(3, w) + 8}" y="${y + barH / 2 + 5}" class="chart-value-label">${formatCompact(value)}</text>`;
    });

    svg += '</svg>';
    container.innerHTML = svg;
  }

  function niceNumber(val) {
    const exp = Math.floor(Math.log10(val));
    const frac = val / Math.pow(10, exp);
    let nice;
    if (frac <= 1) nice = 1;
    else if (frac <= 2) nice = 2;
    else if (frac <= 5) nice = 5;
    else nice = 10;
    return nice * Math.pow(10, exp);
  }

  function formatCompact(val) {
    if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `$${(val / 1000).toFixed(0)}k`;
    return `$${Math.round(val)}`;
  }

  /* -----------------------------------------------------------------------
     RENDER: Ledger Table
     ----------------------------------------------------------------------- */
  function renderLedger(works) {
    const tbody = $('#ledger-body');
    const countEl = $('#ledger-count');

    countEl.textContent = `${works.length} item${works.length !== 1 ? 's' : ''}`;

    if (works.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-tertiary);">No works match filters.</td></tr>';
      return;
    }

    const fragment = document.createDocumentFragment();

    works.forEach((w) => {
      const tr = document.createElement('tr');

      // Year
      const tdYear = document.createElement('td');
      tdYear.className = 'col-year';
      tdYear.textContent = w.year || '--';
      tr.appendChild(tdYear);

      // Title
      const tdTitle = document.createElement('td');
      tdTitle.className = 'col-title';
      if (w.doi) {
        const a = document.createElement('a');
        a.href = w.doi;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = w.title;
        a.title = w.title;
        tdTitle.appendChild(a);
      } else {
        tdTitle.textContent = w.title;
        tdTitle.title = w.title;
      }
      tr.appendChild(tdTitle);

      // Venue
      const tdVenue = document.createElement('td');
      tdVenue.className = 'col-venue';
      tdVenue.textContent = w.venue;
      tdVenue.title = w.venue;
      tr.appendChild(tdVenue);

      // OA status
      const tdOA = document.createElement('td');
      const oaBadge = document.createElement('span');
      oaBadge.className = `oa-badge ${w.oaStatus || 'unknown'}`;
      oaBadge.textContent = w.oaStatus || '?';
      tdOA.appendChild(oaBadge);
      tr.appendChild(tdOA);

      // Fee signal
      const tdSignal = document.createElement('td');
      const sigBadge = document.createElement('span');
      sigBadge.className = `signal-badge ${w.signal}`;
      sigBadge.textContent = w.signal;
      sigBadge.title = w.source;
      tdSignal.appendChild(sigBadge);
      tr.appendChild(tdSignal);

      // Amount
      const tdAmount = document.createElement('td');
      tdAmount.className = 'col-amount';
      if (w.signal === 'unknown' || !w.amount) {
        tdAmount.textContent = '--';
        tdAmount.style.color = 'var(--text-tertiary)';
      } else {
        const displayAmount = state.convertCurrency
          ? formatCurrency(w.amountUSD, 'USD')
          : formatCurrency(w.amount, w.currency);
        tdAmount.textContent = displayAmount;
      }
      tr.appendChild(tdAmount);

      // Publisher took / Ouch
      const tdOuch = document.createElement('td');
      if (w.ouchFactor) {
        const span = document.createElement('span');
        span.className = `ouch-label ${w.ouchFactor}`;
        span.textContent = getOuchLabel(w.ouchFactor);
        tdOuch.appendChild(span);
      } else {
        tdOuch.textContent = '--';
        tdOuch.style.color = 'var(--text-tertiary)';
      }
      tr.appendChild(tdOuch);

      fragment.appendChild(tr);
    });

    tbody.innerHTML = '';
    tbody.appendChild(fragment);
  }

  /* -----------------------------------------------------------------------
     FILTERS
     ----------------------------------------------------------------------- */
  function populateYearFilters(works) {
    const years = [...new Set(works.map((w) => w.year).filter(Boolean))].sort();
    const fromSel = $('#filter-year-from');
    const toSel = $('#filter-year-to');

    fromSel.innerHTML = '<option value="">All</option>';
    toSel.innerHTML = '<option value="">All</option>';

    years.forEach((y) => {
      fromSel.innerHTML += `<option value="${y}">${y}</option>`;
      toSel.innerHTML += `<option value="${y}">${y}</option>`;
    });
  }

  function applyFilters() {
    let filtered = [...state.works];

    const search = ($('#filter-search')?.value || '').toLowerCase();
    const yearFrom = parseInt($('#filter-year-from')?.value) || 0;
    const yearTo = parseInt($('#filter-year-to')?.value) || 9999;
    const oaOnly = $('#filter-oa-only')?.checked;
    const knownOnly = $('#filter-known-only')?.checked;

    if (search) {
      filtered = filtered.filter((w) =>
        w.title.toLowerCase().includes(search) ||
        w.venue.toLowerCase().includes(search)
      );
    }

    if (yearFrom) {
      filtered = filtered.filter((w) => w.year >= yearFrom);
    }
    if (yearTo < 9999) {
      filtered = filtered.filter((w) => w.year <= yearTo);
    }

    if (oaOnly) {
      filtered = filtered.filter((w) => w.isOA);
    }

    if (knownOnly) {
      filtered = filtered.filter((w) => w.signal === 'known');
    }

    state.filteredWorks = sortWorks(filtered);
    renderLedger(state.filteredWorks);
  }

  /* -----------------------------------------------------------------------
     SORTING
     ----------------------------------------------------------------------- */
  function sortWorks(works) {
    const field = state.sortField;
    const asc = state.sortAsc;
    return [...works].sort((a, b) => {
      let va, vb;
      switch (field) {
        case 'year':
          va = a.year || 0;
          vb = b.year || 0;
          break;
        case 'title':
          va = a.title.toLowerCase();
          vb = b.title.toLowerCase();
          break;
        case 'venue':
          va = a.venue.toLowerCase();
          vb = b.venue.toLowerCase();
          break;
        case 'signal':
          const order = { known: 0, unknown: 1 };
          va = order[a.signal] ?? 3;
          vb = order[b.signal] ?? 3;
          break;
        case 'amount':
          va = a.amountUSD || 0;
          vb = b.amountUSD || 0;
          break;
        default:
          va = a.year || 0;
          vb = b.year || 0;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });
  }

  /* -----------------------------------------------------------------------
     EXPORT
     ----------------------------------------------------------------------- */
  function exportCSV() {
    const works = state.filteredWorks.length > 0 ? state.filteredWorks : state.works;
    const headers = ['Year', 'Title', 'DOI', 'Venue', 'Publisher', 'OA Status', 'Fee Signal', 'Amount', 'Currency', 'Amount (USD)', 'Confidence', 'Source'];
    const rows = works.map((w) => [
      w.year,
      `"${(w.title || '').replace(/"/g, '""')}"`,
      w.doi,
      `"${(w.venue || '').replace(/"/g, '""')}"`,
      `"${(w.publisher || '').replace(/"/g, '""')}"`,
      w.oaStatus,
      w.signal,
      w.amount || '',
      w.currency,
      w.amountUSD || '',
      w.confidence,
      `"${(w.source || '').replace(/"/g, '""')}"`,
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    downloadFile(csv, `cite-and-spend-${state.orcid}.csv`, 'text/csv');
    showToast('CSV exported successfully.');
  }

  function buildAPIResponse() {
    const works = state.works;
    const agg = aggregateData(works);

    return {
      meta: {
        api: 'Cite & Spend',
        version: '1.0.0',
        disclaimer: 'APC data comes from OpenAlex (apc_paid / apc_list from DOAJ). No fabricated estimates.',
        generatedAt: new Date().toISOString(),
        dataSource: 'OpenAlex (https://openalex.org)',
        orcid: state.orcid,
        researcherName: state.researcherName || null,
        worksCount: works.length,
        htmlUrl: `https://ezefranca.com/academicspend/?orcid=${state.orcid}`,
      },
      summary: {
        totalKnownAPC_USD: Math.round(agg.totalUSD),
        worksWithKnownFees: agg.counts.known,
        worksWithUnknownFees: agg.counts.unknown,
        dateRange: agg.dateRange,
        currencyBreakdown: agg.currencies,
        exchangeRatesDate: EXCHANGE_DATE,
      },
      spendByYear: Object.entries(agg.byYear)
        .map(([year, vals]) => ({ year: parseInt(year), known_USD: Math.round(vals.known) }))
        .sort((a, b) => a.year - b.year),
      topPublishers: Object.entries(agg.byPublisher)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([name, total]) => ({ publisher: name, totalAPC_USD: Math.round(total) })),
      works: works.map((w) => ({
        year: w.year,
        title: w.title,
        doi: w.doi || null,
        venue: w.venue,
        publisher: w.publisher,
        oaStatus: w.oaStatus,
        feeSignal: w.signal,
        amount: w.amount,
        currency: w.currency,
        amountUSD: w.amountUSD,
        confidence: w.confidence,
        sourceNote: w.source,
      })),
    };
  }

  function exportJSON() {
    const data = buildAPIResponse();
    const json = JSON.stringify(data, null, 2);
    downloadFile(json, `cite-and-spend-${state.orcid}.json`, 'application/json');
    showToast('JSON exported successfully.');
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* -----------------------------------------------------------------------
     URL / SHARE / SEO
     ----------------------------------------------------------------------- */
  function updateURL(orcid) {
    const url = new URL(window.location);
    url.searchParams.set('orcid', orcid);
    window.history.replaceState({}, '', url.toString());
  }

  function getOrcidFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('orcid') || '';
  }

  function getFormatFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('format') || '';
  }

  function copyShareLink() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      showToast('Link copied to clipboard.');
    }).catch(() => {
      showToast('Could not copy link.');
    });
  }

  /**
   * Update Open Graph and Twitter meta tags dynamically.
   * Since crawlers typically don't run JS, this mainly helps with
   * copy-paste previews in apps that do client-side unfurling (Slack, Discord, etc.)
   * and keeps the document.title accurate for bookmarks/tabs.
   */
  function updateSEOMeta(name, orcid, agg) {
    const baseUrl = window.location.origin + window.location.pathname;
    const shareUrl = `${baseUrl}?orcid=${orcid}`;

    // Page title
    const titleText = name
      ? `${name} - ${formatCurrency(agg.totalUSD)} in estimated APCs | Cite & Spend`
      : `ORCID ${orcid} - ${formatCurrency(agg.totalUSD)} in estimated APCs | Cite & Spend`;
    document.title = titleText;

    // Description
    const descText = name
      ? `${name} has an estimated ${formatCurrency(agg.totalUSD)} in article processing charges across ${formatNumber(state.works.length)} works. Explore the full breakdown.`
      : `Researcher ${orcid} has an estimated ${formatCurrency(agg.totalUSD)} in article processing charges across ${formatNumber(state.works.length)} works.`;

    // Update meta tags
    setMeta('description', descText);
    setMetaProperty('og:title', titleText);
    setMetaProperty('og:description', descText);
    setMetaProperty('og:url', shareUrl);
    setMetaById('og-title', 'content', titleText);
    setMetaById('og-description', 'content', descText);
    setMetaById('og-url', 'content', shareUrl);
    setMetaById('tw-title', 'content', titleText);
    setMetaById('tw-description', 'content', descText);

    // Canonical
    const canonical = document.getElementById('canonical-link');
    if (canonical) canonical.setAttribute('href', shareUrl);

    // Update JSON-LD
    updateJsonLd(name, orcid, descText, shareUrl);
  }

  function setMeta(name, content) {
    let el = document.querySelector(`meta[name="${name}"]`);
    if (el) el.setAttribute('content', content);
  }

  function setMetaProperty(prop, content) {
    let el = document.querySelector(`meta[property="${prop}"]`);
    if (el) el.setAttribute('content', content);
  }

  function setMetaById(id, attr, value) {
    const el = document.getElementById(id);
    if (el) el.setAttribute(attr, value);
  }

  function updateJsonLd(name, orcid, description, url) {
    let script = document.querySelector('script[type="application/ld+json"]');
    if (!script) return;
    try {
      const data = JSON.parse(script.textContent);
      data.url = url;
      data.description = description;
      if (name) data.name = `Cite & Spend - ${name}`;
      script.textContent = JSON.stringify(data);
    } catch {
      // ignore parse errors
    }
  }

  /**
   * API-like JSON endpoint: if ?format=json&orcid=... is in the URL,
   * fetch data, render a JSON response to the page, and set content-type-like headers.
   * Since we cannot set HTTP headers from a static site, we replace the entire document
   * with formatted JSON, giving it the feel of a REST API endpoint.
   */
  async function handleAPIMode(orcid) {
    // Replace the page with a loading indicator
    document.body.innerHTML = '<pre style="font-family:monospace;padding:24px;background:#1a1a1a;color:#a0ffa0;min-height:100vh;margin:0;">Loading data for ORCID ' + escapeHTML(orcid) + '...</pre>';
    document.body.style.margin = '0';

    try {
      const normalized = normalizeOrcid(orcid);
      if (!normalized) {
        renderAPIResponse({
          error: true,
          message: 'Invalid ORCID format',
          hint: 'Use format: 0000-0002-1825-0097',
          status: 400,
        });
        return;
      }

      const data = await fetchAllWorks(normalized);

      if (!data.works || data.works.length === 0) {
        renderAPIResponse({
          error: true,
          message: 'No works found for this ORCID',
          orcid: normalized,
          status: 404,
        });
        return;
      }

      state.orcid = normalized;
      state.researcherName = data.authorName || '';
      state.works = processWorks(data.works);

      renderAPIResponse(buildAPIResponse());
    } catch (err) {
      renderAPIResponse({
        error: true,
        message: err.message,
        status: 500,
      });
    }
  }

  function renderAPIResponse(data) {
    const json = JSON.stringify(data, null, 2);
    document.body.innerHTML = '';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.background = '#1a1a1a';
    document.body.style.opacity = '1';

    const pre = document.createElement('pre');
    pre.style.cssText = 'font-family:"SF Mono",Menlo,Consolas,monospace;font-size:13px;line-height:1.5;padding:24px;margin:0;min-height:100vh;color:#e0e0e0;white-space:pre-wrap;word-break:break-word;';
    pre.textContent = json;
    document.body.appendChild(pre);

    // Update title
    document.title = `API Response | Cite & Spend`;

    // Add a subtle link back to the HTML view
    const nav = document.createElement('div');
    nav.style.cssText = 'position:fixed;top:12px;right:12px;z-index:100;';
    nav.innerHTML = `<a href="${window.location.pathname}?orcid=${data?.meta?.orcid || ''}" style="display:inline-block;padding:8px 16px;background:#0071e3;color:white;border-radius:8px;font-family:-apple-system,sans-serif;font-size:13px;font-weight:600;text-decoration:none;">View as page</a>`;
    document.body.appendChild(nav);
  }

  /* -----------------------------------------------------------------------
     THEME
     ----------------------------------------------------------------------- */
  function initTheme() {
    const saved = localStorage.getItem('citespend_theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const isDark = current === 'dark' || (!current && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('citespend_theme', next);
  }

  /* -----------------------------------------------------------------------
     ERROR HANDLING
     ----------------------------------------------------------------------- */
  function showError(msg) {
    const el = $('#orcid-error');
    el.textContent = msg;
    $('#orcid-input').classList.add('error');
  }

  function clearError() {
    const el = $('#orcid-error');
    el.textContent = '';
    $('#orcid-input').classList.remove('error');
  }

  /* -----------------------------------------------------------------------
     SKELETON LOADING
     ----------------------------------------------------------------------- */
  function showSkeleton() {
    const results = $('#results-section');
    results.classList.remove('hidden');
    results.classList.remove('fade-in');

    // Set skeleton values
    ['val-total', 'val-works', 'val-known', 'val-range'].forEach((id) => {
      const el = $(`#${id}`);
      el.innerHTML = '<span class="skeleton skeleton-value" style="display:inline-block;"></span>';
    });
  }

  function hideSkeleton() {
    // Skeleton values get replaced by real values
  }

  /* -----------------------------------------------------------------------
     MAIN: Generate Receipt
     ----------------------------------------------------------------------- */
  async function generateReceipt(orcidRaw, bypassCache = false) {
    clearError();

    const orcid = normalizeOrcid(orcidRaw);
    if (!orcid) {
      showError('Invalid ORCID iD. Please check the format (e.g. 0000-0002-1825-0097).');
      return;
    }

    state.orcid = orcid;
    state.loading = true;
    updateURL(orcid);

    const submitBtn = $('#submit-btn');
    submitBtn.disabled = true;

    showProgress();
    showSkeleton();

    try {
      const data = await fetchAllWorks(orcid, bypassCache);

      if (!data.works || data.works.length === 0) {
        hideProgress();
        showError('No works found for this ORCID. The researcher may not have linked publications in OpenAlex.');
        $('#results-section').classList.add('hidden');
        return;
      }

      state.researcherName = data.authorName || '';
      state.works = processWorks(data.works);
      state.filteredWorks = sortWorks([...state.works]);

      const agg = aggregateData(state.works);

      hideProgress();
      hideSkeleton();

      // Render everything
      renderResearcherInfo(state.researcherName, orcid, data.meta, data.warning);
      renderSummary(state.works, agg);
      renderYearChart(agg.byYear);
      renderPublisherChart(agg.byPublisher);
      populateYearFilters(state.works);
      renderLedger(state.filteredWorks);
      // Show currency section if mixed currencies
      const currencies = Object.keys(agg.currencies);
      if (currencies.length > 1 || (currencies.length === 1 && currencies[0] !== 'USD')) {
        $('#currency-section').style.display = 'block';
      }

      // Update SEO meta tags for social sharing
      updateSEOMeta(state.researcherName, orcid, agg);

      // Animate in
      const results = $('#results-section');
      results.classList.remove('hidden');
      results.classList.add('fade-in');

      // Update widget/embed generator
      updateWidgetGenerator();

      // Re-create Lucide icons for dynamic content
      if (window.lucide) lucide.createIcons();

    } catch (err) {
      hideProgress();
      showError(`Error: ${err.message}`);
      console.error('Cite & Spend error:', err);
    } finally {
      submitBtn.disabled = false;
      state.loading = false;
    }
  }

  /* -----------------------------------------------------------------------
     ESCAPE HTML
     ----------------------------------------------------------------------- */
  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* -----------------------------------------------------------------------
     SOCIAL SHARING
     ----------------------------------------------------------------------- */
  function getShareText() {
    const name = state.researcherName || `ORCID ${state.orcid}`;
    const agg = state.works.length > 0 ? aggregateData(state.works) : null;
    const total = agg ? formatCurrency(agg.totalUSD) : '$0';
    return `${name} has an estimated ${total} in article processing charges across ${state.works.length} works. Check yours:`;
  }

  function getShareUrl() {
    return `https://ezefranca.com/academicspend/?orcid=${state.orcid}`;
  }

  function shareOnX() {
    const text = encodeURIComponent(getShareText());
    const url = encodeURIComponent(getShareUrl());
    window.open(`https://x.com/intent/tweet?text=${text}&url=${url}`, '_blank', 'noopener,noreferrer,width=550,height=420');
  }

  function shareOnLinkedIn() {
    const url = encodeURIComponent(getShareUrl());
    window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${url}`, '_blank', 'noopener,noreferrer,width=550,height=420');
  }

  function shareOnBluesky() {
    const text = encodeURIComponent(getShareText() + ' ' + getShareUrl());
    window.open(`https://bsky.app/intent/compose?text=${text}`, '_blank', 'noopener,noreferrer,width=550,height=520');
  }

  /* -----------------------------------------------------------------------
     SHAREABLE IMAGE GENERATION (Canvas API)
     Generates a receipt-style image for TikTok, Instagram, LinkedIn, etc.
     ----------------------------------------------------------------------- */
  function generateShareImage() {
    if (state.works.length === 0) {
      showToast('No data to generate image from.');
      return;
    }

    const agg = aggregateData(state.works);
    const name = state.researcherName || `ORCID ${state.orcid}`;
    const total = formatCurrency(agg.totalUSD);
    const knownTotal = formatCurrency(agg.totals.known);
    const worksCount = state.works.length;
    const knownCount = agg.counts.known;
    const unknownCount = agg.counts.unknown;
    const dateRange = agg.dateRange ? `${agg.dateRange.min} - ${agg.dateRange.max}` : 'N/A';
    const knownPct = worksCount > 0 ? Math.round((knownCount / worksCount) * 100) : 0;
    const ouchFactor = agg.totalUSD < 5000 ? 'Low' : agg.totalUSD < 20000 ? 'Medium' : agg.totalUSD < 50000 ? 'High' : 'Extreme';
    const ouchEmoji = agg.totalUSD < 5000 ? '' : agg.totalUSD < 20000 ? '' : agg.totalUSD < 50000 ? '' : '';

    // Canvas: 1080x1080 (square, works on all platforms)
    const W = 1080;
    const H = 1080;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const MX = 90; // horizontal margin

    // Helpers
    const sans = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
    const mono = '"SF Mono", Menlo, Consolas, "Courier New", monospace';

    // -- Background --
    ctx.fillStyle = '#FAFAFA';
    ctx.fillRect(0, 0, W, H);

    // Subtle receipt paper texture: vertical side lines
    ctx.fillStyle = '#F0EFEA';
    ctx.fillRect(0, 0, 48, H);
    ctx.fillRect(W - 48, 0, 48, H);

    // Top accent stripe
    ctx.fillStyle = '#0071E3';
    ctx.fillRect(0, 0, W, 6);

    // -- Brand --
    let y = 56;
    ctx.fillStyle = '#AEAEB2';
    ctx.font = `700 14px ${sans}`;
    ctx.letterSpacing = '3px';
    ctx.textAlign = 'center';
    ctx.fillText('CITE & SPEND', W / 2, y);

    y += 22;
    ctx.font = `400 14px ${sans}`;
    ctx.letterSpacing = '0px';
    ctx.fillText('Article Processing Charge Receipt', W / 2, y);

    // -- Separator --
    y += 28;
    drawDashedLine(ctx, MX, y, W - MX, y, '#D1D1D6');

    // -- Name --
    y += 36;
    ctx.fillStyle = '#1D1D1F';
    ctx.font = `700 32px ${sans}`;
    const nameLines = wrapText(ctx, name, W - MX * 2 - 20);
    nameLines.forEach((line) => {
      ctx.fillText(line, W / 2, y);
      y += 40;
    });

    // -- ORCID --
    y += 4;
    ctx.fillStyle = '#8E8E93';
    ctx.font = `500 16px ${mono}`;
    ctx.fillText(state.orcid, W / 2, y);

    // -- Big total --
    y += 56;
    ctx.fillStyle = '#1D1D1F';
    ctx.font = `800 64px ${mono}`;
    ctx.fillText(total, W / 2, y);

    y += 24;
    ctx.fillStyle = '#8E8E93';
    ctx.font = `500 15px ${sans}`;
    ctx.fillText('Total known APC spend (USD)', W / 2, y);

    // -- Breakdown bar --
    y += 36;
    const barX = MX + 40;
    const barW = W - MX * 2 - 80;
    const barH = 14;
    const knownW = worksCount > 0 ? (knownCount / worksCount) * barW : 0;

    // Bar background
    roundRect(ctx, barX, y, barW, barH, 7, '#E5E5EA');
    // Known
    if (knownW > 0) roundRect(ctx, barX, y, knownW, barH, 7, '#34C759');

    // Bar legend
    y += barH + 20;
    ctx.font = `600 12px ${sans}`;
    ctx.textAlign = 'left';
    // Known dot + label
    ctx.fillStyle = '#34C759';
    ctx.beginPath(); ctx.arc(barX + 5, y - 4, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6E6E73';
    ctx.fillText(`Known (${knownCount})`, barX + 16, y);
    // Unknown dot + label
    const uX = barX + 140;
    ctx.fillStyle = '#C7C7CC';
    ctx.beginPath(); ctx.arc(uX + 5, y - 4, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6E6E73';
    ctx.fillText(`Unknown (${unknownCount})`, uX + 16, y);

    // -- Separator --
    y += 28;
    drawDashedLine(ctx, MX, y, W - MX, y, '#D1D1D6');

    // -- Line items --
    y += 32;
    const lineX = MX + 20;
    const valX = W - MX - 20;
    const lineH = 42;

    const items = [
      ['Works analyzed', `${worksCount}`],
      ['Date range', dateRange],
      ['Known fees (APC paid / list price)', knownTotal],
      [`Fee coverage`, `${knownPct}% of works`],
    ];

    items.forEach(([label, value]) => {
      ctx.fillStyle = '#6E6E73';
      ctx.font = `400 18px ${sans}`;
      ctx.textAlign = 'left';
      ctx.fillText(label, lineX, y);

      ctx.fillStyle = '#1D1D1F';
      ctx.font = `600 18px ${mono}`;
      ctx.textAlign = 'right';
      ctx.fillText(value, valX, y);

      y += lineH;
    });

    // -- Double separator --
    y += 6;
    drawDashedLine(ctx, MX, y, W - MX, y, '#C7C7CC');
    y += 5;
    drawDashedLine(ctx, MX, y, W - MX, y, '#C7C7CC');

    // -- Total line --
    y += 36;
    ctx.fillStyle = '#1D1D1F';
    ctx.font = `700 24px ${sans}`;
    ctx.textAlign = 'left';
    ctx.fillText('TOTAL', lineX, y);
    ctx.font = `700 24px ${mono}`;
    ctx.textAlign = 'right';
    ctx.fillText(total, valX, y);

    // -- Ouch factor --
    y += 42;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8E8E93';
    ctx.font = `600 16px ${sans}`;
    ctx.fillText(`Ouch factor: ${ouchFactor}`, W / 2, y);

    // -- Footer --
    y += 20;
    drawDashedLine(ctx, MX, y, W - MX, y, '#E5E5EA');

    y += 28;
    ctx.fillStyle = '#AEAEB2';
    ctx.font = `400 13px ${sans}`;
    ctx.fillText('Data: OpenAlex  |  ezefranca.com/academicspend', W / 2, y);
    y += 20;
    ctx.fillText('Estimates only. Not financial advice. See full disclaimer on site.', W / 2, y);
    y += 20;
    ctx.fillText(`Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, W / 2, y);

    // -- Download --
    canvas.toBlob((blob) => {
      if (!blob) {
        showToast('Could not generate image.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cite-and-spend-${state.orcid}.png`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Image downloaded. Share it on social media!');
    }, 'image/png');
  }

  function roundRect(ctx, x, y, w, h, r, fill) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function drawDashedLine(ctx, x1, y1, x2, y2, color) {
    ctx.beginPath();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /* -----------------------------------------------------------------------
     EVENT BINDING
     ----------------------------------------------------------------------- */
  function bindEvents() {
    // Form submit
    $('#orcid-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const val = $('#orcid-input').value.trim();
      if (val) generateReceipt(val);
    });

    // Example button
    $('#example-btn').addEventListener('click', () => {
      $('#orcid-input').value = CONFIG.exampleOrcid;
      $('#orcid-input').focus();
    });

    // Theme toggle
    $('#theme-toggle').addEventListener('click', toggleTheme);

    // Sort buttons
    $$('.sort-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.sort;
        if (state.sortField === field) {
          state.sortAsc = !state.sortAsc;
        } else {
          state.sortField = field;
          state.sortAsc = field === 'title' || field === 'venue';
        }
        applyFilters();
      });
    });

    // Filters
    $('#filter-search').addEventListener('input', debounce(applyFilters, 300));
    $('#filter-year-from').addEventListener('change', applyFilters);
    $('#filter-year-to').addEventListener('change', applyFilters);
    $('#filter-oa-only').addEventListener('change', applyFilters);
    $('#filter-known-only').addEventListener('change', applyFilters);

    // Clear filters
    $('#clear-filters').addEventListener('click', () => {
      $('#filter-search').value = '';
      $('#filter-year-from').value = '';
      $('#filter-year-to').value = '';
      $('#filter-oa-only').checked = false;
      $('#filter-known-only').checked = false;
      applyFilters();
    });

    // Receipt collapse toggle
    $('#btn-toggle-receipt').addEventListener('click', () => {
      const body = $('#receipt-body');
      const btn = $('#btn-toggle-receipt');
      const wrapper = btn.closest('.receipt-wrapper') || btn.closest('.receipt-header');
      const isCollapsed = body.classList.toggle('collapsed');

      btn.setAttribute('aria-expanded', !isCollapsed);
      btn.querySelector('span').textContent = isCollapsed ? 'Expand' : 'Collapse';

      // Rotate chevron
      const header = btn.closest('.receipt-header');
      if (header) header.classList.toggle('receipt-collapsed', isCollapsed);
    });

    // Social share buttons
    $('#btn-share-x').addEventListener('click', shareOnX);
    $('#btn-share-linkedin').addEventListener('click', shareOnLinkedIn);
    $('#btn-share-bluesky').addEventListener('click', shareOnBluesky);
    $('#btn-share-image').addEventListener('click', generateShareImage);

    // Actions
    $('#btn-share').addEventListener('click', copyShareLink);
    $('#btn-csv').addEventListener('click', exportCSV);
    $('#btn-json').addEventListener('click', exportJSON);
    $('#btn-refresh').addEventListener('click', () => {
      if (state.orcid) {
        generateReceipt(state.orcid, true);
        showToast('Refreshing data from OpenAlex...');
      }
    });

    // Currency toggle
    $('#currency-convert').addEventListener('change', (e) => {
      state.convertCurrency = e.target.checked;
      if (state.works.length > 0) {
        renderLedger(state.filteredWorks);
      }
    });

    // Input validation
    $('#orcid-input').addEventListener('input', () => {
      clearError();
    });
  }

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  /* -----------------------------------------------------------------------
     WIDGET / EMBED GENERATOR
     ----------------------------------------------------------------------- */
  function updateWidgetGenerator() {
    const orcid = state.orcid;
    if (!orcid) return;

    const section = $('#widget-section');
    if (section) section.style.display = 'block';

    const baseUrl = window.location.origin + window.location.pathname;
    const style = $('#widget-style')?.value || 'card';
    const theme = $('#widget-theme')?.value || 'auto';

    // API endpoint display
    const browserUrl = `${baseUrl}?format=json&orcid=${orcid}`;
    const apiEl = $('#api-endpoint');
    if (apiEl) apiEl.textContent = browserUrl;

    // Generate embed code based on style
    const shareUrl = `${baseUrl}?orcid=${orcid}`;
    const agg = state.works.length > 0 ? aggregateData(state.works) : null;
    const name = state.researcherName || `ORCID ${orcid}`;
    const total = agg ? formatCurrency(agg.totalUSD) : '$--';
    const worksCount = state.works.length;

    let embedCode = '';
    let previewHTML = '';

    if (style === 'badge') {
      // Compact badge
      embedCode = `<a href="${shareUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:${theme === 'dark' ? '#2c2c2e' : '#f5f5f7'};border:1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'};border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;font-weight:600;color:${theme === 'dark' ? '#f5f5f7' : '#1d1d1f'};text-decoration:none;" title="View APC report on Cite &amp; Spend"><span style="font-size:10px;color:${theme === 'dark' ? '#86868b' : '#6e6e73'};">APC Spend:</span> <span style="font-family:'SF Mono',Menlo,monospace;">${escapeHTML(total)}</span> <span style="font-size:9px;color:#86868b;">via Cite&amp;Spend</span></a>`;

      previewHTML = `<a href="${shareUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:8px;font-size:13px;font-weight:600;color:var(--text-primary);text-decoration:none;"><span style="font-size:10px;color:var(--text-tertiary);">APC Spend:</span> <span style="font-family:var(--font-mono);">${escapeHTML(total)}</span> <span style="font-size:9px;color:var(--text-tertiary);">via Cite&amp;Spend</span></a>`;

    } else if (style === 'full') {
      // Full card with mini chart placeholder
      const knownPct = worksCount > 0 && agg ? Math.round((agg.counts.known / worksCount) * 100) : 0;
      embedCode = `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;border:1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'};border-radius:16px;padding:20px 24px;background:${theme === 'dark' ? '#2c2c2e' : '#ffffff'};max-width:360px;color:${theme === 'dark' ? '#f5f5f7' : '#1d1d1f'};"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#86868b;margin-bottom:4px;">Estimated APC Spend</div><div style="font-size:14px;font-weight:600;margin-bottom:4px;">${escapeHTML(name)}</div><div style="font-size:32px;font-weight:700;font-family:'SF Mono',Menlo,monospace;letter-spacing:-0.02em;">${escapeHTML(total)}</div><div style="font-size:12px;color:#86868b;margin:8px 0;">${worksCount} works | ${knownPct}% with fee data</div><div style="height:8px;background:${theme === 'dark' ? '#3a3a3c' : '#f0f0f0'};border-radius:4px;overflow:hidden;margin-bottom:12px;"><div style="height:100%;width:${knownPct}%;background:#34c759;border-radius:4px;"></div></div><a href="${shareUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:8px 16px;background:#0071e3;color:white;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none;">View full report</a><div style="font-size:9px;color:#86868b;margin-top:8px;">Powered by Cite &amp; Spend + OpenAlex</div></div>`;

      previewHTML = embedCode.replace(/#2c2c2e/g, 'var(--bg-card-solid)').replace(/#ffffff/g, 'var(--bg-card-solid)');

    } else {
      // Default card
      embedCode = `<a href="${shareUrl}" target="_blank" rel="noopener noreferrer" style="display:block;font-family:-apple-system,BlinkMacSystemFont,sans-serif;border:1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'};border-radius:12px;padding:16px 20px;background:${theme === 'dark' ? '#2c2c2e' : '#ffffff'};max-width:320px;text-decoration:none;color:${theme === 'dark' ? '#f5f5f7' : '#1d1d1f'};"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#86868b;margin-bottom:4px;">Estimated APC Spend</div><div style="font-size:16px;font-weight:600;margin-bottom:2px;">${escapeHTML(name)}</div><div style="font-size:24px;font-weight:700;font-family:'SF Mono',Menlo,monospace;letter-spacing:-0.02em;">${escapeHTML(total)}</div><div style="font-size:11px;color:#86868b;margin-top:4px;">${worksCount} works analyzed</div><div style="font-size:10px;color:#86868b;margin-top:8px;padding-top:8px;border-top:1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'};">Cite &amp; Spend + OpenAlex</div></a>`;

      previewHTML = embedCode.replace(/#2c2c2e/g, 'var(--bg-card-solid)').replace(/#ffffff/g, 'var(--bg-card-solid)');
    }

    // Update code display
    const codeEl = $('#widget-code');
    if (codeEl) codeEl.textContent = embedCode;

    // Update preview
    const previewFrame = $('#widget-preview-frame');
    if (previewFrame) previewFrame.innerHTML = previewHTML;
  }

  function bindWidgetEvents() {
    const styleSelect = $('#widget-style');
    const themeSelect = $('#widget-theme');
    const copyWidgetBtn = $('#btn-copy-widget');
    const copyApiBtn = $('#btn-copy-api');

    if (styleSelect) styleSelect.addEventListener('change', updateWidgetGenerator);
    if (themeSelect) themeSelect.addEventListener('change', updateWidgetGenerator);

    if (copyWidgetBtn) {
      copyWidgetBtn.addEventListener('click', () => {
        const code = $('#widget-code')?.textContent || '';
        navigator.clipboard.writeText(code).then(() => {
          showToast('Widget code copied to clipboard.');
        }).catch(() => {
          showToast('Could not copy code.');
        });
      });
    }

    if (copyApiBtn) {
      copyApiBtn.addEventListener('click', () => {
        const code = $('#api-endpoint')?.textContent || '';
        navigator.clipboard.writeText(code).then(() => {
          showToast('API endpoint copied to clipboard.');
        }).catch(() => {
          showToast('Could not copy endpoint.');
        });
      });
    }

    const downloadJsonBtn = $('#btn-download-json-api');
    if (downloadJsonBtn) {
      downloadJsonBtn.addEventListener('click', () => {
        if (!state.works || state.works.length === 0) {
          showToast('Generate a receipt first.');
          return;
        }
        exportJSON();
      });
    }
  }

  /* -----------------------------------------------------------------------
     INIT
     ----------------------------------------------------------------------- */
  function init() {
    // Check for API mode first (?format=json&orcid=...)
    const format = getFormatFromURL();
    const urlOrcid = getOrcidFromURL();

    if (format === 'json' && urlOrcid) {
      handleAPIMode(urlOrcid);
      return; // Do not render normal UI
    }

    initTheme();
    initSEODefaults();
    bindEvents();
    bindWidgetEvents();

    // Initialize Lucide icons, then reveal page
    function revealPage() {
      document.body.classList.add('ready');
    }

    if (window.lucide) {
      lucide.createIcons();
      revealPage();
    } else {
      const interval = setInterval(() => {
        if (window.lucide) {
          lucide.createIcons();
          clearInterval(interval);
          revealPage();
        }
      }, 100);
      // Reveal anyway after 2s even if Lucide fails to load
      setTimeout(() => { clearInterval(interval); revealPage(); }, 2000);
    }

    // Check URL for ORCID
    if (urlOrcid) {
      $('#orcid-input').value = urlOrcid;
      generateReceipt(urlOrcid);
    }
  }

  /**
   * Set default SEO meta values using the current page URL
   */
  function initSEODefaults() {
    const baseUrl = window.location.origin + window.location.pathname;
    // Ensure trailing slash for correct relative paths
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    setMetaById('og-url', 'content', base);
    setMetaById('og-image', 'content', base + 'assets/icons/og-image.svg');
    setMetaById('tw-image', 'content', base + 'assets/icons/og-image.svg');
    const canonical = document.getElementById('canonical-link');
    if (canonical) canonical.setAttribute('href', base);
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
