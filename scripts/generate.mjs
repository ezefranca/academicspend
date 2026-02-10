#!/usr/bin/env node
/**
 * Cite & Spend — Static JSON generator
 *
 * Fetches works from OpenAlex for given ORCID(s), processes APC data,
 * and writes JSON files to api/{orcid}.json for static hosting.
 *
 * Usage:
 *   node scripts/generate.mjs 0000-0002-1825-0097
 *   node scripts/generate.mjs 0000-0002-1825-0097 0000-0003-4658-5844
 *   node scripts/generate.mjs --all          # regenerate all existing api/*.json
 */

import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

const OPENALEX = 'https://api.openalex.org';
const MAILTO = 'citeandspend@example.com';
const MAX_WORKS = 2000;
const PER_PAGE = 200;
const API_DIR = join(import.meta.dirname, '..', 'api');

const EXCHANGE_TO_USD = {
  USD: 1, EUR: 1.09, GBP: 1.27, CHF: 1.15, CAD: 0.74, AUD: 0.65,
  JPY: 0.0065, CNY: 0.14, KRW: 0.00073, INR: 0.012, SEK: 0.096,
  NOK: 0.094, DKK: 0.146, PLN: 0.25, BRL: 0.17, MXN: 0.058,
  SGD: 0.74, NZD: 0.60,
};
const EXCHANGE_DATE = '2025-01-15';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeOrcid(raw) {
  const stripped = raw.replace(/[\s-]/g, '').toUpperCase();
  if (stripped.length === 16 && /^\d{15}[\dX]$/.test(stripped)) {
    return `${stripped.slice(0, 4)}-${stripped.slice(4, 8)}-${stripped.slice(8, 12)}-${stripped.slice(12, 16)}`;
  }
  return null;
}

function convertToUSD(amount, currency) {
  const rate = EXCHANGE_TO_USD[currency.toUpperCase()];
  return rate ? Math.round(amount * rate) : amount;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function oaFetch(url, attempt = 0) {
  const res = await fetch(url, {
    headers: { 'User-Agent': `CiteAndSpend/1.0 (generator; mailto:${MAILTO})` },
  });
  if (res.status === 429 && attempt < 3) {
    const delay = 1000 * Math.pow(2, attempt);
    console.log(`  Rate limited, retrying in ${delay}ms...`);
    await sleep(delay);
    return oaFetch(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`OpenAlex ${res.status} for ${url}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Author resolution
// ---------------------------------------------------------------------------

async function resolveAuthor(orcid) {
  const orcidUrl = `https://orcid.org/${orcid}`;

  // Strategy A
  try {
    const data = await oaFetch(`${OPENALEX}/authors/${orcidUrl}?mailto=${MAILTO}`);
    if (data?.id) {
      return { id: data.id, idShort: data.id.replace('https://openalex.org/', ''), name: data.display_name || '', worksCount: data.works_count || 0 };
    }
  } catch { /* try B */ }

  // Strategy B
  try {
    const data = await oaFetch(`${OPENALEX}/authors?filter=orcid:${orcid}&mailto=${MAILTO}`);
    if (data?.results?.length > 0) {
      const a = data.results[0];
      return { id: a.id, idShort: a.id.replace('https://openalex.org/', ''), name: a.display_name || '', worksCount: a.works_count || 0 };
    }
  } catch { /* try C */ }

  return null;
}

async function resolveAuthorByName(orcid) {
  try {
    const res = await fetch(`https://pub.orcid.org/v3.0/${orcid}/person`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const person = await res.json();
    const given = person?.name?.['given-names']?.value || '';
    const family = person?.name?.['family-name']?.value || '';
    const credit = person?.name?.['credit-name']?.value || '';
    const fullName = credit || `${given} ${family}`.trim();
    if (!fullName) return null;

    const data = await oaFetch(`${OPENALEX}/authors?search=${encodeURIComponent(fullName)}&mailto=${MAILTO}`);
    if (data?.results?.length > 0) {
      const a = data.results[0];
      return {
        id: a.id, idShort: a.id.replace('https://openalex.org/', ''),
        name: a.display_name || fullName, worksCount: a.works_count || 0,
        warning: 'Matched by name (ORCID not linked in OpenAlex). Author disambiguation may be imperfect.',
      };
    }
  } catch { /* failed */ }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch works
// ---------------------------------------------------------------------------

async function fetchWorks(filter) {
  const works = [];
  let cursor = '*';
  let totalCount = 0;

  while (cursor && works.length < MAX_WORKS) {
    const url = `${OPENALEX}/works?filter=${filter}&per-page=${PER_PAGE}&cursor=${cursor}&sort=publication_year:desc&mailto=${MAILTO}`;
    const data = await oaFetch(url);

    if (works.length === 0) {
      totalCount = data.meta?.count || 0;
      if (totalCount === 0) break;
    }

    works.push(...(data.results || []));
    cursor = data.meta?.next_cursor || null;
    process.stdout.write(`  ${works.length}/${Math.min(totalCount, MAX_WORKS)} works\r`);
  }
  console.log();

  return { works, totalCount };
}

// ---------------------------------------------------------------------------
// APC analysis
// ---------------------------------------------------------------------------

function analyzeAPC(work) {
  const oaStatus = work.open_access?.oa_status || 'unknown';
  const isOA = work.open_access?.is_oa || false;

  if (work.apc_paid?.value > 0) {
    const currency = work.apc_paid.currency || 'USD';
    return {
      signal: 'known', amount: work.apc_paid.value, currency,
      amountUSD: work.apc_paid.value_usd || convertToUSD(work.apc_paid.value, currency),
      confidence: 0.9, source: `APC paid (${work.apc_paid.provenance || 'OpenAlex'})`,
      oaStatus, isOA,
    };
  }

  if (work.apc_list?.value > 0 && (oaStatus === 'gold' || oaStatus === 'hybrid')) {
    const currency = work.apc_list.currency || 'USD';
    return {
      signal: 'known', amount: work.apc_list.value, currency,
      amountUSD: work.apc_list.value_usd || convertToUSD(work.apc_list.value, currency),
      confidence: 0.7, source: `List price (${work.apc_list.provenance || 'DOAJ via OpenAlex'})`,
      oaStatus, isOA,
    };
  }

  return { signal: 'unknown', amount: 0, currency: 'USD', amountUSD: 0, confidence: 0, source: 'No fee data available', oaStatus, isOA };
}

function getPublisher(work) {
  return work.primary_location?.source?.host_organization_name || work.primary_location?.source?.display_name || '';
}

// ---------------------------------------------------------------------------
// Generate JSON for one ORCID
// ---------------------------------------------------------------------------

async function generateForOrcid(orcid) {
  console.log(`\nProcessing ${orcid}...`);

  let author = await resolveAuthor(orcid);
  let warning = '';
  let filter;

  if (author) {
    filter = `authorships.author.id:${author.idShort}`;
    console.log(`  Found: ${author.name} (${author.worksCount} works)`);
  } else {
    filter = `author.orcid:https://orcid.org/${orcid}`;
    console.log('  Author not found directly, trying works by ORCID...');
  }

  let { works: rawWorks, totalCount } = await fetchWorks(filter);

  // Strategy D: name fallback
  if (rawWorks.length === 0 && !author) {
    console.log('  No works found. Trying name lookup from ORCID...');
    const nameAuthor = await resolveAuthorByName(orcid);
    if (nameAuthor) {
      author = nameAuthor;
      warning = nameAuthor.warning || '';
      console.log(`  Name match: ${nameAuthor.name}`);
      const result = await fetchWorks(`authorships.author.id:${nameAuthor.idShort}`);
      rawWorks = result.works;
      totalCount = result.totalCount;
    }
  }

  if (rawWorks.length === 0) {
    console.log('  No works found. Skipping.');
    return null;
  }

  // Extract author name from works if needed
  let authorName = author?.name || '';
  if (!authorName && rawWorks.length > 0) {
    const authorship = rawWorks[0].authorships?.find(a => a.author?.orcid?.replace('https://orcid.org/', '') === orcid);
    if (authorship) authorName = authorship.author?.display_name || '';
  }

  // Process works
  const works = rawWorks.map(work => {
    const apc = analyzeAPC(work);
    const doi = work.doi || '';
    return {
      year: work.publication_year || 0,
      title: work.title || work.display_name || 'Untitled',
      doi: doi.startsWith('https://') ? doi : (doi ? `https://doi.org/${doi}` : null),
      venue: work.primary_location?.source?.display_name || 'Unknown venue',
      publisher: getPublisher(work),
      oaStatus: apc.oaStatus,
      feeSignal: apc.signal,
      amount: apc.amount,
      currency: apc.currency,
      amountUSD: apc.amountUSD,
      confidence: apc.confidence,
      sourceNote: apc.source,
    };
  });

  // Aggregate
  const totals = { known: 0, unknown: 0 };
  const counts = { known: 0, unknown: 0 };
  const byYear = {};
  const byPublisher = {};
  const currencies = {};
  let minYear = Infinity, maxYear = -Infinity;

  works.forEach(w => {
    totals[w.feeSignal] += (w.amountUSD || 0);
    counts[w.feeSignal]++;
    if (w.currency && w.amount > 0) currencies[w.currency] = (currencies[w.currency] || 0) + w.amount;
    if (w.year) {
      if (!byYear[w.year]) byYear[w.year] = { known: 0 };
      byYear[w.year].known += (w.feeSignal === 'known' ? w.amountUSD || 0 : 0);
      if (w.year < minYear) minYear = w.year;
      if (w.year > maxYear) maxYear = w.year;
    }
    if (w.publisher) byPublisher[w.publisher] = (byPublisher[w.publisher] || 0) + (w.amountUSD || 0);
  });

  const dateRange = minYear !== Infinity ? { min: minYear, max: maxYear } : null;

  const response = {
    meta: {
      api: 'Cite & Spend',
      version: '1.0.0',
      disclaimer: 'APC data comes from OpenAlex (apc_paid / apc_list from DOAJ). No fabricated estimates.',
      generatedAt: new Date().toISOString(),
      dataSource: 'OpenAlex (https://openalex.org)',
      orcid,
      researcherName: authorName || null,
      worksCount: works.length,
      totalCount,
      capped: totalCount > MAX_WORKS,
      capLimit: MAX_WORKS,
      warning: warning || undefined,
      htmlUrl: `https://ezefranca.com/academicspend/?orcid=${orcid}`,
    },
    summary: {
      totalKnownAPC_USD: Math.round(totals.known),
      worksWithKnownFees: counts.known,
      worksWithUnknownFees: counts.unknown,
      dateRange,
      currencyBreakdown: currencies,
      exchangeRatesDate: EXCHANGE_DATE,
    },
    spendByYear: Object.entries(byYear)
      .map(([year, vals]) => ({ year: parseInt(year), known_USD: Math.round(vals.known) }))
      .sort((a, b) => a.year - b.year),
    topPublishers: Object.entries(byPublisher)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, total]) => ({ publisher: name, totalAPC_USD: Math.round(total) })),
    works,
  };

  // Write JSON file
  await mkdir(API_DIR, { recursive: true });
  const filePath = join(API_DIR, `${orcid}.json`);
  await writeFile(filePath, JSON.stringify(response, null, 2));
  console.log(`  Written: api/${orcid}.json (${works.length} works, $${Math.round(totals.known)} known APC)`);

  return response;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node scripts/generate.mjs <orcid> [orcid2] ...');
    console.log('       node scripts/generate.mjs --all');
    process.exit(1);
  }

  let orcids;

  if (args[0] === '--all') {
    // Regenerate all existing api/*.json files
    try {
      const files = await readdir(API_DIR);
      orcids = files
        .filter(f => f.endsWith('.json') && f !== 'index.json')
        .map(f => basename(f, '.json'));
      if (orcids.length === 0) {
        console.log('No existing JSON files in api/. Provide ORCIDs as arguments.');
        process.exit(1);
      }
      console.log(`Regenerating ${orcids.length} existing endpoints...`);
    } catch {
      console.log('No api/ directory found. Provide ORCIDs as arguments.');
      process.exit(1);
    }
  } else {
    orcids = args.map(a => normalizeOrcid(a)).filter(Boolean);
    if (orcids.length === 0) {
      console.error('No valid ORCIDs provided.');
      process.exit(1);
    }
  }

  const results = [];
  for (const orcid of orcids) {
    try {
      const result = await generateForOrcid(orcid);
      if (result) results.push({ orcid, name: result.meta.researcherName, total: result.summary.totalKnownAPC_USD });
    } catch (err) {
      console.error(`  Error for ${orcid}: ${err.message}`);
    }
    // Be polite to OpenAlex
    if (orcids.length > 1) await sleep(500);
  }

  // Write index.json
  if (results.length > 0) {
    try {
      const files = await readdir(API_DIR);
      const index = files
        .filter(f => f.endsWith('.json') && f !== 'index.json')
        .map(f => {
          const id = basename(f, '.json');
          const match = results.find(r => r.orcid === id);
          return {
            orcid: id,
            name: match?.name || null,
            totalKnownAPC_USD: match?.total || null,
            url: `api/${f}`,
          };
        });
      await writeFile(join(API_DIR, 'index.json'), JSON.stringify({ endpoints: index, generatedAt: new Date().toISOString() }, null, 2));
      console.log(`\nWritten: api/index.json (${index.length} endpoints)`);
    } catch { /* skip index */ }
  }

  console.log('\nDone.');
}

main();
