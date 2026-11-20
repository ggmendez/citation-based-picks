// Draws the network of recommended papers and their authors. app.js builds
// the graph (which papers, which authors, how each author relates to you);
// this module only lays it out and draws it. d3 is loaded on first use.
//
// Each author is linked to the recommended papers they wrote, so authors on
// several papers pull those papers together into groups; papers that share no
// authors float on their own.
//
// Semantic zoom: labels keep a constant on-screen size, and more of them
// appear as you zoom in (authors on several papers first, then every author,
// then paper titles).

const D3_URL = 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';
let d3Promise;
const loadD3 = () => (d3Promise ??= import(D3_URL));
let d3Module = null;

// Start loading d3 early (e.g. when the pointer reaches the Network button).
export function preloadNetwork() {
  return loadD3().then((d3) => { d3Module = d3; });
}

const truncate = (text, length) => (text.length > length ? text.slice(0, length - 1).trimEnd() + '…' : text);

export async function drawNetwork(host, graph, options) {
  const d3 = d3Module || await loadD3();
  d3Module = d3;
  return draw(d3, host, graph, options);
}

// Synchronous when d3 is already loaded, so the graph replaces the
// placeholder before the browser paints (no flash).
export function drawNetworkNow(host, graph, options) {
  return d3Module ? draw(d3Module, host, graph, options) : null;
}

function draw(d3, host, graph, { colorOf, relationText, onPerson, onPaper, isSaved }) {
  host.replaceChildren();
  // The canvas has a fixed CSS height, reserved before drawing, so the page
  // does not jump when the graph appears.
  const width = Math.max(320, host.clientWidth);
  const height = Math.max(400, host.clientHeight);
  const nodes = graph.nodes.map((node) => ({ ...node }));
  const links = graph.links.map((link) => ({ ...link }));
  const maxStrength = Math.max(1, ...nodes.filter((n) => n.kind === 'paper').map((n) => n.strength));
  for (const n of nodes) {
    n.r = n.kind === 'paper' ? 5 + 7 * Math.sqrt(n.strength / maxStrength) : 3.2 + Math.min(4, (n.papers - 1) * 1.2);
  }

  // --- SVG scaffold ------------------------------------------------------
  const svg = d3.select(host).append('svg')
    .attr('viewBox', [0, 0, width, height])
    .attr('width', '100%')
    .attr('height', height)
    .attr('role', 'img')
    .attr('aria-label', graph.summary);
  const layer = svg.append('g');
  const linkSel = layer.append('g').attr('class', 'net-links').selectAll('line').data(links).join('line')
    .attr('vector-effect', 'non-scaling-stroke');
  const nodeSel = layer.append('g').selectAll('g').data(nodes, (n) => n.id).join('g')
    .attr('class', (n) => 'net-node net-' + n.kind + (n.papers > 1 ? ' is-multi' : '') + (n.paper?.video ? ' is-video' : ''))
    .style('cursor', 'pointer');

  // Papers: rounded squares sized by how strongly they are recommended.
  const paperSel = nodeSel.filter((n) => n.kind === 'paper');
  paperSel.append('rect').attr('class', 'net-paper-dot').attr('vector-effect', 'non-scaling-stroke')
    .attr('x', (n) => -n.r).attr('y', (n) => -n.r).attr('width', (n) => 2 * n.r).attr('height', (n) => 2 * n.r).attr('rx', 2.5);
  paperSel.append('text').attr('class', 'net-saved-check').attr('text-anchor', 'middle').attr('dy', '0.36em').text('✓');
  const paintPapers = () => paperSel.classed('is-saved', (n) => isSaved(n.paper));
  paintPapers();

  // Authors: circles coloured by citation relation; authors of several
  // recommended papers get a ring and a count badge.
  const personSel = nodeSel.filter((n) => n.kind === 'person');
  personSel.filter((n) => n.papers > 1).append('circle').attr('class', 'net-multi-ring').attr('vector-effect', 'non-scaling-stroke').attr('r', (n) => n.r + 2.6).attr('stroke', colorOf);
  personSel.append('circle').attr('class', 'net-person-dot').attr('vector-effect', 'non-scaling-stroke').attr('r', (n) => n.r).attr('fill', colorOf);
  const badge = personSel.filter((n) => n.papers > 1).append('g').attr('class', 'net-badge');
  badge.append('circle').attr('r', 5.2).attr('stroke', colorOf);
  badge.append('text').attr('text-anchor', 'middle').attr('dy', '0.36em').attr('fill', colorOf).text((n) => n.papers);

  const labelSel = nodeSel.append('text')
    .attr('class', (n) => n.kind === 'person' ? 'net-label' : 'net-label net-paper-label')
    .text((n) => n.kind === 'person' ? n.name : truncate(n.paper.title, 44));

  // --- Layout --------------------------------------------------------------
  // Only papers and authors of several papers take part in the simulation.
  // Authors of a single recommended paper are placed in a ring around it
  // afterwards: they cannot link anything, and simulating thousands of them
  // would freeze the page when every paper is shown.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) {
    l.source = nodeById.get(l.source);
    l.target = nodeById.get(l.target);
  }
  const satellites = new Map();
  for (const n of nodes) {
    if (n.kind !== 'person' || n.papers > 1) continue;
    const paperId = [...n.paperIds].find((id) => nodeById.has(id));
    if (!paperId) continue;
    if (!satellites.has(paperId)) satellites.set(paperId, []);
    satellites.get(paperId).push(n);
    n.satellite = true;
  }
  for (const n of nodes) {
    if (n.kind !== 'paper') continue;
    const count = satellites.get(n.id)?.length || 0;
    n.orbit = count ? n.r + 8 + Math.max(0, count - 6) * 1.3 : 0;
  }
  const core = nodes.filter((n) => !n.satellite);
  const coreLinks = links.filter((l) => !l.source.satellite && !l.target.satellite);
  const reach = (n) => (n.kind === 'paper' ? Math.max(n.r, n.orbit) : n.r);
  const simulation = d3.forceSimulation(core)
    .force('link', d3.forceLink(coreLinks).distance((l) => reach(l.source) + reach(l.target) + 14).strength(0.7))
    .force('charge', d3.forceManyBody().strength((n) => (n.kind === 'paper' ? -45 - 2 * n.orbit : -25)).distanceMax(260).theta(0.95))
    .force('collide', d3.forceCollide((n) => reach(n) + (n.kind === 'paper' ? 4 : 3)))
    .force('x', d3.forceX(0).strength(0.05))
    .force('y', d3.forceY(0).strength(0.07))
    .stop();
  // Large graphs settle in fewer steps so the page stays responsive.
  if (core.length > 500) simulation.alphaDecay(0.045);
  for (let i = 0, n = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay())); i < n; i++) simulation.tick();
  const placeSatellites = () => {
    for (const [paperId, group] of satellites) {
      const paper = nodeById.get(paperId);
      group.forEach((n, i) => {
        const angle = (2 * Math.PI * i) / group.length - Math.PI / 2;
        n.x = paper.x + Math.cos(angle) * paper.orbit;
        n.y = paper.y + Math.sin(angle) * paper.orbit;
      });
    }
  };
  const ticked = () => {
    placeSatellites();
    linkSel.attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y).attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
    nodeSel.attr('transform', (n) => `translate(${n.x},${n.y})`);
  };
  ticked();
  simulation.on('tick', ticked);

  // --- Semantic zoom -------------------------------------------------------
  let scale = 1;
  let fitScale = 1;
  let focus = null;
  const neighbours = new Map(nodes.map((n) => [n.id, new Set([n.id])]));
  for (const l of links) {
    neighbours.get(l.source.id).add(l.target.id);
    neighbours.get(l.target.id).add(l.source.id);
  }
  const labelVisible = (n) => {
    if (focus && neighbours.get(focus.id).has(n.id)) return true;
    const relative = scale / fitScale;
    // No names at the default zoom; hovering shows a node's neighbourhood.
    if (n.kind === 'person') {
      if (n.papers > 1) return relative >= 1.6;
      return relative >= 2.8;
    }
    return relative >= 2.2 && n.rank < (relative < 3.2 ? 40 : Infinity);
  };
  const updateLabels = () => {
    const k = scale;
    const grow = 1 / Math.sqrt(Math.max(1, k / fitScale));
    nodeSel.select('.net-person-dot').attr('r', (n) => n.r * grow);
    nodeSel.select('.net-multi-ring').attr('r', (n) => (n.r + 2.6) * grow);
    nodeSel.select('.net-paper-dot').attr('transform', `scale(${grow})`);
    nodeSel.select('.net-saved-check').attr('font-size', (n) => n.r * 1.6 * grow);
    badge.attr('transform', (n) => `translate(${(n.r + 2.6) * grow * 0.71},${-(n.r + 2.6) * grow * 0.71}) scale(${1 / k})`);
    labelSel
      .attr('display', (n) => labelVisible(n) ? null : 'none')
      .attr('font-size', (n) => (n.kind === 'person' ? 11.5 : 10.5) / k)
      .attr('stroke-width', 3 / k)
      .attr('text-anchor', (n) => n.kind === 'paper' ? 'middle' : 'start')
      .attr('x', (n) => n.kind === 'paper' ? 0 : n.r * grow + (n.papers > 1 ? 10 : 4) / k)
      .attr('y', (n) => n.kind === 'paper' ? n.r * grow + 11 / k : 0)
      .attr('dy', (n) => n.kind === 'paper' ? 0 : '0.35em');
  };

  const zoom = d3.zoom().scaleExtent([0.15, 14]).on('zoom', (event) => {
    scale = event.transform.k;
    layer.attr('transform', event.transform);
    updateLabels();
  });
  svg.call(zoom).on('dblclick.zoom', null);

  const fit = (duration = 0) => {
    const pad = 30;
    const minX = Math.min(...nodes.map((n) => n.x - n.r)) - pad;
    const maxX = Math.max(...nodes.map((n) => n.x + n.r)) + pad;
    const minY = Math.min(...nodes.map((n) => n.y - n.r)) - pad;
    const maxY = Math.max(...nodes.map((n) => n.y + n.r)) + pad;
    fitScale = Math.min(width / (maxX - minX), height / (maxY - minY), 2.5);
    const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(fitScale).translate(-(minX + maxX) / 2, -(minY + maxY) / 2);
    (duration ? svg.transition().duration(duration) : svg).call(zoom.transform, t);
  };
  fit();

  const controls = d3.select(host).append('div').attr('class', 'net-zoom');
  for (const [label, text, action] of [
    ['Zoom in', '+', () => svg.transition().duration(250).call(zoom.scaleBy, 1.6)],
    ['Zoom out', '−', () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.6)],
    ['Fit to view', '⤢', () => fit(300)],
  ]) {
    controls.append('button').attr('type', 'button').attr('aria-label', label).attr('title', label).text(text).on('click', action);
  }
  d3.select(host).append('p').attr('class', 'net-hint').text('Hover for names · zoom in to label authors and papers');

  // --- Hover and selection ------------------------------------------------
  const tooltip = d3.select(host).append('div').attr('class', 'net-tooltip').attr('hidden', true);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Hover touches only the hovered node's neighbourhood (thousands of nodes
  // can be on screen); dimming everything else is done by one class on <svg>.
  const elements = new Map();
  nodeSel.each(function (n) { elements.set(n.id, { node: this, label: this.querySelector('.net-label') }); });
  const linksOf = new Map(nodes.map((n) => [n.id, []]));
  linkSel.each(function (l) {
    linksOf.get(l.source.id).push(this);
    linksOf.get(l.target.id).push(this);
  });
  let lit = { ids: [], links: [] };
  const highlight = (n) => {
    for (const id of lit.ids) {
      const { node, label } = elements.get(id);
      node.classList.remove('is-near', 'is-focus');
      focus = null;
      label.setAttribute('display', labelVisible(nodeById.get(id)) ? 'inline' : 'none');
    }
    for (const line of lit.links) line.classList.remove('is-active');
    focus = n;
    svg.classed('has-focus', Boolean(n));
    if (!n) {
      lit = { ids: [], links: [] };
      return;
    }
    const ids = [...neighbours.get(n.id)];
    for (const id of ids) {
      const { node, label } = elements.get(id);
      node.classList.add('is-near');
      label.setAttribute('display', 'inline');
    }
    elements.get(n.id).node.classList.add('is-focus');
    const lines = linksOf.get(n.id);
    for (const line of lines) line.classList.add('is-active');
    lit = { ids, links: lines };
  };
  nodeSel.on('mouseenter', (event, n) => {
    highlight(n);
    tooltip.attr('hidden', null).html('');
    if (n.kind === 'person') {
      tooltip.append('p').attr('class', 'tip-title').text(n.name);
      tooltip.append('p').text(relationText(n) + (n.weight ? ' · ' + n.weight + (n.weight === 1 ? ' work' : ' works') : ''));
      const titles = [...n.paperIds].map((id) => byId.get(id)).filter(Boolean)
        .sort((a, b) => b.strength - a.strength).map((paper) => paper.paper.title);
      tooltip.append('p').attr('class', 'tip-heading').text(n.papers === 1 ? 'Recommended paper' : n.papers + ' recommended papers');
      const list = tooltip.append('ul').attr('class', 'tip-papers');
      for (const title of titles.slice(0, 6)) list.append('li').text(title);
      if (titles.length > 6) tooltip.append('p').text('and ' + (titles.length - 6) + ' more — select for the full list');
    } else {
      tooltip.append('p').attr('class', 'tip-title').text(n.paper.title);
      if (n.when) tooltip.append('p').text(n.when);
      tooltip.append('p').text(n.strength + (n.strength === 1 ? ' citation link' : ' citation links'));
    }
    const box = host.getBoundingClientRect();
    // Keep the tooltip inside the canvas (it can be tall with several titles).
    const tip = tooltip.node().getBoundingClientRect();
    const x = event.clientX - box.left + 14;
    const y = event.clientY - box.top + 14;
    tooltip.style('left', Math.max(8, Math.min(x, box.width - tip.width - 8)) + 'px')
      .style('top', Math.max(8, Math.min(y + tip.height > box.height - 8 ? event.clientY - box.top - tip.height - 10 : y, box.height - tip.height - 8)) + 'px');
  }).on('mouseleave', () => {
    highlight(null);
    tooltip.attr('hidden', true);
  }).on('click', (event, n) => {
    if (event.defaultPrevented) return; // ended a drag
    if (n.kind === 'person') onPerson(n);
    else onPaper(n.paper);
  });

  nodeSel.filter((n) => !n.satellite).call(d3.drag()
    .on('start', (event, n) => { if (!event.active) simulation.alphaTarget(0.15).restart(); n.fx = n.x; n.fy = n.y; })
    .on('drag', (event, n) => { n.fx = event.x; n.fy = event.y; })
    .on('end', (event, n) => { if (!event.active) simulation.alphaTarget(0); n.fx = null; n.fy = null; }));

  return {
    refreshSaved: paintPapers,
    // Lets the side list highlight an author in the graph.
    highlight: (id) => highlight(id ? nodes.find((n) => n.id === id) || null : null),
    destroy: () => simulation.stop(),
  };
}
