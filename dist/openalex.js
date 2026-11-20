// Live OpenAlex lookups for authors without a prebuilt snapshot.
//
// This mirrors build_profile() in scripts/build-data.py. The program papers'
// OpenAlex records come precomputed in program-works.json, so the browser only
// fetches the selected author's own works, the works they reference, and the
// works that cite them.

const API = 'https://api.openalex.org/';
const KEY_STORAGE = 'chi2026-citation-explorer:openalex-key';
const LEGACY_PREFIX = 'chi2026-citation-explorer:live:';
const CACHE_VERSION = 1;
const FIELDS = 'id,doi,title,publication_year,primary_location,authorships,referenced_works';
const TARGET_FIELDS = 'id,doi,title,publication_year,primary_location,authorships';
const AUTHOR_FIELDS = 'id,display_name,orcid,works_count,cited_by_count,last_known_institutions,topics';
const CONCURRENCY = 4;

export class BudgetError extends Error {}

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}
export function setApiKey(value) {
  try {
    if (value) localStorage.setItem(KEY_STORAGE, value.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* storage unavailable */ }
}

const shortId = (value) => String(value || '').split('/').pop();
const doiKey = (value) => {
  try { return new URL(value).pathname.replace(/^\//, '').toLowerCase(); } catch { return ''; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let requests = 0;
async function api(path, params, signal) {
  const query = new URLSearchParams(params);
  const key = getApiKey();
  if (key) query.set('api_key', key);
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    try {
      response = await fetch(API + path + '?' + query, { signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    requests++;
    if (response.ok) return response.json();
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    if (response.status === 429 && (remaining === 0 || attempt === 3)) {
      throw new BudgetError('OpenAlex daily request budget is used up.');
    }
    if (![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error('OpenAlex returned HTTP ' + response.status);
    }
    await sleep(1000 * 2 ** attempt);
  }
  throw new Error('OpenAlex did not respond. Try again in a moment.');
}

// Uses page numbers rather than cursors: OpenAlex refuses cursor paging past
// the first page without an API key. Page paging stops at 10,000 results, so
// larger OR-filters are split in half until each part fits.
const PAGE_LIMIT = 10_000;
async function allWorks(filter, select, signal, values = null) {
  const first = await api('works', { filter, select, per_page: 200, page: 1 }, signal);
  if (first.meta.count > PAGE_LIMIT && values?.length > 1) {
    const [field] = filter.split(':');
    const half = Math.ceil(values.length / 2);
    const parts = [values.slice(0, half), values.slice(half)];
    const nested = await Promise.all(parts.map((part) => allWorks(field + ':' + part.join('|'), select, signal, part)));
    return nested.flat();
  }
  const results = [...first.results];
  const pages = Math.ceil(Math.min(first.meta.count, PAGE_LIMIT) / 200);
  for (let page = 2; page <= pages; page++) {
    const data = await api('works', { filter, select, per_page: 200, page }, signal);
    if (!data.results.length) break;
    results.push(...data.results);
  }
  return results;
}
// Runs tasks with a small concurrency limit and reports progress.
async function pool(tasks, onDone) {
  const results = [];
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
      onDone?.(++done, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
  return results;
}

function chunks(values, size) {
  const list = [...values].sort();
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
}

function describeAuthor(author) {
  return {
    id: shortId(author.id),
    name: author.display_name,
    orcid: author.orcid || null,
    works: author.works_count,
    citations: author.cited_by_count,
    institution: author.last_known_institutions?.[0]?.display_name || null,
    topic: author.topics?.[0]?.display_name || null,
  };
}

const ORCID = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i;
const OPENALEX_ID = /^(?:https?:\/\/openalex\.org\/)?(A\d+)$/i;

// Accepts an ORCID (bare or URL) or an OpenAlex author ID.
export function identifierIn(text) {
  const value = text.trim();
  const orcid = value.match(ORCID);
  if (orcid) return { kind: 'ORCID', value: orcid[1].toUpperCase() };
  const openalex = value.match(OPENALEX_ID);
  if (openalex) return { kind: 'OpenAlex ID', value: openalex[1].toUpperCase() };
  return null;
}

// ---------------------------------------------------------------------------
// Cache
// Everything fetched from OpenAlex is kept in IndexedDB so the same author is
// never requested twice from this browser. Entries:
//   snapshot:<A-id>  { version, builtAt, author, snapshot }  computed results
//   search:<query>   { at, results }                         author searches
//   choice:<program person id>  candidate                    chosen profile
// If IndexedDB is unavailable (private mode), an in-memory map is used.
// ---------------------------------------------------------------------------
const DB_NAME = 'chi2026-citation-explorer';
const STORE = 'openalex';
const memory = new Map();
let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).then(async (db) => {
    await migrateLocalStorage(db);
    return db;
  });
  return dbPromise;
}

function transact(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result.result ?? result.value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function cacheGet(key) {
  const db = await openDb();
  if (!db) return memory.get(key);
  try { return await transact(db, 'readonly', (store) => store.get(key)); } catch { return memory.get(key); }
}

async function cacheSet(key, value) {
  memory.set(key, value);
  const db = await openDb();
  if (!db) return;
  try { await transact(db, 'readwrite', (store) => store.put(value, key)); } catch { /* quota or private mode: memory only */ }
}

async function cacheEntries(prefix) {
  const db = await openDb();
  if (!db) return [...memory].filter(([key]) => key.startsWith(prefix));
  try {
    const range = IDBKeyRange.bound(prefix, prefix + '￿');
    const [keys, values] = await Promise.all([
      transact(db, 'readonly', (store) => store.getAllKeys(range)),
      transact(db, 'readonly', (store) => store.getAll(range)),
    ]);
    return keys.map((key, i) => [key, values[i]]);
  } catch {
    return [];
  }
}

// Earlier versions kept snapshots in localStorage; move them into IndexedDB.
async function migrateLocalStorage(db) {
  let keys = [];
  try { keys = Object.keys(localStorage).filter((key) => key.startsWith(LEGACY_PREFIX)); } catch { return; }
  for (const key of keys) {
    try {
      const entry = JSON.parse(localStorage.getItem(key));
      const id = key.slice(LEGACY_PREFIX.length);
      if (entry?.version === CACHE_VERSION && db) {
        const value = { ...entry, author: entry.author || null };
        await transact(db, 'readwrite', (store) => store.put(value, 'snapshot:' + id));
      }
      localStorage.removeItem(key);
    } catch { /* leave it */ }
  }
}

const foldText = (value) => value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Authors whose recommendations are already computed in this browser.
export async function savedAuthors() {
  const entries = await cacheEntries('snapshot:');
  return entries.map(([, entry]) => ({ ...entry.author, builtAt: entry.builtAt }))
    .filter((author) => author?.id && author.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function hasSnapshot(authorId) {
  return Boolean(await readCache(authorId));
}

export async function rememberChoice(programPersonId, candidate) {
  await cacheSet('choice:' + programPersonId, candidate);
}

export async function rememberedChoice(programPersonId) {
  return cacheGet('choice:' + programPersonId);
}

// Returns { results, cachedAt }. cachedAt is set when no request was made.
export async function findAuthors(text, signal, { refresh = false } = {}) {
  const identifier = identifierIn(text);
  if (identifier && !refresh) {
    // An author already computed here needs no lookup at all.
    const known = (await savedAuthors()).find((author) => identifier.kind === 'ORCID'
      ? (author.orcid || '').toUpperCase().endsWith(identifier.value)
      : author.id === identifier.value);
    if (known) return { results: [known], cachedAt: known.builtAt };
  }
  const key = 'search:' + (identifier ? identifier.kind + ':' + identifier.value : foldText(text));
  if (!refresh) {
    const cached = await cacheGet(key);
    if (cached) return { results: cached.results, cachedAt: cached.at };
  }
  let results;
  if (identifier) {
    const path = 'authors/' + (identifier.kind === 'ORCID' ? 'orcid:' + identifier.value : identifier.value);
    try {
      results = [describeAuthor(await api(path, { select: AUTHOR_FIELDS }, signal))];
    } catch (error) {
      if (error instanceof BudgetError || error.name === 'AbortError') throw error;
      results = [];
    }
  } else {
    const data = await api('authors', { search: text, select: AUTHOR_FIELDS, per_page: 8 }, signal);
    results = data.results.map(describeAuthor);
  }
  await cacheSet(key, { at: Date.now(), results });
  return { results, cachedAt: null };
}

async function readCache(authorId) {
  const entry = await cacheGet('snapshot:' + authorId);
  return entry?.version === CACHE_VERSION ? entry : null;
}

async function writeCache(author, snapshot) {
  const { builtAt, ...profile } = author;
  await cacheSet('snapshot:' + author.id, { version: CACHE_VERSION, builtAt: Date.now(), author: profile, snapshot });
}

export async function buildSnapshot(author, program, programWorks, { onProgress, signal, refresh = false } = {}) {
  if (!refresh) {
    const cached = await readCache(author.id);
    // Entries migrated from localStorage lack the profile; fill it in now.
    if (cached && !cached.author?.name) {
      const { builtAt, ...profile } = author;
      await cacheSet('snapshot:' + author.id, { ...cached, author: profile });
    }
    if (cached) return { ...cached.snapshot, cachedAt: cached.builtAt };
  }
  requests = 0;
  const authorId = author.id;
  const venues = (program.sigchiVenues || []).map(([label, pattern]) => [label, new RegExp(pattern, 'i')]);
  const sigchiVenue = (...names) => {
    for (const name of names) for (const [label, pattern] of venues) if (name && pattern.test(name)) return label;
    return null;
  };
  const peopleOn = (work) => new Map((work.authorships || []).filter((entry) => entry.author?.id)
    .map((entry) => [shortId(entry.author.id), entry.author.display_name]));
  const references = (work) => new Set((work.referenced_works || []).map(shortId));
  const papers = new Map(program.papers.map((paper) => [String(paper.id), paper]));

  onProgress?.('Loading the publications of ' + author.name + '…');
  const history = new Map((await allWorks('author.id:' + authorId, FIELDS, signal)).map((work) => [shortId(work.id), work]));
  // Program papers can be ahead of OpenAlex's author index.
  for (const [paperId, entry] of Object.entries(programWorks)) {
    if (!history.has(entry.work) && entry.authors.some(([id]) => id === authorId)) {
      const paper = papers.get(paperId);
      history.set(entry.work, {
        id: entry.work, doi: paper?.doi, title: paper?.title, publication_year: 2026,
        primary_location: { source: { display_name: 'CHI Conference on Human Factors in Computing Systems' } },
        authorships: [], referenced_works: entry.refs,
      });
    }
  }
  const refsBySource = new Map([...history].map(([id, work]) => [id, references(work)]));
  const allRefs = new Set([...refsBySource.values()].flatMap((refs) => [...refs]));
  const conferenceAuthors = new Set(Object.values(programWorks).flatMap((entry) => entry.authors.map(([id]) => id)));
  conferenceAuthors.delete(authorId);

  const outgoingTargets = new Map();
  const outgoingByAuthor = new Map();
  const refBatches = chunks(allRefs, 100);
  const outgoing = await pool(refBatches.map((batch) => () => allWorks('openalex_id:' + batch.join('|'), TARGET_FIELDS, signal, batch)),
    (done, total) => onProgress?.('Checking the works ' + author.name + ' cites (' + done + ' of ' + total + ')…'));
  for (const work of outgoing.flat()) {
    const matched = [...peopleOn(work).keys()].filter((id) => conferenceAuthors.has(id));
    if (!matched.length) continue;
    const workId = shortId(work.id);
    outgoingTargets.set(workId, work);
    for (const id of matched) {
      if (!outgoingByAuthor.has(id)) outgoingByAuthor.set(id, new Set());
      outgoingByAuthor.get(id).add(workId);
    }
  }
  const outgoingSources = new Map();
  for (const [source, refs] of refsBySource) {
    for (const target of refs) {
      if (!outgoingTargets.has(target)) continue;
      if (!outgoingSources.has(target)) outgoingSources.set(target, new Set());
      outgoingSources.get(target).add(source);
    }
  }

  const incomingByAuthor = new Map();
  const incomingSources = new Map();
  const historyBatches = chunks(history.keys(), 50);
  const incoming = await pool(historyBatches.map((batch) => () => allWorks('cites:' + batch.join('|'), FIELDS, signal, batch)),
    (done, total) => onProgress?.('Finding works that cite ' + author.name + ' (' + done + ' of ' + total + ')…'));
  for (const work of incoming.flat()) {
    const cited = [...references(work)].filter((id) => history.has(id));
    const matched = [...peopleOn(work).keys()].filter((id) => conferenceAuthors.has(id));
    if (!cited.length || !matched.length) continue;
    const workId = shortId(work.id);
    incomingSources.set(workId, work);
    for (const id of matched) {
      if (!incomingByAuthor.has(id)) incomingByAuthor.set(id, new Map());
      const bySource = incomingByAuthor.get(id);
      bySource.set(workId, new Set([...(bySource.get(workId) || []), ...cited]));
    }
  }

  const programDois = new Set(program.papers.map((paper) => doiKey(paper.doi)));
  const programTitles = new Set(program.papers.map((paper) => paper.title.toLocaleLowerCase().trim()));
  const conferenceWorkIds = new Set([...history].filter(([, work]) =>
    programDois.has(doiKey(work.doi)) || programTitles.has((work.title || '').toLocaleLowerCase().trim())).map(([id]) => id));

  const records = {};
  const register = (workId, collection) => {
    if (!records[workId]) {
      const work = collection.get(workId);
      const location = work.primary_location || {};
      const venue = location.source?.display_name || location.raw_source_name || 'Venue unavailable';
      records[workId] = {
        title: work.title || 'Untitled work',
        year: work.publication_year,
        venue,
        sigchi: sigchiVenue(venue, location.raw_source_name || ''),
        url: work.doi || 'https://openalex.org/' + shortId(work.id),
      };
    }
    return workId;
  };

  const matches = {};
  let indexedPapers = 0;
  let papersWithReferences = 0;
  for (const [paperId, entry] of Object.entries(programWorks)) {
    indexedPapers++;
    if (entry.refs.length) papersWithReferences++;
    if (entry.authors.some(([id]) => id === authorId)) continue;
    const direct = entry.refs.filter((id) => history.has(id)).sort();
    const incomingMatch = {};
    const outgoingMatch = {};
    for (const [personId, name] of entry.authors) {
      const sources = incomingByAuthor.get(personId);
      if (sources) {
        const edges = [...sources].filter(([source]) => source !== entry.work).sort(([a], [b]) => a.localeCompare(b))
          .map(([source, refs]) => [register(source, incomingSources), [...refs].sort().map((ref) => register(ref, history))]);
        if (edges.length) incomingMatch[name] = edges;
      }
      const targets = outgoingByAuthor.get(personId);
      if (targets) {
        outgoingMatch[name] = [...targets].sort().map((target) => [register(target, outgoingTargets),
          [...outgoingSources.get(target)].sort().map((source) => [register(source, history), conferenceWorkIds.has(source)])]);
      }
    }
    if (direct.length || Object.keys(incomingMatch).length || Object.keys(outgoingMatch).length) {
      matches[paperId] = { direct: direct.map((ref) => register(ref, history)), incoming: incomingMatch, outgoing: outgoingMatch };
    }
  }
  const ownPapers = Object.values(programWorks).filter((entry) => entry.authors.some(([id]) => id === authorId)).length;
  const snapshot = { works: records, matches, indexedPapers, papersWithReferences, authoredWorks: history.size, ownPapers, requests };
  await writeCache(author, snapshot);
  return { ...snapshot, cachedAt: null };
}
