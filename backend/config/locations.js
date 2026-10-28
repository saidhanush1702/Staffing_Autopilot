/**
 * ── WHERE A JOB IS, AND WHETHER THAT IS A PROBLEM ─────────────────────
 *
 * v1 asked one question of a job's location: does the text contain the
 * consultant's city or state? On a live pool that rejected 72 % of everything
 * it saw. It could not know that "TX" is Texas, that Irving is Dallas, that a
 * role is remote because its description says so, or that a consultant would
 * move for it — and `radius_miles`, which recruiters were already entering, was
 * never read.
 *
 * This answers the real question, which is not "do the words match" but "could
 * this person actually do this job from where they are, or where they would go?"
 *
 *   REMOTE    the job does not need them anywhere in particular
 *   LOCAL     same city, or the same metro area
 *   NEAR      within the radius they gave (or 35 miles when they gave none)
 *   STATE     same state, further than that — a stretch, not a no
 *   RELOCATE  elsewhere, and they said they would move
 *   UNKNOWN   the posting does not say where; not held against anyone
 *   FAR       elsewhere, on-site or hybrid, and they will not move — the only
 *             answer that rejects a job outright
 *
 * ── PURE, AND OFFLINE ─────────────────────────────────────────────────
 *
 * No geocoding call on the hot path. A job arriving by webhook must be answered
 * quickly, and a network lookup per posting per consultant is neither fast nor
 * free. A table of the metros staffing actually places people in does the work;
 * a place it does not know falls back to state and text, never to a guess about
 * distance.
 */
import { norm } from './jobMatcher.js';

/* ── states ───────────────────────────────────────────────────────────── */

const STATES = {
    al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
    ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho',
    il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana',
    me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
    ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada',
    nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina',
    nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
    ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas',
    ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia',
    wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia',
    // India, where this agency also places people.
    ts: 'telangana', ka: 'karnataka', tn_in: 'tamil nadu', mh: 'maharashtra', dl: 'delhi',
};
const STATE_NAMES = new Set(Object.values(STATES));
const ABBREVIATIONS = Object.fromEntries(Object.entries(STATES).filter(([k]) => !k.includes('_')));

/** "TX", "tx" or "Texas" → "texas". Null for anything that is not a state. */
export const stateOf = (text) => {
    const t = norm(text).replace(/\./g, '');
    if (!t) return null;
    if (STATE_NAMES.has(t)) return t;
    return ABBREVIATIONS[t] ?? null;
};

/* ── metros: name, state, lat, lon, metro key ─────────────────────────── */

// [city, state, lat, lon, metro]
const CITIES = [
    // Dallas–Fort Worth
    ['dallas', 'texas', 32.78, -96.80, 'dfw'], ['irving', 'texas', 32.81, -96.95, 'dfw'],
    ['plano', 'texas', 33.02, -96.70, 'dfw'], ['frisco', 'texas', 33.15, -96.82, 'dfw'],
    ['richardson', 'texas', 32.95, -96.73, 'dfw'], ['garland', 'texas', 32.91, -96.64, 'dfw'],
    ['fort worth', 'texas', 32.76, -97.33, 'dfw'], ['arlington', 'texas', 32.74, -97.11, 'dfw'],
    ['mckinney', 'texas', 33.20, -96.64, 'dfw'], ['addison', 'texas', 32.96, -96.83, 'dfw'],
    ['southlake', 'texas', 32.94, -97.13, 'dfw'], ['coppell', 'texas', 32.95, -97.02, 'dfw'],
    // Austin / Houston / San Antonio
    ['austin', 'texas', 30.27, -97.74, 'austin'], ['round rock', 'texas', 30.51, -97.68, 'austin'],
    ['cedar park', 'texas', 30.51, -97.82, 'austin'],
    ['houston', 'texas', 29.76, -95.37, 'houston'], ['sugar land', 'texas', 29.62, -95.63, 'houston'],
    ['the woodlands', 'texas', 30.16, -95.46, 'houston'], ['katy', 'texas', 29.79, -95.82, 'houston'],
    ['san antonio', 'texas', 29.42, -98.49, 'sanantonio'],
    // New York area
    ['new york', 'new york', 40.71, -74.01, 'nyc'], ['brooklyn', 'new york', 40.68, -73.94, 'nyc'],
    ['jersey city', 'new jersey', 40.73, -74.06, 'nyc'], ['newark', 'new jersey', 40.74, -74.17, 'nyc'],
    ['hoboken', 'new jersey', 40.74, -74.03, 'nyc'], ['stamford', 'connecticut', 41.05, -73.54, 'nyc'],
    ['edison', 'new jersey', 40.52, -74.41, 'nyc'], ['princeton', 'new jersey', 40.36, -74.67, 'nyc'],
    // Bay Area
    ['san francisco', 'california', 37.77, -122.42, 'bayarea'], ['san jose', 'california', 37.34, -121.89, 'bayarea'],
    ['oakland', 'california', 37.80, -122.27, 'bayarea'], ['palo alto', 'california', 37.44, -122.14, 'bayarea'],
    ['mountain view', 'california', 37.39, -122.08, 'bayarea'], ['sunnyvale', 'california', 37.37, -122.04, 'bayarea'],
    ['santa clara', 'california', 37.35, -121.96, 'bayarea'], ['fremont', 'california', 37.55, -121.99, 'bayarea'],
    ['menlo park', 'california', 37.45, -122.18, 'bayarea'], ['redwood city', 'california', 37.49, -122.24, 'bayarea'],
    // LA / San Diego
    ['los angeles', 'california', 34.05, -118.24, 'la'], ['irvine', 'california', 33.68, -117.83, 'la'],
    ['santa monica', 'california', 34.02, -118.49, 'la'], ['san diego', 'california', 32.72, -117.16, 'sandiego'],
    // Seattle
    ['seattle', 'washington', 47.61, -122.33, 'seattle'], ['bellevue', 'washington', 47.61, -122.20, 'seattle'],
    ['redmond', 'washington', 47.67, -122.12, 'seattle'],
    // Washington DC
    ['washington', 'district of columbia', 38.91, -77.04, 'dc'], ['reston', 'virginia', 38.97, -77.34, 'dc'],
    ['mclean', 'virginia', 38.93, -77.18, 'dc'], ['bethesda', 'maryland', 38.98, -77.10, 'dc'],
    ['herndon', 'virginia', 38.97, -77.39, 'dc'], ['tysons', 'virginia', 38.92, -77.22, 'dc'],
    // Others
    ['atlanta', 'georgia', 33.75, -84.39, 'atlanta'], ['alpharetta', 'georgia', 34.08, -84.29, 'atlanta'],
    ['chicago', 'illinois', 41.88, -87.63, 'chicago'], ['naperville', 'illinois', 41.79, -88.15, 'chicago'],
    ['schaumburg', 'illinois', 42.03, -88.08, 'chicago'],
    ['boston', 'massachusetts', 42.36, -71.06, 'boston'], ['cambridge', 'massachusetts', 42.37, -71.11, 'boston'],
    ['waltham', 'massachusetts', 42.38, -71.24, 'boston'],
    ['charlotte', 'north carolina', 35.23, -80.84, 'charlotte'], ['raleigh', 'north carolina', 35.78, -78.64, 'raleigh'],
    ['durham', 'north carolina', 35.99, -78.90, 'raleigh'], ['cary', 'north carolina', 35.79, -78.78, 'raleigh'],
    ['phoenix', 'arizona', 33.45, -112.07, 'phoenix'], ['tempe', 'arizona', 33.43, -111.94, 'phoenix'],
    ['denver', 'colorado', 39.74, -104.99, 'denver'], ['miami', 'florida', 25.76, -80.19, 'miami'],
    ['tampa', 'florida', 27.95, -82.46, 'tampa'], ['orlando', 'florida', 28.54, -81.38, 'orlando'],
    ['minneapolis', 'minnesota', 44.98, -93.27, 'minneapolis'], ['detroit', 'michigan', 42.33, -83.05, 'detroit'],
    ['philadelphia', 'pennsylvania', 39.95, -75.17, 'philly'], ['pittsburgh', 'pennsylvania', 40.44, -80.00, 'pittsburgh'],
    ['columbus', 'ohio', 39.96, -83.00, 'columbus'], ['nashville', 'tennessee', 36.16, -86.78, 'nashville'],
    ['salt lake city', 'utah', 40.76, -111.89, 'slc'], ['portland', 'oregon', 45.52, -122.68, 'portland'],
    // India
    ['hyderabad', 'telangana', 17.39, 78.49, 'hyderabad'], ['secunderabad', 'telangana', 17.44, 78.50, 'hyderabad'],
    ['gachibowli', 'telangana', 17.44, 78.35, 'hyderabad'], ['hitec city', 'telangana', 17.45, 78.38, 'hyderabad'],
    ['madhapur', 'telangana', 17.44, 78.39, 'hyderabad'],
    ['bangalore', 'karnataka', 12.97, 77.59, 'bangalore'], ['bengaluru', 'karnataka', 12.97, 77.59, 'bangalore'],
    ['chennai', 'tamil nadu', 13.08, 80.27, 'chennai'], ['pune', 'maharashtra', 18.52, 73.86, 'pune'],
    ['mumbai', 'maharashtra', 19.08, 72.88, 'mumbai'], ['navi mumbai', 'maharashtra', 19.03, 73.03, 'mumbai'],
    ['delhi', 'delhi', 28.61, 77.21, 'ncr'], ['new delhi', 'delhi', 28.61, 77.21, 'ncr'],
    ['gurgaon', 'haryana', 28.46, 77.03, 'ncr'], ['gurugram', 'haryana', 28.46, 77.03, 'ncr'],
    ['noida', 'uttar pradesh', 28.54, 77.39, 'ncr'],
];

const BY_NAME = new Map(CITIES.map(([name, state, lat, lon, metro]) => [name, { name, state, lat, lon, metro }]));
const CITY_PATTERNS = [...BY_NAME.keys()].sort((a, b) => b.length - a.length)
    .map((name) => ({ name, re: new RegExp(`(^|[^a-z])${name.replace(/ /g, '\\s+')}([^a-z]|$)`) }));

/** Known places mentioned in a piece of text. Longest names first, so "new york" ≠ "york". */
const citiesIn = (text) => {
    const t = ` ${norm(text)} `;
    const out = [];
    let masked = t;
    for (const { name, re } of CITY_PATTERNS) {
        if (re.test(masked)) {
            out.push(BY_NAME.get(name));
            masked = masked.replace(re, ' ');
        }
    }
    return out;
};

const KM_PER_MILE = 1.609344;
export const milesBetween = (a, b) => {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return (2 * 6371 * Math.asin(Math.sqrt(h))) / KM_PER_MILE;
};

/* ── countries ────────────────────────────────────────────────────────── */
//
// Found on a live pool: "ASIC Physical Design Engineer — Shanghai" and a
// "Sr React Developer — London" both passed as "job location not stated",
// because neither city is in the table above. Not knowing a CITY is not the
// same as not knowing the COUNTRY, and a country is enough to say a job is out
// of reach of someone who lives in another one.

const INDIAN_STATES = new Set(['telangana', 'karnataka', 'tamil nadu', 'maharashtra', 'delhi', 'haryana', 'uttar pradesh']);

const COUNTRY_WORDS = [
    [/\b(united states(?: of america)?|u\.s\.a?\.?|usa)\b/i, 'us'],
    [/\bindia\b/i, 'in'], [/\bchina\b/i, 'cn'], [/\bgermany\b/i, 'de'],
    [/\b(united kingdom|england|scotland|great britain)\b/i, 'uk'], [/\bcanada\b/i, 'ca'],
    [/\bsingapore\b/i, 'sg'], [/\bjapan\b/i, 'jp'], [/\baustralia\b/i, 'au'],
    [/\bnetherlands\b/i, 'nl'], [/\bfrance\b/i, 'fr'], [/\bireland\b/i, 'ie'],
    [/\bisrael\b/i, 'il'], [/\bpoland\b/i, 'pl'], [/\b(uae|united arab emirates)\b/i, 'ae'],
    [/\bmexico\b/i, 'mx'], [/\bbrazil\b/i, 'br'], [/\bphilippines\b/i, 'ph'],
    [/\bspain\b/i, 'es'], [/\bsweden\b/i, 'se'], [/\bswitzerland\b/i, 'ch'],
];
const CITY_COUNTRY = {
    london: 'uk', manchester: 'uk', edinburgh: 'uk', dublin: 'ie', toronto: 'ca', vancouver: 'ca', montreal: 'ca',
    sydney: 'au', melbourne: 'au', singapore: 'sg', tokyo: 'jp', berlin: 'de', munich: 'de', paris: 'fr',
    amsterdam: 'nl', zurich: 'ch', dubai: 'ae', shanghai: 'cn', beijing: 'cn', shenzhen: 'cn',
    'tel aviv': 'il', warsaw: 'pl', krakow: 'pl', 'mexico city': 'mx',
};

const countryOfState = (state) => (state ? (INDIAN_STATES.has(state) ? 'in' : 'us') : null);

/** The country a piece of location text is in, or null when it does not say. */
export const countryOf = (text) => {
    const t = String(text ?? '');
    for (const [re, code] of COUNTRY_WORDS) if (re.test(t)) return code;
    // A bare uppercase "US" or "UK", the way job boards write them.
    if (/(^|[\s,(])US([\s,)]|$)/.test(t)) return 'us';
    if (/(^|[\s,(])UK([\s,)]|$)/.test(t)) return 'uk';
    const city = citiesIn(t)[0];
    if (city) return countryOfState(city.state);
    const n = norm(t);
    for (const [name, code] of Object.entries(CITY_COUNTRY)) {
        if (new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(n)) return code;
    }
    for (const place of placesOf(t)) if (place.states[0]) return countryOfState(place.states[0]);
    return null;
};

/** The countries the consultant's own places are in. Empty when none can be told. */
const countriesOfConsultant = (places) => {
    const out = new Set();
    for (const w of places) {
        const c = (w.city ? citiesIn(w.city)[0] : null);
        const state = stateOf(w.state) ?? c?.state ?? null;
        const code = countryOfState(state) ?? (w.city ? CITY_COUNTRY[norm(w.city)] ?? null : null);
        if (code) out.add(code);
    }
    return out;
};

/* ── what a posting says about where ──────────────────────────────────── */

const NEGATED_REMOTE = /\b(no|not|non)[\s-]+(a\s+)?remote\b|\bon-?site\s+only\b|\bin[- ]office\s+only\b|\bmust\s+be\s+on-?site\b|\bremote\s+not\s+(available|offered|possible)\b/i;
const REMOTE_WORDS = /\b(fully|100%|completely|entirely)\s+remote\b|\bremote[- ]first\b|\bremote\s+(position|role|job|opportunity|work)\b|\bwork\s+(remotely|from\s+home)\b|\bwfh\b|\bremote\s*\(/i;
const HYBRID_WORDS = /\bhybrid\b/i;

/**
 * Is the job remote, hybrid or on-site?
 *
 * A posting that says "no remote" is not remote however many other words in it
 * say otherwise; and "remote" has to be said about the JOB, not merely appear
 * ("our remote-friendly culture", "remote desktop support").
 */
export const workModeOf = (posting) => {
    const where = String(posting.locationText ?? '');
    const text = `${posting.title ?? ''}\n${posting.description ?? ''}`;
    if (NEGATED_REMOTE.test(text) || NEGATED_REMOTE.test(where)) return 'ONSITE';
    if (HYBRID_WORDS.test(where) || HYBRID_WORDS.test(posting.title ?? '')) return 'HYBRID';
    if (posting.isRemote || /\bremote\b/i.test(where) || /\bremote\b/i.test(posting.title ?? '')
        || REMOTE_WORDS.test(text)) return 'REMOTE';
    if (HYBRID_WORDS.test(text)) return 'HYBRID';
    return 'ONSITE';
};

/** The places a posting names ("Dallas, TX; Austin, TX | Remote"). */
const placesOf = (locationText) => {
    const text = String(locationText ?? '');
    const parts = text.split(/[;|]|\s+or\s+|\s+\/\s+/i).map((s) => s.trim()).filter(Boolean);
    const places = [];
    for (const part of parts.length ? parts : [text]) {
        const cities = citiesIn(part);
        const tokens = part.split(/[,\s]+/).filter(Boolean);
        const states = new Set();
        // A two-letter abbreviation counts only when written the way a state is
        // ("Dallas, TX"): uppercase, so the word "in" or "or" is not Indiana or Oregon.
        for (const tok of tokens) {
            const bare = tok.replace(/\./g, '');
            if (/^[A-Z]{2}$/.test(bare) && ABBREVIATIONS[bare.toLowerCase()]) states.add(ABBREVIATIONS[bare.toLowerCase()]);
        }
        for (const name of STATE_NAMES) if (new RegExp(`(^|[^a-z])${name}([^a-z]|$)`, 'i').test(part)) states.add(name);
        for (const c of cities) states.add(c.state);
        if (cities.length || states.size) places.push({ cities, states: [...states], text: part });
    }
    return places;
};

/* ── the answer ───────────────────────────────────────────────────────── */

const DEFAULT_RADIUS = 35;
const WEIGHT = 10;

/**
 * @param posting  { locationText, isRemote, title, description }
 * @param criteria { locations: [{city, state, workMode, radiusMiles}], openToRelocate }
 * @returns {{ mode, points, pass, why }}
 */
export const locationFit = (posting, criteria) => {
    const locations = criteria.locations ?? [];
    const jobMode = workModeOf(posting);
    const wantsRemote = locations.some((l) => l.workMode === 'REMOTE');
    const places = locations.filter((l) => l.workMode !== 'REMOTE');

    if (locations.length === 0) return { mode: 'UNKNOWN', points: WEIGHT * 0.5, pass: true, why: null };

    // A job in another country is out of reach of someone who lives here, whether
    // or not its city is one this table knows — and a remote one is a role to
    // ask about, not to queue: "remote" very often means "remote, in Germany".
    const mineCountries = countriesOfConsultant(places);
    const jobCountry = countryOf(posting.locationText);
    const abroad = Boolean(jobCountry) && mineCountries.size > 0 && !mineCountries.has(jobCountry);
    if (abroad) {
        if (jobMode === 'REMOTE') {
            return {
                mode: 'REMOTE', points: WEIGHT * 0.4, pass: true, cap: true,
                why: `remote, but the role is based in ${jobCountry.toUpperCase()}`,
            };
        }
        return criteria.openToRelocate
            ? { mode: 'RELOCATE', points: WEIGHT * 0.3, pass: true, why: `in ${jobCountry.toUpperCase()}; open to relocate` }
            : { mode: 'FAR', points: 0, pass: false, why: 'Location does not match' };
    }

    if (jobMode === 'REMOTE') {
        return wantsRemote
            ? { mode: 'REMOTE', points: WEIGHT, pass: true, why: 'remote, as wanted' }
            // Not listed as wanted, but it asks nothing of where they live.
            : { mode: 'REMOTE', points: WEIGHT * 0.6, pass: true, why: 'remote (not listed as wanted)' };
    }

    const jobPlaces = placesOf(posting.locationText);
    if (jobPlaces.length === 0) {
        return { mode: 'UNKNOWN', points: WEIGHT * 0.4, pass: true, why: 'job location not stated' };
    }

    let best = null;
    const take = (cand) => { if (!best || cand.points > best.points) best = cand; };

    for (const want of places) {
        const mineCity = want.city ? citiesIn(want.city)[0] ?? null : null;
        const myState = stateOf(want.state) ?? mineCity?.state ?? null;
        const radius = want.radiusMiles ?? DEFAULT_RADIUS;

        for (const place of jobPlaces) {
            for (const city of place.cities) {
                if (mineCity && city.name === mineCity.name) {
                    take({ mode: 'LOCAL', points: WEIGHT, pass: true, why: `location: ${city.name}` });
                } else if (mineCity && city.metro === mineCity.metro) {
                    take({ mode: 'LOCAL', points: WEIGHT * 0.9, pass: true, why: `same metro: ${city.name} ≈ ${mineCity.name}` });
                } else if (mineCity) {
                    const d = Math.round(milesBetween(city, mineCity));
                    if (d <= radius) take({ mode: 'NEAR', points: WEIGHT * 0.8, pass: true, why: `${d} miles from ${mineCity.name}` });
                }
            }
            // A consultant whose city the table does not know, but whose text appears.
            if (want.city && norm(place.text).includes(norm(want.city))) {
                take({ mode: 'LOCAL', points: WEIGHT, pass: true, why: `location: ${want.city}` });
            }
            if (myState && place.states.includes(myState)) {
                take({ mode: 'STATE', points: WEIGHT * 0.5, pass: true, why: `same state: ${myState}` });
            }
        }
    }

    if (best) return best;
    if (criteria.openToRelocate) {
        return { mode: 'RELOCATE', points: WEIGHT * 0.3, pass: true, why: 'outside their area; open to relocate' };
    }
    // Hybrid and on-site roles elsewhere are out of reach for someone who will not move.
    return { mode: 'FAR', points: 0, pass: false, why: 'Location does not match' };
};
