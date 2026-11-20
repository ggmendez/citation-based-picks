import {
  BudgetError, buildSnapshot, findAuthors, getApiKey, hasSnapshot, identifierIn,
  rememberChoice, rememberedChoice, savedAuthors, setApiKey,
} from './openalex.js';

const $ = (selector) => document.querySelector(selector);
const input = $('#search');
const suggestions = $('#suggestions');
const clear = $('#clear');
const demos = $('#demos');
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
let programWorks;
let liveController;
let savedLive = []; // OpenAlex authors already computed in this browser
let recLayout = 'list'; // recommendations shown as a list or a schedule
let refreshRecSchedule = null; // updates My List counts in the schedule grid

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
  const identifier = identifierIn(input.value);
  matches = identifier ? [] : authors.filter(({ normalized }) => terms.every((term) => normalized.includes(term)));
  matches.sort((a, b) => Number(b.normalized.startsWith(query)) - Number(a.normalized.startsWith(query)));
  matches = matches.slice(0, 15);
  // Authors already computed in this browser open without any OpenAlex request.
  const savedMatches = savedLive.filter((author) => identifier
    ? (identifier.kind === 'ORCID' ? (author.orcid || '').toUpperCase().endsWith(identifier.value) : author.id === identifier.value)
    : terms.every((term) => fold(author.name).includes(term)));
  matches.push(...savedMatches.slice(0, 5).map((author) => ({ saved: author })));
  // The last option looks the text up in OpenAlex, for authors outside the program.
  if ((identifier && !savedMatches.length) || (!identifier && query.length >= 3)) matches.push({ lookup: input.value.trim(), identifier });
  suggestions.replaceChildren(...matches.map((item, index) => {
    const option = el('li', item.lookup ? '' : item.saved ? item.saved.name : item.name);
    option.id = 'author-option-' + index;
    option.setAttribute('role', 'option');
    option.addEventListener('pointerdown', (event) => event.preventDefault());
    option.addEventListener('click', () => choose(item));
    if (item.lookup) {
      option.className = 'lookup-option';
      const label = item.identifier ? 'Look up ' + item.identifier.kind + ' ' + item.identifier.value : 'Search OpenAlex for “' + item.lookup + '”';
      option.append(el('span', label), el('span', item.identifier ? 'Any author' : 'Authors outside the program', 'match-note'));
    } else if (item.saved) {
      option.append(el('span', 'Saved · no OpenAlex requests', 'match-note'));
    } else if (program.profiles[item.id]) {
      option.append(el('span', 'Citation data', 'match-note'));
    }
    return option;
  }));
  if (!matches.length) {
    const empty = el('li');
    empty.setAttribute('role', 'presentation');
    const message = el('span', 'No matching authors. Type at least three letters to search OpenAlex.');
    message.setAttribute('role', 'status');
    empty.append(message);
    suggestions.append(empty);
  }
  suggestions.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  setActive(-1);
}

function choose(item) {
  if (item.lookup) lookupAuthors(item.lookup);
  else if (item.saved) loadLive(item.saved);
  else selectAuthor(item);
}

function beginSelection(name) {
  liveController?.abort();
  liveController = undefined;
  const version = ++selectionVersion;
  input.value = name;
  clear.hidden = !name;
  closeSuggestions();
  intro.hidden = true;
  results.hidden = true;
  results.replaceChildren();
  status.textContent = '';
  return version;
}

async function selectAuthor(author) {
  const profile = program.profiles[author.id];
  if (!profile) {
    // Program author without a prebuilt snapshot: reuse the OpenAlex profile
    // chosen earlier, or let the person pick one.
    const choice = await rememberedChoice(author.id);
    if (choice && await hasSnapshot(choice.id)) loadLive(choice, false, author);
    else lookupAuthors(author.name, author);
    return;
  }
  const version = beginSelection(author.name);
  selected = author;
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

// `sigchi` holds the venue acronym (e.g. "CHI"); older snapshots stored `true`.
function sigchiTag(venue) {
  return el('span', typeof venue === 'string' ? 'SIGCHI · ' + venue : 'SIGCHI', 'tag');
}

function addWork(container, work) {
  container.append(link(work.title, work.url), ' · ' + work.venue + (work.year ? ' · ' + work.year : ''));
  if (work.sigchi) container.append(' ', sigchiTag(work.sigchi));
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
  article.style.setProperty('--type-color', paper.video ? VIDEO_COLOR : PAPER_COLOR);
  const header = el('div', '', 'card-header');
  header.append(cardKicker(paper), saveButton(paper));
  const title = el('h3');
  title.append(link(paper.title, paper.doi));
  article.append(header, title, bylineNodes(paper), whenRow(paper));
  const details = el('details');
  const count = new Set(evidence.map(({ id }) => id)).size;
  details.append(el('summary', 'View citation evidence (' + count + (count === 1 ? ' work)' : ' works)')));
  article.append(details);
  details.addEventListener('toggle', () => {
    if (!details.open || details.children.length > 1) return;
    const list = el('ul', '', 'evidence-list');
    const ordered = [...evidence].sort((a, b) => {
      return Number(works[b.id].venue === venue) - Number(works[a.id].venue === venue)
        || Number(Boolean(works[b.id].sigchi)) - Number(Boolean(works[a.id].sigchi))
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

// ---------------------------------------------------------------------------
// Recommendations as a schedule: a week overview of the conference's session
// time slots, then the recommended papers by day, slot, and session.
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;
const slotKey = (paper) => paper.sessionStart + '|' + paper.sessionEnd;
const timeOfDay = (ms) => ((ms % DAY_MS) + DAY_MS) % DAY_MS;
const plural = (count, one, many) => count.toLocaleString() + ' ' + (count === 1 ? one : many);

function programSlots() {
  // Every session time slot in the program, so empty slots show in the grid too.
  const slots = new Map();
  for (const paper of program.papers) {
    if (!paper.sessionStart) continue;
    const key = slotKey(paper);
    if (!slots.has(key)) slots.set(key, { key, start: paper.sessionStart, end: paper.sessionEnd, day: dayKey(paper.sessionStart) });
  }
  return [...slots.values()].sort((a, b) => a.start - b.start);
}

function recommendationSchedule(rows, state, repaint) {
  const wrap = el('div', '', 'rec-schedule');
  const slots = programSlots();
  const days = [...new Set(slots.map((slot) => slot.day))].sort();
  const ranges = [...new Map(slots.map((slot) => {
    const range = timeOfDay(slot.start) + '-' + timeOfDay(slot.end);
    return [range, { range, start: slot.start, end: slot.end, offset: timeOfDay(slot.start) }];
  })).values()].sort((a, b) => a.offset - b.offset || a.range.localeCompare(b.range));

  const bySlot = new Map();
  const videos = [];
  for (const row of rows) {
    if (row.paper.sessionStart) {
      const key = slotKey(row.paper);
      if (!bySlot.has(key)) bySlot.set(key, []);
      bySlot.get(key).push(row);
    } else if (row.paper.start) {
      videos.push(row);
    }
  }
  const sessionsIn = (slotRows) => new Set(slotRows.map(({ paper }) => paper.sessionId)).size;

  // Papers are presented in consecutive 12-minute slots, so the grid shows each
  // presentation time: the count is how many recommendations run at once.
  const positions = new Map(ranges.map((range) => [range.range, new Set()]));
  for (const paper of program.papers) {
    if (!paper.sessionStart) continue;
    positions.get(timeOfDay(paper.sessionStart) + '-' + timeOfDay(paper.sessionEnd))?.add(timeOfDay(paper.start));
  }
  const atTime = new Map();
  for (const row of rows) {
    if (!row.paper.sessionStart) continue;
    const key = row.paper.start;
    if (!atTime.has(key)) atTime.set(key, []);
    atTime.get(key).push(row);
  }
  const busiest = Math.max(0, ...[...atTime.values()].map((list) => list.length));
  const levelOf = (count) => (count ? Math.max(1, Math.ceil((4 * count) / busiest)) : 0);

  // Summary
  const scheduled = rows.length - videos.length;
  const summary = el('p', '', 'rec-summary');
  summary.append(plural(scheduled, 'recommended paper', 'recommended papers') + ' across ' + plural(bySlot.size, 'session block', 'session blocks'));
  if (busiest > 1) summary.append(' · up to ' + busiest + ' presented at the same time');
  if (videos.length) summary.append(' · ' + plural(videos.length, 'video presentation', 'video presentations'));
  wrap.append(summary);

  // Week overview grid: one row per presentation time, grouped by session block.
  const gridBox = el('div', '', 'week-grid-box');
  const table = el('table', '', 'week-grid');
  table.append(el('caption', 'Recommended papers presented at each time. Select a time to see those papers.'));
  const head = el('tr');
  head.append(el('th', 'Time'));
  for (const day of days) {
    const th = el('th', shortDay(Date.parse(day + 'T00:00:00Z')));
    th.scope = 'col';
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  table.append(thead);
  const savedCells = [];
  for (const range of ranges) {
    const tbody = el('tbody');
    const groupRow = el('tr', '', 'block-row');
    const groupHead = el('th', '', 'block-label');
    groupHead.append(el('span', 'Session block'), el('span', clock(range.start) + ' – ' + clock(range.end)));
    groupHead.scope = 'rowgroup';
    groupRow.append(groupHead);
    for (const day of days) {
      const slot = slots.find((item) => item.day === day && timeOfDay(item.start) + '-' + timeOfDay(item.end) === range.range);
      const slotRows = slot ? bySlot.get(slot.key) || [] : [];
      const td = el('td', slot ? (slotRows.length ? plural(slotRows.length, 'paper', 'papers') + ' · ' + plural(sessionsIn(slotRows), 'session', 'sessions') : 'None') : 'No sessions', 'block-total');
      groupRow.append(td);
    }
    tbody.append(groupRow);
    for (const offset of [...positions.get(range.range)].sort((a, b) => a - b)) {
      const tr = el('tr');
      const th = el('th', clock(offset));
      th.scope = 'row';
      tr.append(th);
      for (const day of days) {
        const td = el('td');
        const slot = slots.find((item) => item.day === day && timeOfDay(item.start) + '-' + timeOfDay(item.end) === range.range);
        if (!slot) {
          td.className = 'no-slot';
          tr.append(td);
          continue;
        }
        const time = Date.parse(day + 'T00:00:00Z') + offset;
        const cellRows = atTime.get(time) || [];
        const cell = el('button', '', 'slot-cell level-' + levelOf(cellRows.length));
        cell.type = 'button';
        cell.setAttribute('aria-pressed', state.slot === slot.key && state.time === time);
        cell.disabled = !cellRows.length;
        const savedBadge = el('span', '', 'slot-saved');
        savedCells.push([savedBadge, cellRows]);
        // Strongest recommendation first: its title is shown in the cell.
        const ordered = [...cellRows].sort((a, b) => linkCount(b) - linkCount(a) || a.paper.title.localeCompare(b.paper.title));
        if (ordered.length) {
          const head = el('span', '', 'slot-head');
          head.append(el('span', ordered.length > 1 ? ordered.length + ' papers' : '1 paper', 'slot-count'), savedBadge);
          cell.append(head, el('span', ordered[0].paper.title, 'slot-title'));
          if (ordered.length > 1) cell.append(el('span', '+ ' + (ordered.length - 1) + ' more', 'slot-more'));
          cell.setAttribute('aria-label', shortDay(time) + ' at ' + clock(time) + ': ' + ordered.map(({ paper }) => paper.title).join('; '));
          const show = () => showGridTip(cell, time, ordered);
          cell.addEventListener('mouseenter', show);
          cell.addEventListener('focus', show);
          cell.addEventListener('mouseleave', hideGridTipSoon);
          cell.addEventListener('blur', (event) => { if (!gridTip.contains(event.relatedTarget)) hideGridTipSoon(); });
          cell.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideGridTip(); });
          cell.setAttribute('aria-controls', 'grid-tip');
        } else {
          cell.append(el('span', '·', 'slot-count'), savedBadge);
          cell.setAttribute('aria-label', shortDay(time) + ' at ' + clock(time) + ': no recommended papers');
        }
        cell.addEventListener('click', () => {
          state.day = slot.day;
          state.slot = slot.key;
          state.time = time;
          repaint();
          $('#rec-slot-' + slot.start + '-' + slot.end)?.scrollIntoView({ block: 'start' });
        });
        td.append(cell);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
  }
  gridBox.append(table);
  const legend = el('p', '', 'grid-legend');
  legend.append('Papers at the same time:');
  for (let level = 1; level <= 4; level++) {
    const low = Math.floor(((level - 1) * busiest) / 4) + 1;
    const high = Math.floor((level * busiest) / 4);
    if (high < low) continue;
    const swatch = el('span', '', 'legend-swatch level-' + level);
    swatch.setAttribute('aria-hidden', 'true');
    legend.append(swatch, low === high ? String(low) : low + '–' + high);
  }
  const savedKey = el('span', '', 'legend-saved');
  savedKey.append(icon('check'), 'already in My List');
  legend.append(savedKey);
  wrap.append(gridBox, legend);

  const updateSaved = () => {
    for (const [badge, slotRows] of savedCells) {
      const count = slotRows.filter(({ paper }) => saved.has(String(paper.id))).length;
      badge.replaceChildren(...(count ? [icon('check'), String(count)] : []));
      badge.hidden = !count;
    }
  };
  updateSaved();
  refreshRecSchedule = updateSaved;

  // Day tabs
  const tabs = el('div', '', 'day-tabs rec-day-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Conference days');
  const dayCounts = new Map(days.map((day) => [day, rows.filter(({ paper }) => paper.sessionStart && dayKey(paper.sessionStart) === day).length]));
  for (const [key, label, count] of [['all', 'All days', scheduled], ...days.map((day) => [day, shortDay(Date.parse(day + 'T00:00:00Z')), dayCounts.get(day)])]) {
    const tab = el('button', label, 'day-tab');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', key === state.day);
    if (count) tab.append(el('span', String(count), 'count'));
    tab.addEventListener('click', () => {
      state.day = key;
      state.slot = null;
      state.time = null;
      repaint();
    });
    tabs.append(tab);
  }
  wrap.append(tabs);

  if (state.slot) {
    const slot = slots.find((item) => item.key === state.slot);
    const filter = el('p', '', 'slot-filter');
    filter.append('Showing ' + shortDay(slot.start) + ', ' + clock(slot.start) + ' – ' + clock(slot.end) + ' ');
    const reset = el('button', 'Show the whole day', 'text-button');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      state.slot = null;
      state.time = null;
      repaint();
    });
    filter.append(reset);
    wrap.append(filter);
  }

  // Timeline: day → time slot → session → papers
  const timeline = el('div', '', 'timeline rec-timeline');
  let lastDay;
  for (const slot of slots) {
    if (state.day !== 'all' && slot.day !== state.day) continue;
    if (state.slot && slot.key !== state.slot) continue;
    const slotRows = bySlot.get(slot.key);
    if (!slotRows) continue;
    if (slot.day !== lastDay) {
      timeline.append(el('h2', longDay(slot.start), 'day-label'));
      lastDay = slot.day;
    }
    const row = el('div', '', 'timeslot');
    row.id = 'rec-slot-' + slot.start + '-' + slot.end;
    const time = el('div', '', 'timeslot-time');
    time.append(el('h3', clock(slot.start) + ' - ' + clock(slot.end)), el('p', plural(slotRows.length, 'paper', 'papers') + ' · ' + plural(sessionsIn(slotRows), 'session', 'sessions')));
    if (sessionsIn(slotRows) > 1) time.append(el('p', 'Parallel sessions', 'parallel-note'));
    const blocks = el('div', '', 'timeslot-cards');
    const sessions = new Map();
    for (const item of slotRows) {
      if (!sessions.has(item.paper.sessionId)) sessions.set(item.paper.sessionId, []);
      sessions.get(item.paper.sessionId).push(item);
    }
    for (const sessionRows of [...sessions.values()].sort((a, b) => b.length - a.length || a[0].paper.session.localeCompare(b[0].paper.session))) {
      blocks.append(sessionBlock(sessionRows, state.time));
    }
    row.append(time, blocks);
    timeline.append(row);
  }
  if (videos.length && !state.slot) {
    timeline.append(el('h2', 'Video presentations', 'day-label'));
    const row = el('div', '', 'timeslot');
    const time = el('div', '', 'timeslot-time');
    time.append(el('h3', 'Any time'), el('p', 'Remote papers presented on video'));
    const blocks = el('div', '', 'timeslot-cards');
    blocks.append(sessionBlock(videos));
    row.append(time, blocks);
    timeline.append(row);
  }
  if (!timeline.children.length) timeline.append(el('p', 'No recommended papers on this day.', 'empty'));
  wrap.append(timeline);
  return wrap;
}

const linkCount = ({ evidence }) => new Set(evidence.map(({ id }) => id)).size;

// Hover card for the schedule grid: details of the papers in a cell, with
// buttons to add them to My List. It stays open while the pointer moves from
// the cell into the card, and it is placed right after the cell in the DOM so
// Tab moves from the cell into its buttons and on to the next cell.
const gridTip = el('div', '', 'grid-tip');
gridTip.id = 'grid-tip';
gridTip.setAttribute('role', 'group');
gridTip.hidden = true;
let gridTipCell = null;
let gridTipTimer = null;

function shortByline(paper, limit = 5) {
  const names = paper.authors.map((id) => program.authors[id]).filter(Boolean);
  return names.length > limit ? names.slice(0, limit).join(', ') + ' et al.' : names.join(', ');
}

function showGridTip(cell, time, rows) {
  clearTimeout(gridTipTimer);
  if (gridTipCell === cell && !gridTip.hidden) return; // keep focus and state
  const shown = rows.slice(0, 4);
  const items = shown.map((row) => {
    const { paper } = row;
    const item = el('article', '', 'tip-paper');
    item.style.setProperty('--type-color', paper.video ? VIDEO_COLOR : PAPER_COLOR);
    const kicker = el('p', paper.session || 'Paper', 'tip-session');
    const title = el('p', '', 'tip-paper-title');
    title.append(link(paper.title, programLink('content/' + paper.id) || paper.doi));
    const authors = el('p', shortByline(paper), 'tip-authors');
    const where = el('p', '', 'tip-where');
    where.append(icon('calendar'), clock(paper.start) + ' – ' + clock(paper.end));
    if (paper.room) where.append(icon('pin'), roomName(paper.room));
    const meta = el('div', '', 'tip-meta');
    meta.append(el('span', plural(linkCount(row), 'citation link', 'citation links')), saveButton(paper));
    item.append(kicker, title, authors, where, meta);
    return item;
  });
  const header = el('p', shortDay(time) + ' · ' + clock(time) + ' · ' + plural(rows.length, 'recommended paper', 'recommended papers'), 'tip-header');
  const footer = el('p', rows.length > shown.length ? '+ ' + (rows.length - shown.length) + ' more. Select the cell to see them all.' : 'Select the cell to see these papers in the timeline below.', 'tip-footer');
  gridTip.replaceChildren(header, ...items, footer);
  gridTip.setAttribute('aria-label', 'Recommended papers on ' + shortDay(time) + ' at ' + clock(time));
  cell.after(gridTip);
  gridTipCell = cell;
  gridTip.hidden = false;
  // Place beside the cell, flipping and clamping to stay in the viewport.
  const box = cell.getBoundingClientRect();
  const tip = gridTip.getBoundingClientRect();
  const margin = 8;
  let left = box.right + margin;
  if (left + tip.width > innerWidth - margin) left = box.left - tip.width - margin;
  left = Math.max(margin, Math.min(left, innerWidth - tip.width - margin));
  const top = Math.max(margin, Math.min(box.top, innerHeight - tip.height - margin));
  gridTip.style.left = left + 'px';
  gridTip.style.top = top + 'px';
}

function hideGridTip() {
  clearTimeout(gridTipTimer);
  gridTip.hidden = true;
  gridTipCell = null;
}
// A short delay lets the pointer cross the gap between the cell and the card.
function hideGridTipSoon() {
  clearTimeout(gridTipTimer);
  gridTipTimer = setTimeout(hideGridTip, 220);
}
gridTip.addEventListener('mouseenter', () => clearTimeout(gridTipTimer));
gridTip.addEventListener('mouseleave', hideGridTipSoon);
gridTip.addEventListener('focusout', (event) => {
  if (!gridTip.contains(event.relatedTarget) && event.relatedTarget !== gridTipCell) hideGridTipSoon();
});
gridTip.addEventListener('focusin', () => clearTimeout(gridTipTimer));
gridTip.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const cell = gridTipCell;
  hideGridTip();
  cell?.focus();
});
window.addEventListener('scroll', () => { if (!gridTip.contains(document.activeElement)) hideGridTip(); }, { passive: true });

function sessionBlock(sessionRows, highlight = null) {
  const first = sessionRows[0].paper;
  const block = el('section', '', 'program-card session-block');
  block.style.setProperty('--type-color', first.video ? VIDEO_COLOR : PAPER_COLOR);
  const header = el('div', '', 'session-head');
  const title = el('h4');
  const url = first.sessionId ? programLink('session/' + first.sessionId) : null;
  title.append(url ? link(first.session, url) : first.session || 'Session');
  header.append(title);
  if (first.room) {
    const room = el('span', '', 'session-room');
    room.append(icon('pin'), roomName(first.room));
    header.append(room);
  }
  const list = el('ol', '', 'session-papers');
  for (const { paper, evidence } of [...sessionRows].sort((a, b) => a.paper.start - b.paper.start)) {
    const item = el('li');
    const when = el('span', paper.video ? 'Video' : clock(paper.start), 'paper-time');
    const body = el('div', '', 'paper-body');
    const name = el('p', '', 'paper-title');
    name.append(link(paper.title, programLink('content/' + paper.id) || paper.doi));
    const count = new Set(evidence.map(({ id }) => id)).size;
    const meta = bylineNodes(paper, 'paper-meta');
    meta.append(' · ' + plural(count, 'citation link', 'citation links'));
    body.append(name, meta);
    if (highlight === paper.start) item.className = 'is-selected-time';
    item.append(when, body, saveButton(paper));
    list.append(item);
  }
  block.append(header, list);
  return block;
}

// ---------------------------------------------------------------------------
// Connections: who links you to the recommended papers, drawn as a network.
// Names in the citation data come from OpenAlex; they are matched to the
// program's author records of the paper they appear on.
// ---------------------------------------------------------------------------
function nameParts(name) {
  const parts = fold(name).replace(/[^\p{L}\s-]/gu, ' ').split(/[\s-]+/).filter(Boolean);
  return { full: parts.join(' '), last: parts.at(-1) || '', first: parts[0] || '' };
}

const personMatchCache = new Map();
// Returns the program person id among `candidates` that carries `name`, or null.
function matchPerson(name, candidates) {
  const key = name + '|' + candidates.join(',');
  if (personMatchCache.has(key)) return personMatchCache.get(key);
  const target = nameParts(name);
  const people = candidates.map((id) => ({ id, ...nameParts(program.authors[id] || '') }));
  const found = people.find((p) => p.full === target.full)
    || people.find((p) => p.last === target.last && p.first[0] === target.first[0])
    || (people.filter((p) => p.last === target.last).length === 1 ? people.find((p) => p.last === target.last) : null)
    || people.find((p) => p.full.includes(target.last) && target.full.includes(p.last) && p.first[0] === target.first[0]);
  const id = found ? String(found.id) : null;
  personMatchCache.set(key, id);
  return id;
}

// The CHI data sometimes has two records for one person (same name, same
// institution). Records that share a name and an institution are treated as
// one person; the smallest id stands for the group.
let canonicalIds = null;
function canonicalPerson(id) {
  if (id == null) return null;
  if (!peopleData) return String(id);
  if (!canonicalIds) {
    canonicalIds = new Map();
    const groups = new Map();
    for (const [pid, person] of Object.entries(peopleData.people)) {
      const key = nameParts(person.name || '').full;
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pid);
    }
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      const institutions = (pid) => new Set(peopleData.people[pid].affiliations.map((a) => a.split(' | ')[0].toLowerCase()));
      const components = [];
      for (const pid of ids) {
        const mine = institutions(pid);
        const hit = components.find((c) => [...mine].some((i) => c.institutions.has(i)));
        if (hit) {
          hit.ids.push(pid);
          mine.forEach((i) => hit.institutions.add(i));
        } else {
          components.push({ ids: [pid], institutions: mine });
        }
      }
      for (const component of components) {
        const root = [...component.ids].sort((a, b) => Number(a) - Number(b))[0];
        for (const pid of component.ids) canonicalIds.set(pid, root);
      }
    }
  }
  return canonicalIds.get(String(id)) || String(id);
}

function personAliases(id) {
  const root = canonicalPerson(id);
  const ids = [String(id)];
  if (canonicalIds) for (const [pid, value] of canonicalIds) if (value === root && !ids.includes(pid)) ids.push(pid);
  return ids;
}

// Recommended papers and their authors. An author is linked to every
// recommended paper they wrote, so shared authors join papers into groups.
// Author colour says how they relate to you through citations.
function buildPaperAuthorGraph(papers, snapshot, includeModes, source, paperLimit, sharedOnly) {
  const scored = [];
  for (const paper of papers) {
    const match = snapshot.matches[paper.id];
    const evidence = includeModes.map((mode) => [mode, evidenceFor(match, mode, source)]).filter(([, list]) => list.length);
    if (!evidence.length) continue;
    const works = new Set(evidence.flatMap(([, list]) => list.map(({ id }) => id)));
    scored.push({ paper, evidence, strength: works.size });
  }
  scored.sort((a, b) => b.strength - a.strength || a.paper.title.localeCompare(b.paper.title));
  const keptPapers = scored.slice(0, paperLimit);

  const authors = new Map();
  for (const { paper, evidence } of keptPapers) {
    for (const rawId of paper.authors) {
      const personId = canonicalPerson(rawId);
      const id = 'u' + personId;
      if (!authors.has(id)) authors.set(id, { id, kind: 'person', personId, name: program.authors[rawId] || 'Unknown author', oaNames: new Set(), relations: new Set(), works: new Set(), paperIds: new Set() });
      authors.get(id).paperIds.add('p' + paper.id);
    }
    for (const [mode, list] of evidence) {
      if (mode === 'direct') continue;
      for (const { id: work, name } of list) {
        const author = authors.get('u' + canonicalPerson(matchPerson(name, paper.authors)));
        if (!author) continue;
        author.relations.add(mode);
        author.works.add(work);
        author.oaNames.add(name);
      }
    }
  }
  for (const author of authors.values()) {
    author.papers = author.paperIds.size;
    author.weight = author.works.size;
  }
  const allAuthors = [...authors.values()];
  const shared = allAuthors.filter((a) => a.papers > 1);
  const keptAuthors = (sharedOnly ? shared : allAuthors)
    .sort((a, b) => b.papers - a.papers || b.weight - a.weight || a.name.localeCompare(b.name));
  keptAuthors.forEach((author, index) => { author.rank = index; });

  const paperNodes = keptPapers.map(({ paper, strength }, index) => ({
    id: 'p' + paper.id, kind: 'paper', paper, strength, rank: index,
    when: paper.start ? shortDay(paper.start) + ' | ' + timeRange(paper) : '',
  }));
  const links = [];
  for (const author of keptAuthors) for (const paperId of author.paperIds) links.push({ source: author.id, target: paperId });

  // Connected groups of papers (through shared authors), for the summary.
  const parent = new Map(paperNodes.map((n) => [n.id, n.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const author of shared) {
    const [first, ...rest] = [...author.paperIds];
    for (const other of rest) parent.set(find(other), find(first));
  }
  const groupSizes = new Map();
  for (const n of paperNodes) groupSizes.set(find(n.id), (groupSizes.get(find(n.id)) || 0) + 1);
  const groups = [...groupSizes.values()].filter((size) => size > 1).sort((a, b) => b - a);

  // With "only shared" authors, papers that share nobody add nothing: hide them.
  const linked = new Set(links.map((l) => l.target));
  const shownPapers = sharedOnly ? paperNodes.filter((n) => linked.has(n.id)) : paperNodes;
  return {
    nodes: [...shownPapers, ...keptAuthors], links,
    papers: shownPapers, hiddenPapers: paperNodes.length - shownPapers.length, consideredPapers: paperNodes.length, authors: keptAuthors, sharedAuthors: shared.sort((a, b) => b.papers - a.papers || b.weight - a.weight || a.name.localeCompare(b.name)),
    totalPapers: scored.length, totalAuthors: allAuthors.length, groups,
    summary: 'Network of ' + paperNodes.length + ' recommended papers and ' + keptAuthors.length + ' of their authors',
  };
}

function relationOfNode(node) {
  const incoming = node.relations.has('incoming');
  const outgoing = node.relations.has('outgoing');
  return incoming && outgoing ? 'both' : incoming ? 'incoming' : outgoing ? 'outgoing' : 'none';
}

const RELATION_LABELS = { incoming: 'Cites your work', outgoing: 'You cite their work', both: 'Both directions', none: 'No direct citation link' };
const RELATION_COLORS = { incoming: '#3d63d6', outgoing: '#d9822b', both: '#7a55c7', none: '#b3bac8' };
let networkHandle = null;

function recommendationNetwork(papers, snapshot, mode, source, state, repaint) {
  networkHandle?.destroy();
  networkHandle = null;
  if (!peopleData) {
    // People data merges duplicate program records; load it first. The
    // placeholder has the canvas's height so nothing jumps when it arrives.
    const waiting = el('div', '', 'network-canvas network-waiting');
    waiting.append(el('p', 'Loading the network…', 'network-loading'));
    loadPeople().then(() => { if (waiting.isConnected) repaint(); })
      .catch(() => { peoplePromise = null; waiting.replaceChildren(el('p', 'Program data could not be loaded. Switch views to retry.', 'network-loading')); });
    return waiting;
  }
  const wrap = el('div', '', 'rec-network');
  const includeModes = state.relations === 'all' ? Object.keys(modes) : [mode];
  const graph = buildPaperAuthorGraph(papers, snapshot, includeModes, source, state.limit, state.shared);

  const controls = el('div', '', 'network-controls');
  const toggle = (label, options, current, onPick) => {
    const group = el('div', '', 'segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    group.append(el('span', label, 'segmented-label'));
    for (const [key, text] of options) {
      const button = el('button', text);
      button.type = 'button';
      button.setAttribute('aria-pressed', current === key);
      button.addEventListener('click', () => onPick(key));
      group.append(button);
    }
    return group;
  };
  controls.append(
    toggle('Papers from', [['tab', 'This tab'], ['all', 'All three tabs']], state.relations, (key) => { state.relations = key; repaint(); }),
    toggle('Authors', [[false, 'All'], [true, 'Only shared']], state.shared, (key) => { state.shared = key; repaint(); }),
  );
  const limit = selectControl('Papers', [['all', 'All'], ['100', 'Top 100'], ['50', 'Top 50'], ['25', 'Top 25']]);
  limit.control.value = state.limit === Infinity ? 'all' : String(state.limit);
  limit.control.addEventListener('change', () => {
    state.limit = limit.control.value === 'all' ? Infinity : Number(limit.control.value);
    repaint();
  });
  limit.label.classList.add('network-limit');
  controls.append(limit.label);

  const summary = el('p', '', 'rec-summary');
  const biggest = graph.groups[0];
  summary.append(
    plural(graph.papers.length, 'recommended paper', 'recommended papers') + (graph.consideredPapers < graph.totalPapers ? ' (from the strongest ' + graph.consideredPapers + ' of ' + graph.totalPapers + ')' : '') +
    (graph.hiddenPapers ? ' · ' + graph.hiddenPapers + ' without shared authors hidden' : '') +
    ' · ' + plural(graph.authors.length, 'author', 'authors') +
    ' · ' + plural(graph.sharedAuthors.length, 'author', 'authors') + ' on more than one paper' +
    (graph.groups.length ? ' · ' + plural(graph.groups.length, 'group', 'groups') + ' of papers linked by shared authors' + (biggest > 2 ? ' (largest: ' + biggest + ' papers)' : '') : ''),
  );

  const legend = el('p', '', 'network-legend');
  const paperKey = el('span', '', 'legend-square');
  const savedKey = el('span', '', 'legend-square is-saved');
  legend.append(paperKey, 'Recommended paper (larger = more citation links)', savedKey, 'In My List');
  const present = new Set(graph.authors.map(relationOfNode));
  for (const key of ['incoming', 'outgoing', 'both', 'none']) {
    if (!present.has(key)) continue;
    const dot = el('span', '', 'legend-dot');
    dot.style.background = RELATION_COLORS[key];
    legend.append(dot, 'Author: ' + RELATION_LABELS[key].toLowerCase());
  }
  const multi = el('span', '', 'legend-multi');
  multi.setAttribute('aria-hidden', 'true');
  legend.append(multi, 'Author of several (count)');

  const layout = el('div', '', 'network-layout');
  const canvas = el('div', '', 'network-canvas');
  canvas.append(el('p', 'Drawing the network…', 'network-loading'));
  const side = el('aside', '', 'network-side');
  side.setAttribute('aria-label', 'Shared authors');
  side.append(el('h3', 'Authors on several recommended papers'));
  const list = el('ol', '', 'connection-list');
  for (const node of graph.sharedAuthors.slice(0, 40)) {
    const item = el('li');
    const button = el('button', '', 'connection-person');
    button.type = 'button';
    const dot = el('span', '', 'legend-dot');
    dot.style.background = RELATION_COLORS[relationOfNode(node)];
    const text = el('span', '', 'connection-text');
    text.append(el('span', node.name, 'connection-name'), el('span', plural(node.papers, 'paper', 'papers') + ' · ' + RELATION_LABELS[relationOfNode(node)] + (node.weight ? ' (' + plural(node.weight, 'work', 'works') + ')' : ''), 'connection-meta'));
    button.append(dot, text);
    button.addEventListener('click', () => openPerson(node));
    button.addEventListener('mouseenter', () => networkHandle?.highlight(node.id));
    button.addEventListener('mouseleave', () => networkHandle?.highlight(null));
    item.append(button);
    list.append(item);
  }
  if (!graph.sharedAuthors.length) side.append(el('p', 'No author appears on more than one of these papers.', 'empty'));
  side.append(list);
  layout.append(canvas, side);
  wrap.append(controls, summary, legend, layout);

  const drawOptions = {
    colorOf: (node) => RELATION_COLORS[relationOfNode(node)],
    relationText: (node) => RELATION_LABELS[relationOfNode(node)],
    onPerson: (node) => openPerson(node),
    onPaper: (paper) => openPaper(paper),
    isSaved: (paper) => saved.has(String(paper.id)),
  };
  // Microtasks run before the browser paints: if network.js and d3 are already
  // loaded, the graph is drawn in place of the placeholder without a flash.
  queueMicrotask(async () => {
    try {
      const module = networkModule || await loadNetworkModule();
      if (!canvas.isConnected) return;
      networkHandle = module.drawNetworkNow(canvas, graph, drawOptions) || await module.drawNetwork(canvas, graph, drawOptions);
    } catch {
      canvas.replaceChildren(el('p', 'The network could not be drawn. Check your connection and switch views to retry.', 'empty'));
    }
  });
  return wrap;
}

// Loading for the Network view: people data, network.js and d3. Started on
// hover/focus of the Network button so it is usually ready by the click.
let networkModule = null;
let networkModulePromise = null;
function loadNetworkModule() {
  networkModulePromise ??= import('./network.js').then(async (module) => {
    await module.preloadNetwork();
    networkModule = module;
    return module;
  });
  return networkModulePromise;
}
let peoplePromise = null;
function loadPeople() {
  peoplePromise ??= readJSON('people.json').then((data) => { peopleData = data; return data; });
  return peoplePromise;
}
function preloadNetworkView() {
  loadPeople().catch(() => { peoplePromise = null; });
  loadNetworkModule().catch(() => { networkModulePromise = null; });
}

// ---------------------------------------------------------------------------
// Person and paper details (from the CHI program data)
// ---------------------------------------------------------------------------
let peopleData;
let currentContext = null; // { author, snapshot } of the results on screen
const detailDialog = el('dialog', '', 'detail-dialog');
detailDialog.setAttribute('aria-labelledby', 'detail-title');
document.body.append(detailDialog);
detailDialog.addEventListener('click', (event) => { if (event.target === detailDialog) detailDialog.close(); });

function showDetail(children) {
  const close = el('button', '', 'icon-button dialog-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', () => detailDialog.close());
  const body = el('div', '', 'detail-body');
  body.append(...children);
  detailDialog.replaceChildren(close, body);
  if (!detailDialog.open) detailDialog.showModal();
  detailDialog.scrollTop = 0;
  body.querySelector('h2')?.focus();
}

function personButton(personId, name = program.authors[personId]) {
  const button = el('button', name || 'Unknown author', 'person-link');
  button.type = 'button';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    openPerson({ personId: String(personId), name });
  });
  return button;
}

function bylineNodes(paper, className = 'byline') {
  const line = el('p', '', className);
  paper.authors.forEach((id, index) => {
    if (index) line.append(', ');
    line.append(personButton(id));
  });
  return line;
}

// Evidence that links a program person to the selected author, across all papers.
function connectionEvidence(personId, oaNames = new Set()) {
  if (!currentContext) return null;
  const { snapshot } = currentContext;
  const result = { incoming: new Map(), outgoing: new Map() };
  for (const paper of program.papers) {
    const match = snapshot.matches[paper.id];
    if (!match) continue;
    for (const mode of ['incoming', 'outgoing']) {
      for (const [name, edges] of Object.entries(match[mode])) {
        const same = personId ? canonicalPerson(matchPerson(name, paper.authors)) === personId : oaNames.has(name);
        if (!same) continue;
        for (const [work, trail] of edges) {
          if (!result[mode].has(work)) result[mode].set(work, new Set());
          for (const entry of trail) result[mode].get(work).add(Array.isArray(entry) ? entry[0] : entry);
        }
      }
    }
  }
  return result;
}

function workLine(work) {
  const line = el('p', '', 'work-line');
  line.append(link(work.title, work.url), ' · ' + work.venue + (work.year ? ' · ' + work.year : ''));
  if (work.sigchi) line.append(' ', sigchiTag(work.sigchi));
  return line;
}

function contentCard(content, id, recommended) {
  const card = el('article', '', 'program-card detail-item');
  card.style.setProperty('--type-color', content.color || PAPER_COLOR);
  const main = el('div', '', 'program-card-main');
  const kicker = el('p', '', 'kicker');
  const type = el('span', content.type || 'Program item', 'type-name');
  type.style.setProperty('--type-color', content.color || PAPER_COLOR);
  kicker.append(type);
  if (recommended) kicker.append(el('span', 'Recommended for ' + currentContext.author.name, 'tag'));
  const title = el('h3');
  title.append(link(content.title, programLink('content/' + id) || content.doi));
  main.append(kicker, title);
  const paper = papersById.get(String(id));
  main.append(bylineNodes({ authors: content.authors }));
  main.append(whenRow({ ...content, id, video: content.video }));
  card.append(main);
  if (paper) {
    const side = el('div', '', 'program-card-side');
    side.append(saveButton(paper));
    card.append(side);
  }
  return card;
}

async function openPerson(node) {
  const personId = node.personId ? String(node.personId) : null;
  showDetail([el('p', 'Loading…', 'empty')]);
  try {
    peopleData ??= await readJSON('people.json');
  } catch {
    showDetail([el('p', 'Program details could not be loaded. Try again in a moment.', 'empty')]);
    return;
  }
  const canonical = personId ? canonicalPerson(personId) : null;
  const aliases = canonical ? personAliases(canonical) : [];
  const records = aliases.map((id) => peopleData.people[id]).filter(Boolean);
  const person = records.length ? {
    name: records[0].name,
    affiliations: [...new Set(records.flatMap((r) => r.affiliations))],
    contents: [...new Set(records.flatMap((r) => r.contents))],
    chairs: [...new Set(records.flatMap((r) => r.chairs))],
  } : null;
  const name = person?.name || node.name;
  const parts = [];
  const heading = el('h2', name);
  heading.id = 'detail-title';
  heading.tabIndex = -1;
  parts.push(el('p', 'CHI 2026 person', 'section-label'), heading);
  for (const affiliation of person?.affiliations || []) {
    const line = el('p', '', 'affiliation');
    line.append(el('span', '', 'affiliation-dot'), affiliation);
    parts.push(line);
  }
  const links = el('p', '', 'detail-links');
  if (personId) links.append(link('Open in SIGCHI program', 'https://programs.sigchi.org/chi/2026/authors/' + personId));
  if (links.childNodes.length) parts.push(links);
  if (records.length > 1) parts.push(el('p', 'The CHI program lists ' + name + ' under ' + records.length + ' records with the same name and institution; they are combined here.', 'merge-note'));

  // Why this person is connected to the author whose results are open.
  const evidence = connectionEvidence(canonical, node.oaNames);
  if (currentContext && evidence && (evidence.incoming.size || evidence.outgoing.size)) {
    const { snapshot, author } = currentContext;
    const section = el('section', '', 'detail-section');
    section.append(el('h3', 'Connection to ' + author.name));
    if (evidence.incoming.size) {
      section.append(el('p', plural(evidence.incoming.size, 'work', 'works') + ' by ' + name + ' cite ' + author.name + '’s work', 'relation-heading is-incoming'));
      const list = el('ul', '', 'evidence-list');
      for (const [work, cited] of evidence.incoming) {
        const item = el('li');
        item.append(workLine(snapshot.works[work]));
        for (const ref of cited) {
          const sub = el('p', 'References ');
          addWork(sub, snapshot.works[ref]);
          item.append(sub);
        }
        list.append(item);
      }
      section.append(list);
    }
    if (evidence.outgoing.size) {
      section.append(el('p', author.name + ' cites ' + plural(evidence.outgoing.size, 'work', 'works') + ' by ' + name, 'relation-heading is-outgoing'));
      const list = el('ul', '', 'evidence-list');
      for (const [work, sources] of evidence.outgoing) {
        const item = el('li');
        item.append(workLine(snapshot.works[work]));
        for (const ref of sources) {
          const sub = el('p', 'Cited in ');
          addWork(sub, snapshot.works[ref]);
          item.append(sub);
        }
        list.append(item);
      }
      section.append(list);
    }
    parts.push(section);
  }

  const recommended = new Set(currentContext ? Object.keys(currentContext.snapshot.matches) : []);
  const items = (person?.contents || []).map((id) => [id, peopleData.contents[id]]).filter(([, content]) => content)
    .sort(([, a], [, b]) => (a.start ?? Infinity) - (b.start ?? Infinity));
  const programSection = el('section', '', 'detail-section');
  programSection.append(el('h3', 'Program items (' + items.length + ')'));
  if (!items.length) programSection.append(el('p', personId ? 'No program items listed.' : name + ' is not listed as an author in the CHI 2026 program.', 'empty'));
  for (const [id, content] of items) programSection.append(contentCard(content, id, recommended.has(String(id))));
  parts.push(programSection);

  const chairs = (person?.chairs || []).map((id) => [id, peopleData.sessions[id]]).filter(([, session]) => session);
  if (chairs.length) {
    const section = el('section', '', 'detail-section');
    section.append(el('h3', 'Session chair'));
    for (const [id, session] of chairs) {
      const line = el('div', '', 'when chair-line');
      const name = el('span', '', 'when-time');
      name.append(link(session.name, programLink('session/' + id)));
      if (session.start) name.append(' · ' + shortDay(session.start) + ' | ' + clock(session.start) + ' - ' + clock(session.end));
      line.append(name);
      if (session.room) {
        const room = el('span', '', 'when-room');
        room.append(icon('pin'), roomName(session.room));
        line.append(room);
      }
      section.append(line);
    }
    parts.push(section);
  }
  showDetail(parts);
}

function openPaper(paper) {
  const parts = [];
  const heading = el('h2', paper.title);
  heading.id = 'detail-title';
  heading.tabIndex = -1;
  const header = el('div', '', 'card-header');
  header.append(cardKicker(paper), saveButton(paper));
  parts.push(header, heading, bylineNodes(paper), whenRow(paper));
  const links = el('p', '', 'detail-links');
  links.append(link('Open in ACM DL', paper.doi));
  parts.push(links);
  const match = currentContext?.snapshot.matches[paper.id];
  if (match) {
    const section = el('section', '', 'detail-section');
    section.append(el('h3', 'Why it is recommended'));
    for (const key of Object.keys(modes)) {
      const evidence = evidenceFor(match, key, 'all');
      if (evidence.length) section.append(el('p', modes[key][0] + ': ' + plural(new Set(evidence.map(({ id }) => id)).size, 'work', 'works'), 'relation-heading'));
    }
    parts.push(section);
  }
  showDetail(parts);
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
  const profileLink = profile.orcid ? link('ORCID profile', profile.orcid)
    : profile.dblp ? link('DBLP profile', profile.dblp) : link('OpenAlex profile', 'https://openalex.org/' + profile.openalex);
  metadata.append(profileLink, ' · ' + snapshot.authoredWorks + ' indexed publications');
  if (profile.orcid && profile.openalex) metadata.append(' · ', link('OpenAlex profile', 'https://openalex.org/' + profile.openalex));
  if (snapshot.ownPapers) metadata.append(' · ' + snapshot.ownPapers + (snapshot.ownPapers === 1 ? ' CHI 2026 paper (excluded)' : ' CHI 2026 papers (excluded)'));
  let liveNote = null;
  if (snapshot.live) {
    const note = el('p', '', 'live-note');
    note.append(snapshot.cachedAt
      ? 'Saved in this browser on ' + new Date(snapshot.cachedAt).toLocaleDateString() + ' and loaded without OpenAlex requests. '
      : 'Computed from OpenAlex just now (' + snapshot.requests + ' requests) and saved in this browser. ');
    const refresh = el('button', 'Recompute', 'text-button');
    refresh.type = 'button';
    refresh.title = 'Fetch fresh data from OpenAlex (uses the daily budget)';
    refresh.addEventListener('click', () => loadLive(snapshot.live, true, snapshot.programAuthor));
    note.append(refresh);
    if (snapshot.programAuthor) {
      const other = el('button', 'Choose another profile', 'text-button');
      other.type = 'button';
      other.addEventListener('click', () => lookupAuthors(snapshot.programAuthor.name, snapshot.programAuthor));
      note.append(' · ', other);
    }
    liveNote = note;
  }
  const toolbar = el('div', '', 'toolbar');
  const description = el('p');
  description.setAttribute('aria-live', 'polite');
  const filters = el('div', '', 'filters');
  const source = selectControl('Cited in', [['all', 'All my work'], ['chi', 'My CHI 2026 work'], ['other', 'My other work']]);
  const grouping = selectControl('Group by', [['none', 'None'], ['venue', 'Evidence venue']]);
  const layoutToggle = el('div', '', 'layout-toggle');
  layoutToggle.setAttribute('role', 'group');
  layoutToggle.setAttribute('aria-label', 'Show recommendations as');
  const layoutButtons = {};
  for (const [key, label] of [['list', 'List'], ['schedule', 'Schedule'], ['network', 'Network']]) {
    const button = el('button', '', 'layout-button');
    button.type = 'button';
    button.append(icon({ list: 'rows', schedule: 'calendar', network: 'network' }[key]), label);
    if (key === 'network') {
      button.addEventListener('pointerenter', preloadNetworkView, { once: true });
      button.addEventListener('focus', preloadNetworkView, { once: true });
    }
    button.addEventListener('click', () => {
      recLayout = key;
      paint();
    });
    layoutButtons[key] = button;
    layoutToggle.append(button);
  }
  filters.append(source.label, grouping.label, layoutToggle);
  toolbar.append(description, filters);
  const cards = el('div', '', 'papers');
  const more = el('button', 'Show more papers', 'load-more');
  more.type = 'button';
  const coverage = el('p', 'OpenAlex matched ' + snapshot.indexedPapers.toLocaleString() + ' of ' + program.papers.length.toLocaleString() + ' main-track papers in the program. It had linked references for ' + snapshot.papersWithReferences.toLocaleString() + ' of them. Recommendations reflect indexed citations and author records.', 'coverage');
  results.replaceChildren(el('p', 'Recommendations for', 'section-label'), el('h2', author.name), metadata, ...(liveNote ? [liveNote] : []), views, toolbar, cards, more, coverage);

  let mode = 'direct';
  let limit = PAGE_SIZE;
  const schedule = { day: 'all', slot: null, time: null };
  let keepToolbar = () => {};
  const network = { relations: 'tab', limit: Infinity, shared: false }; // all papers by default
  currentContext = { author, snapshot };
  refreshRecSchedule = null;
  const buttons = {};
  for (const [key, [label]] of Object.entries(modes)) {
    const button = el('button', label);
    button.type = 'button';
    button.append(el('span', String(papers.filter((paper) => evidenceFor(snapshot.matches[paper.id], key, 'all').length).length), 'count'));
    button.addEventListener('click', () => {
      mode = key;
      limit = PAGE_SIZE;
      Object.assign(schedule, { slot: null, time: null });
      paint();
    });
    buttons[key] = button;
    views.append(button);
  }
  const compareVenue = (a, b) => Number(Boolean(b.sigchi)) - Number(Boolean(a.sigchi)) || a.name.localeCompare(b.name);

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
    for (const [key, button] of Object.entries(layoutButtons)) button.setAttribute('aria-pressed', key === recLayout);
    grouping.label.hidden = recLayout !== 'list';
    networkHandle?.destroy();
    networkHandle = null;
    hideGridTip();
    const anchor = toolbar.isConnected ? toolbar.getBoundingClientRect().top : null;
    keepToolbar = () => {
      if (anchor === null) return;
      const shift = toolbar.getBoundingClientRect().top - anchor;
      if (Math.abs(shift) > 1) window.scrollBy(0, shift);
    };
    queueMicrotask(() => keepToolbar());
    cards.replaceChildren();
    if (recLayout === 'network') {
      refreshRecSchedule = null;
      cards.append(recommendationNetwork(papers, snapshot, mode, source.control.value, network, paint));
      more.hidden = true;
      return;
    }
    if (recLayout === 'schedule') {
      cards.append(recommendationSchedule(rows, schedule, paint));
      more.hidden = true;
      return;
    }
    refreshRecSchedule = null;
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
        if (group.sigchi) heading.append(' ', sigchiTag(group.sigchi));
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

// ---------------------------------------------------------------------------
// Authors outside the prebuilt snapshots (OpenAlex)
// ---------------------------------------------------------------------------
function budgetMessage() {
  const box = el('div', '', 'notice');
  box.append(el('p', getApiKey()
    ? 'Your OpenAlex API key has reached its daily budget. Try again tomorrow.'
    : 'OpenAlex limits anonymous use to a small daily budget shared by everyone on your network, and it is used up. Add a free OpenAlex API key to continue.'));
  box.append(apiKeyForm());
  return box;
}

function apiKeyForm() {
  const form = el('form', '', 'key-form');
  const label = el('label', 'OpenAlex API key');
  const field = el('input');
  field.type = 'password';
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.value = getApiKey();
  field.placeholder = 'Paste your key';
  label.append(field);
  const save = el('button', 'Save key', 'secondary-button');
  save.type = 'submit';
  const help = el('p', 'Get a free key with its own daily budget at ', 'key-help');
  help.append(link('openalex.org/settings/api', 'https://openalex.org/settings/api'), '. The key is stored only in this browser.');
  form.append(label, save, help);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    setApiKey(field.value);
    save.textContent = field.value.trim() ? 'Saved' : 'Removed';
    setTimeout(() => { save.textContent = 'Save key'; }, 1500);
  });
  return form;
}

async function lookupAuthors(text, programAuthor, refresh = false) {
  const version = beginSelection(programAuthor ? programAuthor.name : text);
  selected = programAuthor;
  status.textContent = 'Searching OpenAlex for ' + text + '…';
  let found;
  let cachedAt;
  try {
    ({ results: found, cachedAt } = await findAuthors(text, undefined, { refresh }));
  } catch (error) {
    if (version !== selectionVersion) return;
    status.textContent = '';
    results.replaceChildren(error instanceof BudgetError ? budgetMessage() : el('p', 'OpenAlex could not be reached. Try again in a moment.', 'empty'));
    results.hidden = false;
    return;
  }
  if (version !== selectionVersion) return;
  // Profiles listed on a CHI 2026 paper are most likely the right person.
  try { programWorks ??= await readJSON('program-works.json'); } catch { /* optional hint */ }
  if (version !== selectionVersion) return;
  const onProgram = new Map();
  for (const entry of Object.values(programWorks || {})) {
    for (const [id] of entry.authors) onProgram.set(id, (onProgram.get(id) || 0) + 1);
  }
  found.sort((a, b) => (onProgram.get(b.id) || 0) - (onProgram.get(a.id) || 0));
  status.textContent = '';
  const heading = el('h2', programAuthor ? 'Which OpenAlex profile is ' + programAuthor.name + '?' : 'OpenAlex profiles for “' + text + '”');
  const hint = el('p', programAuthor
    ? programAuthor.name + ' is in the CHI 2026 program, but has no prebuilt citation data. Choose the matching OpenAlex profile to compute recommendations.'
    : 'Choose the profile to compute CHI 2026 recommendations from its citations. Check the institution and topic to pick the right person.', 'meta');
  hint.append(' OpenAlex sometimes splits one person across several profiles; the one with the most works usually gives the fullest results.');
  const cacheNote = el('p', '', 'cache-note');
  if (cachedAt) {
    cacheNote.append(el('span', 'Saved search from ' + new Date(cachedAt).toLocaleDateString() + ', shown without an OpenAlex request.'));
    const again = el('button', 'Search OpenAlex again', 'text-button');
    again.type = 'button';
    again.addEventListener('click', () => lookupAuthors(text, programAuthor, true));
    cacheNote.append(again);
  }
  const saved = await Promise.all(found.map((candidate) => hasSnapshot(candidate.id)));
  if (version !== selectionVersion) return;
  const list = el('div', '', 'candidates');
  for (const [index, candidate] of found.entries()) {
    const card = el('article', '', 'candidate');
    const info = el('div');
    const name = el('h3', candidate.name);
    const papers = onProgram.get(candidate.id);
    if (papers) name.append(' ', el('span', papers + (papers === 1 ? ' CHI 2026 paper' : ' CHI 2026 papers'), 'tag'));
    if (saved[index]) name.append(el('span', 'Saved', 'saved-tag'));
    info.append(name);
    const facts = [candidate.institution, candidate.topic].filter(Boolean).join(' · ');
    if (facts) info.append(el('p', facts, 'candidate-facts'));
    const numbers = el('p', (candidate.works ?? 0).toLocaleString() + (candidate.works === 1 ? ' work · ' : ' works · ') + (candidate.citations ?? 0).toLocaleString() + ' citations', 'candidate-facts');
    if (candidate.orcid) numbers.append(' · ', link('ORCID', candidate.orcid));
    numbers.append(' · ', link('OpenAlex', 'https://openalex.org/' + candidate.id));
    info.append(numbers);
    const use = el('button', saved[index] ? 'Show saved recommendations' : 'Show recommendations', 'primary-button');
    use.type = 'button';
    use.addEventListener('click', () => loadLive(candidate, false, programAuthor));
    card.append(info, use);
    list.append(card);
  }
  if (!found.length) list.append(el('p', 'OpenAlex found no matching authors. Try another spelling, or paste an ORCID.', 'empty'));
  results.replaceChildren(el('p', 'Find an author', 'section-label'), heading, hint, ...(cachedAt ? [cacheNote] : []), list);
  results.hidden = false;
}

async function loadLive(candidate, refresh = false, programAuthor = null) {
  const version = beginSelection(programAuthor ? programAuthor.name : candidate.name);
  selected = { id: candidate.id, name: candidate.name };
  liveController = new AbortController();
  status.textContent = 'Loading recommendations for ' + candidate.name + '…';
  try {
    programWorks ??= await readJSON('program-works.json');
    const snapshot = await buildSnapshot(candidate, program, programWorks, {
      refresh,
      signal: liveController.signal,
      onProgress: (message) => { if (version === selectionVersion) status.textContent = message; },
    });
    if (programAuthor) await rememberChoice(programAuthor.id, candidate);
    await refreshSavedAuthors();
    if (version !== selectionVersion) return;
    snapshot.live = candidate;
    snapshot.programAuthor = programAuthor;
    renderResults(selected, { openalex: candidate.id, orcid: candidate.orcid }, snapshot);
    status.textContent = '';
    results.hidden = false;
  } catch (error) {
    if (version !== selectionVersion || error.name === 'AbortError') return;
    status.textContent = '';
    if (error instanceof BudgetError) {
      results.replaceChildren(budgetMessage());
    } else {
      const retry = el('button', 'Try again', 'secondary-button');
      retry.type = 'button';
      retry.addEventListener('click', () => loadLive(candidate, refresh, programAuthor));
      const box = el('div', '', 'notice');
      box.append(el('p', 'Recommendations could not be computed: ' + error.message), retry);
      results.replaceChildren(box);
    }
    results.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// My List and My Schedule
// Saved papers live in this browser's localStorage. Program timestamps are the
// conference's wall-clock time encoded as UTC, so they are formatted in UTC.
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'chi2026-citation-explorer:my-list';
// Type colours follow the SIGCHI program app; the defaults are replaced by
// the colours in program.json once it loads.
let PAPER_COLOR = '#0d42cc';
let VIDEO_COLOR = '#ffc034'; // the program's "Event" type (video presentations)
function applyTypeColors(types = {}) {
  PAPER_COLOR = types.Paper?.color || PAPER_COLOR;
  VIDEO_COLOR = types.Event?.color || VIDEO_COLOR;
  document.documentElement.style.setProperty('--paper-color', PAPER_COLOR);
  document.documentElement.style.setProperty('--video-color', VIDEO_COLOR);
}
const listView = $('#list-view');
const scheduleView = $('#schedule-view');
const explorerView = $('#explorer-view');
const listItems = $('#list-items');
const scheduleItems = $('#schedule-items');
const dayTabs = $('.day-tabs');
let papersById = new Map();
let listSort = 'time';
let scheduleDay = 'all';
let currentRoute = 'explorer';

function readSaved() {
  try {
    const entries = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Map(entries.filter((entry) => entry && entry.id != null).map((entry) => [String(entry.id), Number(entry.addedAt) || 0]));
  } catch {
    return new Map();
  }
}
let saved = readSaved();

function writeSaved() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...saved].map(([id, addedAt]) => ({ id, addedAt }))));
  } catch {
    // Storage can be unavailable (private mode); the list still works for this visit.
  }
}

function toggleSaved(paper) {
  const id = String(paper.id);
  if (saved.has(id)) saved.delete(id);
  else saved.set(id, Date.now());
  writeSaved();
  savedChanged();
}

function savedPapers() {
  return [...saved.keys()].map((id) => papersById.get(id)).filter(Boolean);
}

const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const longDayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });

function shortDay(ms) {
  const parts = Object.fromEntries(dayFormat.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return parts.weekday + ', ' + parts.day + ' ' + parts.month;
}
function longDay(ms) {
  const parts = Object.fromEntries(longDayFormat.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return parts.weekday + ', ' + parts.day + ' ' + parts.month;
}
const clock = (ms) => timeFormat.format(new Date(ms));
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const roomName = (room) => (room || '').replace(' - ', ' · ');

function timeRange(paper) {
  if (paper.video) return 'Video presentation · from ' + clock(paper.start);
  return clock(paper.start) + ' - ' + clock(paper.end);
}

function byline(paper) {
  return paper.authors.map((id) => program.authors[id]).filter(Boolean).join(', ');
}

function programLink(path) {
  return program.conference ? program.conference.programUrl + '/program/' + path : null;
}

function icon(name) {
  const node = el('span', '', 'icon icon-' + name);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function cardKicker(paper) {
  const kicker = el('p', '', 'kicker');
  const type = el('span', paper.video ? 'Video' : 'Papers', 'type-name');
  type.style.setProperty('--type-color', paper.video ? VIDEO_COLOR : PAPER_COLOR);
  kicker.append(type);
  if (paper.session) {
    const url = paper.sessionId ? programLink('session/' + paper.sessionId) : null;
    kicker.append(url ? link(paper.session, url) : el('span', paper.session));
  }
  return kicker;
}

function whenRow(paper) {
  const row = el('div', '', 'when');
  if (!paper.start) {
    row.append(el('span', 'Schedule not published', 'when-time'));
    return row;
  }
  const time = el('span', '', 'when-time');
  time.append(icon('calendar'), shortDay(paper.start) + ' | ' + timeRange(paper));
  row.append(time);
  if (paper.room) {
    const room = el('span', '', 'when-room');
    room.append(icon('pin'), roomName(paper.room));
    row.append(room);
  }
  const url = programLink('content/' + paper.id);
  if (url) {
    const open = link('Open in program', url);
    open.className = 'when-link';
    row.append(open);
  }
  return row;
}

function saveButton(paper) {
  const button = el('button', '', 'save-toggle');
  button.type = 'button';
  button.dataset.paperId = paper.id;
  button.addEventListener('click', () => toggleSaved(paper));
  paintSaveButton(button);
  return button;
}

function paintSaveButton(button) {
  const isSaved = saved.has(button.dataset.paperId);
  button.setAttribute('aria-pressed', isSaved);
  button.replaceChildren(icon(isSaved ? 'check' : 'clock'), isSaved ? 'In My List' : 'Add to My List');
}

// Two saved talks overlap when their time ranges intersect. Video presentations
// are available asynchronously, so they never conflict.
function overlapsFor(papers) {
  const timed = papers.filter((paper) => paper.start && !paper.video).sort((a, b) => a.start - b.start);
  const overlaps = new Map();
  for (const [i, a] of timed.entries()) {
    for (const b of timed.slice(i + 1)) {
      if (b.start >= a.end) break;
      for (const [x, y] of [[a, b], [b, a]]) {
        if (!overlaps.has(x.id)) overlaps.set(x.id, []);
        overlaps.get(x.id).push(y);
      }
    }
  }
  return overlaps;
}

function programCard(paper, overlaps) {
  const card = el('article', '', 'program-card');
  card.style.setProperty('--type-color', paper.video ? VIDEO_COLOR : PAPER_COLOR);
  const main = el('div', '', 'program-card-main');
  const title = el('h3');
  title.append(link(paper.title, programLink('content/' + paper.id) || paper.doi));
  main.append(cardKicker(paper), title, bylineNodes(paper), whenRow(paper));
  const clashes = overlaps.get(paper.id);
  if (clashes) {
    const warning = el('p', '', 'overlap');
    warning.append(icon('alert'), 'Overlaps with ' + clashes.map((other) => '“' + other.title + '”').join(', '));
    main.append(warning);
  }
  const side = el('div', '', 'program-card-side');
  const remove = el('button', '', 'icon-button');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Remove “' + paper.title + '” from My List');
  remove.title = 'Remove from My List';
  remove.append(icon('remove'));
  remove.addEventListener('click', () => toggleSaved(paper));
  side.append(remove);
  card.append(main, side);
  return card;
}

function emptyState(message) {
  const box = el('div', '', 'empty-state');
  box.append(el('p', message));
  const back = el('a', 'Find recommendations', 'primary-button');
  back.href = '#/';
  box.append(back);
  return box;
}

function renderList() {
  const papers = savedPapers();
  for (const button of listView.querySelectorAll('[data-sort]')) button.setAttribute('aria-pressed', button.dataset.sort === listSort);
  for (const button of document.querySelectorAll('[data-ics]')) button.disabled = !papers.length;
  if (!papers.length) {
    listItems.replaceChildren(emptyState('Your list is empty. Add papers from your citation recommendations and they will appear here with their session times.'));
    return;
  }
  const sorters = {
    time: (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.title.localeCompare(b.title),
    // Ignore leading quotes and punctuation so “"Social Media…” sorts under S.
    title: (a, b) => a.title.replace(/^[^\p{L}\p{N}]+/u, '').localeCompare(b.title.replace(/^[^\p{L}\p{N}]+/u, '')),
    added: (a, b) => saved.get(String(b.id)) - saved.get(String(a.id)),
  };
  const overlaps = overlapsFor(papers);
  const count = el('p', papers.length + (papers.length === 1 ? ' paper' : ' papers') + (overlaps.size ? ' · ' + overlaps.size + ' with time overlaps' : ''), 'list-count');
  listItems.replaceChildren(count, ...papers.sort(sorters[listSort]).map((paper) => programCard(paper, overlaps)));
}

function renderSchedule() {
  const papers = savedPapers().filter((paper) => paper.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const unscheduled = saved.size - papers.length;
  const days = [...new Set(program.papers.filter((paper) => paper.start).map((paper) => dayKey(paper.start)))].sort();
  if (scheduleDay !== 'all' && !days.includes(scheduleDay)) scheduleDay = 'all';
  const tabs = [['all', 'All days', papers.length], ...days.map((day) => {
    const ms = Date.parse(day + 'T00:00:00Z');
    return [day, shortDay(ms), papers.filter((paper) => dayKey(paper.start) === day).length];
  })];
  dayTabs.replaceChildren(...tabs.map(([key, label, count]) => {
    const tab = el('button', label, 'day-tab');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', key === scheduleDay);
    tab.tabIndex = key === scheduleDay ? 0 : -1;
    if (count) tab.append(el('span', String(count), 'count'));
    tab.addEventListener('click', () => {
      scheduleDay = key;
      renderSchedule();
      dayTabs.querySelector('[aria-selected=true]').focus();
    });
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const index = tabs.findIndex(([value]) => value === scheduleDay) + (event.key === 'ArrowRight' ? 1 : -1);
      scheduleDay = tabs[(index + tabs.length) % tabs.length][0];
      renderSchedule();
      dayTabs.querySelector('[aria-selected=true]').focus();
    });
    return tab;
  }));
  for (const button of document.querySelectorAll('[data-ics]')) button.disabled = !saved.size;
  const overlaps = overlapsFor(papers);
  const summary = $('#schedule-summary');
  summary.textContent = papers.length
    ? papers.length + (papers.length === 1 ? ' scheduled paper' : ' scheduled papers') + (overlaps.size ? ' · ' + overlaps.size + ' overlap with another' : '') + (unscheduled ? ' · ' + unscheduled + ' without a published time' : '')
    : '';
  if (!saved.size) {
    scheduleItems.replaceChildren(emptyState('Nothing scheduled yet. Add papers to My List and they will appear here by day and time.'));
    return;
  }
  const visible = papers.filter((paper) => scheduleDay === 'all' || dayKey(paper.start) === scheduleDay);
  if (!visible.length) {
    scheduleItems.replaceChildren(el('p', 'No saved papers on this day.', 'empty'));
    return;
  }
  const nodes = [];
  let lastDay;
  let slot;
  for (const paper of visible) {
    const day = dayKey(paper.start);
    if (day !== lastDay) {
      nodes.push(el('h2', longDay(paper.start), 'day-label'));
      lastDay = day;
      slot = undefined;
    }
    const label = timeRange(paper);
    if (!slot || slot.label !== label) {
      const row = el('div', '', 'timeslot');
      const time = el('h3', label, 'timeslot-time');
      const cards = el('div', '', 'timeslot-cards');
      row.append(time, cards);
      nodes.push(row);
      slot = { label, cards };
    }
    slot.cards.append(programCard(paper, overlaps));
  }
  scheduleItems.replaceChildren(...nodes);
}

function icsText(papers) {
  const offset = (program.conference?.timeZoneOffset ?? 0) * 60_000;
  const stamp = (ms) => new Date(ms - offset).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escape = (value) => String(value).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');
  const fold = (line) => {
    const parts = [];
    for (let i = 0; i < line.length; i += 73) parts.push((i ? ' ' : '') + line.slice(i, i + 73));
    return parts.join('\r\n');
  };
  const now = stamp(Date.now() + offset);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CHI 2026 Citation-Based Picks//My Schedule//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:CHI 2026 · My Schedule'];
  for (const paper of papers) {
    const end = paper.end > paper.start ? paper.end : paper.start + 12 * 60_000;
    const url = programLink('content/' + paper.id) || paper.doi;
    lines.push('BEGIN:VEVENT', 'UID:chi2026-' + paper.id + '@citation-explorer', 'DTSTAMP:' + now,
      'DTSTART:' + stamp(paper.start), 'DTEND:' + stamp(end),
      'SUMMARY:' + escape((paper.video ? '[Video] ' : '') + paper.title),
      'LOCATION:' + escape(roomName(paper.room) || 'CHI 2026'),
      'DESCRIPTION:' + escape('Session: ' + (paper.session || 'n/a') + '\n' + byline(paper) + '\n' + url),
      'URL:' + url, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function downloadCalendar() {
  const papers = savedPapers().filter((paper) => paper.start);
  if (!papers.length) return;
  const url = URL.createObjectURL(new Blob([icsText(papers)], { type: 'text/calendar;charset=utf-8' }));
  const anchor = el('a');
  anchor.href = url;
  anchor.download = 'chi2026-my-schedule.ics';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function savedChanged() {
  for (const badge of document.querySelectorAll('[data-saved-count]')) {
    badge.textContent = saved.size;
    badge.hidden = !saved.size;
  }
  for (const button of document.querySelectorAll('.save-toggle')) paintSaveButton(button);
  refreshRecSchedule?.();
  networkHandle?.refreshSaved();
  if (!program) return;
  if (currentRoute === 'list') renderList();
  if (currentRoute === 'schedule') renderSchedule();
}

function route(focus = true) {
  if (location.hash && !location.hash.startsWith('#/')) return; // e.g. the skip link
  const name = location.hash.replace(/^#\/?/, '').split('/')[0];
  currentRoute = ['list', 'schedule'].includes(name) ? name : 'explorer';
  explorerView.hidden = currentRoute !== 'explorer';
  listView.hidden = currentRoute !== 'list';
  scheduleView.hidden = currentRoute !== 'schedule';
  for (const item of document.querySelectorAll('[data-route]')) {
    if (item.dataset.route === currentRoute) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  document.title = { explorer: 'Citation-Based Picks · CHI 2026', list: 'My List · CHI 2026', schedule: 'My Schedule · CHI 2026' }[currentRoute];
  if (program) savedChanged();
  else if (currentRoute !== 'explorer') (currentRoute === 'list' ? listItems : scheduleItems).replaceChildren(el('p', 'Loading the conference program…', 'empty'));
  if (focus) {
    window.scrollTo(0, 0);
    if (currentRoute !== 'explorer') $('#' + currentRoute + '-title').focus({ preventScroll: true });
  }
}

for (const button of listView.querySelectorAll('[data-sort]')) {
  button.addEventListener('click', () => {
    listSort = button.dataset.sort;
    renderList();
  });
}
for (const button of document.querySelectorAll('[data-ics]')) button.addEventListener('click', downloadCalendar);
window.addEventListener('hashchange', () => route());
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  saved = readSaved();
  savedChanged();
});
route(false);
savedChanged();

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
  if (event.key === 'Enter' && !suggestions.hidden && matches.length) {
    event.preventDefault();
    choose(matches[Math.max(active, 0)]);
  }
});
clear.addEventListener('click', () => {
  liveController?.abort();
  ++selectionVersion;
  selected = undefined;
  input.value = '';
  status.textContent = '';
  results.hidden = true;
  intro.hidden = false;
  search();
  input.focus();
});

$('#key-slot').append(apiKeyForm());

async function refreshSavedAuthors() {
  savedLive = await savedAuthors();
  const list = $('#saved-authors');
  list.replaceChildren(...savedLive.map((author) => {
    const item = el('li');
    const button = el('button', author.name, 'demo-chip saved-chip');
    button.type = 'button';
    button.title = [author.institution, 'Saved ' + new Date(author.builtAt).toLocaleDateString()].filter(Boolean).join(' · ');
    button.addEventListener('click', () => loadLive(author));
    item.append(button);
    return item;
  }));
  $('#saved-row').hidden = !savedLive.length;
}
refreshSavedAuthors();

readJSON('program.json').then((data) => {
  program = data;
  applyTypeColors(program.types);
  papersById = new Map(program.papers.map((paper) => [String(paper.id), paper]));
  savedChanged();
  authors = Object.entries(program.authors).filter(([, name]) => name).map(([id, name]) => ({
    id, name, normalized: fold(name),
  })).sort((a, b) => a.name.localeCompare(b.name));
  input.disabled = false;
  // Every author mapped in author-map.json has a prebuilt snapshot to demo.
  const mapped = authors.filter(({ id }) => program.profiles[id]);
  demos.replaceChildren(...mapped.map((author) => {
    const item = el('li');
    const button = el('button', author.name, 'demo-chip');
    button.type = 'button';
    button.addEventListener('click', () => selectAuthor(author));
    item.append(button);
    return item;
  }));
}).catch(() => {
  status.textContent = 'The conference program could not be loaded. Reload the page to try again.';
});
