const $ = (selector) => document.querySelector(selector);
const input = $('#search');
const suggestions = $('#suggestions');
const clear = $('#clear');
const example = $('#example');
const intro = $('#intro');
const results = $('#results');
const status = $('#status');
const PAGE_SIZE = 12;

const modes = {
  direct: ['Papers that cite my work', 'CHI 2026 papers with a direct reference to your work.'],
  incoming: ['Papers by authors who cite me', 'CHI 2026 papers by authors who cite you in another publication.'],
  outgoing: ['Papers by authors I cite', 'CHI 2026 papers by authors whose work appears in your bibliographies.'],
};

let program;
let authors = [];
let matches = [];
let active = -1;
let selected;
let selectionVersion = 0;
const snapshots = new Map();

function el(tag, value = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function link(title, url) {
  const node = el('a', title);
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') node.href = parsed.href;
  node.target = '_blank';
  node.rel = 'noopener';
  return node;
}

async function readJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('Could not load ' + path);
  return response.json();
}

function fold(value) {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function setActive(index) {
  active = index;
  const options = [...suggestions.querySelectorAll('[role=option]')];
  for (const [i, option] of options.entries()) option.setAttribute('aria-selected', i === index);
  if (index < 0) {
    input.removeAttribute('aria-activedescendant');
    return;
  }
  input.setAttribute('aria-activedescendant', options[index].id);
  options[index].scrollIntoView({ block: 'nearest' });
}

function closeSuggestions() {
  suggestions.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  setActive(-1);
}

function search() {
  clear.hidden = !input.value;
  const query = fold(input.value);
  if (!query || input.value === selected?.name) {
    closeSuggestions();
    return;
  }
  const terms = query.split(/\s+/);
  matches = authors.filter(({ normalized }) => terms.every((term) => normalized.includes(term)));
  matches.sort((a, b) => Number(b.normalized.startsWith(query)) - Number(a.normalized.startsWith(query)));
  matches = matches.slice(0, 15);
  suggestions.replaceChildren(...matches.map((author, index) => {
    const option = el('li', author.name);
    option.id = 'author-option-' + index;
    option.setAttribute('role', 'option');
    option.addEventListener('pointerdown', (event) => event.preventDefault());
    option.addEventListener('click', () => selectAuthor(author));
    if (program.profiles[author.id]) option.append(el('span', 'Citation data', 'match-note'));
    return option;
  }));
  if (!matches.length) {
    const empty = el('li');
    empty.setAttribute('role', 'presentation');
    const message = el('span', 'No matching authors.');
    message.setAttribute('role', 'status');
    empty.append(message);
    suggestions.append(empty);
  }
  suggestions.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  setActive(-1);
}

async function selectAuthor(author) {
  const version = ++selectionVersion;
  selected = author;
  input.value = author.name;
  clear.hidden = false;
  closeSuggestions();
  intro.hidden = true;
  results.hidden = true;
  status.textContent = '';
  const profile = program.profiles[author.id];
  if (!profile) {
    status.textContent = author.name + ' is in the program. Citation recommendations are available for Luigi De Russis in this demo.';
    return;
  }
  status.textContent = 'Loading citation recommendations for ' + author.name + '…';
  try {
    if (!snapshots.has(author.id)) {
      snapshots.set(author.id, await readJSON('citations-' + author.id + '.json'));
    }
    if (version !== selectionVersion) return;
    const snapshot = snapshots.get(author.id);
    renderResults(author, profile, snapshot);
    status.textContent = '';
    results.hidden = false;
  } catch {
    if (version === selectionVersion) status.textContent = 'Citation data could not be loaded. Select the author again to retry.';
  }
}

function addWork(container, work) {
  container.append(link(work.title, work.url), ' · ' + work.venue + (work.year ? ' · ' + work.year : ''));
  if (work.sigchi) container.append(' ', el('span', 'SIGCHI', 'tag'));
}

function evidenceFor(match, mode, source) {
  if (mode === 'direct') return match.direct.map((id) => ({ id }));
  const evidence = [];
  for (const [name, edges] of Object.entries(match[mode])) {
    for (const [id, trail] of edges) {
      if (mode === 'incoming') {
        evidence.push({ id, name, trail: trail.map((work) => [work]) });
      } else {
        const sources = trail.filter(([, atCHI]) => source === 'all' || atCHI === (source === 'chi'));
        if (sources.length) evidence.push({ id, name, trail: sources });
      }
    }
  }
  return evidence;
}

function paperCard(paper, evidence, works, mode, venue) {
  const article = el('article', '', 'paper');
  if (paper.session) article.append(el('p', paper.session, 'session'));
  const title = el('h3');
  title.append(link(paper.title, paper.doi));
  const byline = paper.authors.map((id) => program.authors[id]).filter(Boolean).join(', ');
  article.append(title, el('p', byline, 'byline'));
  const details = el('details');
  const count = new Set(evidence.map(({ id }) => id)).size;
  details.append(el('summary', 'View citation evidence (' + count + (count === 1 ? ' work)' : ' works)')));
  article.append(details);
  details.addEventListener('toggle', () => {
    if (!details.open || details.children.length > 1) return;
    const list = el('ul', '', 'evidence-list');
    const ordered = [...evidence].sort((a, b) => {
      return Number(works[b.id].venue === venue) - Number(works[a.id].venue === venue)
        || Number(works[b.id].sigchi) - Number(works[a.id].sigchi)
        || (works[b.id].year ?? 0) - (works[a.id].year ?? 0);
    });
    for (const { id, name, trail } of ordered) {
      const row = el('li');
      const label = mode === 'incoming' ? name + ' cites your work in ' : mode === 'outgoing' ? name + ' coauthored or wrote ' : 'Cites ';
      const lead = el('p', label);
      addWork(lead, works[id]);
      row.append(lead);
      for (const [related, atCHI] of trail ?? []) {
        const detail = el('p', mode === 'incoming' ? 'References ' : 'You cited it in ');
        addWork(detail, works[related]);
        if (atCHI) detail.append(' ', el('span', 'CHI 2026 source', 'tag'));
        row.append(detail);
      }
      list.append(row);
    }
    details.append(list);
  });
  return article;
}

function selectControl(title, entries) {
  const control = el('select');
  for (const [value, label] of entries) control.add(new Option(label, value));
  const label = el('label', title);
  label.append(control);
  return { label, control };
}

function renderResults(author, profile, snapshot) {
  const papers = program.papers.filter((paper) => snapshot.matches[paper.id]);
  const views = el('div', '', 'view-buttons');
  views.setAttribute('role', 'group');
  views.setAttribute('aria-label', 'Citation relationship');
  const metadata = el('p', '', 'meta');
  metadata.append(profile.orcid ? link('ORCID profile', profile.orcid) : link('DBLP profile', profile.dblp), ' · ' + snapshot.authoredWorks + ' indexed publications');
  const toolbar = el('div', '', 'toolbar');
  const description = el('p');
  description.setAttribute('aria-live', 'polite');
  const filters = el('div', '', 'filters');
  const source = selectControl('Cited in', [['all', 'All my work'], ['chi', 'My CHI 2026 work'], ['other', 'My other work']]);
  const grouping = selectControl('Group by', [['none', 'None'], ['venue', 'Evidence venue']]);
  filters.append(source.label, grouping.label);
  toolbar.append(description, filters);
  const cards = el('div', '', 'papers');
  const more = el('button', 'Show more papers', 'load-more');
  more.type = 'button';
  const coverage = el('p', 'OpenAlex matched ' + snapshot.indexedPapers.toLocaleString() + ' of ' + program.papers.length.toLocaleString() + ' main-track papers in the program. It had linked references for ' + snapshot.papersWithReferences.toLocaleString() + ' of them. Recommendations reflect indexed citations and author records.', 'coverage');
  results.replaceChildren(el('p', 'Recommendations for', 'section-label'), el('h2', author.name), metadata, views, toolbar, cards, more, coverage);

  let mode = 'direct';
  let limit = PAGE_SIZE;
  const buttons = {};
  for (const [key, [label]] of Object.entries(modes)) {
    const button = el('button', label);
    button.type = 'button';
    button.append(el('span', String(papers.filter((paper) => evidenceFor(snapshot.matches[paper.id], key, 'all').length).length), 'count'));
    button.addEventListener('click', () => {
      mode = key;
      limit = PAGE_SIZE;
      paint();
    });
    buttons[key] = button;
    views.append(button);
  }
  const compareVenue = (a, b) => Number(b.sigchi) - Number(a.sigchi) || a.name.localeCompare(b.name);

  function paint() {
    for (const [key, button] of Object.entries(buttons)) button.setAttribute('aria-pressed', key === mode);
    source.label.hidden = mode !== 'outgoing';
    const rows = papers.map((paper) => ({
      paper,
      evidence: evidenceFor(snapshot.matches[paper.id], mode, source.control.value),
    })).filter(({ evidence }) => evidence.length);
    rows.sort((a, b) => b.evidence.length - a.evidence.length || a.paper.title.localeCompare(b.paper.title));
    let venueGroups;
    if (grouping.control.value === 'venue') {
      const groups = new Map();
      for (const row of rows) {
        for (const { id } of row.evidence) {
          const work = snapshot.works[id];
          if (!groups.has(work.venue)) groups.set(work.venue, { name: work.venue, rows: new Set(), sigchi: false });
          const group = groups.get(work.venue);
          group.rows.add(row);
          group.sigchi ||= work.sigchi;
        }
      }
      venueGroups = [...groups.values()].sort(compareVenue);
    }
    description.textContent = modes[mode][1];
    cards.replaceChildren();
    const shown = rows.slice(0, limit);
    if (!shown.length) cards.append(el('p', 'No indexed papers match this view.', 'empty'));
    if (!venueGroups) {
      cards.append(...shown.map(({ paper, evidence }) => paperCard(paper, evidence, snapshot.works, mode)));
    } else {
      const visible = new Set(shown);
      for (const group of venueGroups) {
        const members = [...group.rows].filter((row) => visible.has(row));
        if (!members.length) continue;
        const heading = el('h3', group.name, 'venue-heading');
        if (group.sigchi) heading.append(' ', el('span', 'SIGCHI', 'tag'));
        cards.append(heading, ...members.map(({ paper, evidence }) => paperCard(paper, evidence, snapshot.works, mode, group.name)));
      }
    }
    more.hidden = rows.length <= limit;
    more.textContent = 'Show more papers (' + shown.length + ' of ' + rows.length + ')';
  }

  for (const control of [source.control, grouping.control]) {
    control.addEventListener('change', () => {
      limit = PAGE_SIZE;
      paint();
    });
  }
  more.addEventListener('click', () => {
    limit += PAGE_SIZE;
    paint();
  });
  paint();
}

input.addEventListener('input', search);
input.addEventListener('focus', search);
input.addEventListener('blur', closeSuggestions);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSuggestions();
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    if (suggestions.hidden) search();
    if (suggestions.hidden || !matches.length) return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    setActive(active < 0 && direction < 0 ? matches.length - 1 : (active + direction + matches.length) % matches.length);
  }
  if (event.key === 'Enter' && !suggestions.hidden && (active >= 0 || matches.length === 1)) {
    event.preventDefault();
    selectAuthor(matches[Math.max(active, 0)]);
  }
});
clear.addEventListener('click', () => {
  ++selectionVersion;
  selected = undefined;
  input.value = '';
  status.textContent = '';
  results.hidden = true;
  intro.hidden = false;
  search();
  input.focus();
});

readJSON('program.json').then((data) => {
  program = data;
  authors = Object.entries(program.authors).filter(([, name]) => name).map(([id, name]) => ({
    id, name, normalized: fold(name),
  })).sort((a, b) => a.name.localeCompare(b.name));
  input.disabled = false;
  const demo = authors.find(({ id }) => Number(id) === 221641);
  if (demo && program.profiles[demo.id]) {
    example.disabled = false;
    example.addEventListener('click', () => selectAuthor(demo));
  }
}).catch(() => {
  status.textContent = 'The conference program could not be loaded. Reload the page to try again.';
});
