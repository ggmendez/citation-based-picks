# Citation-Based Picks for CHI 2026

Citation-Based Picks recommends CHI 2026 papers from who you cite and who cites you. It searches author names from `CHI_2026_program.json` and covers the main-track papers. It runs as a static site with a bundled OpenAlex snapshot, so visitors can use it without an API key.

## Run locally

From this directory, run `py -m http.server 8765 --bind 127.0.0.1 --directory dist` on Windows, or `python3 -m http.server 8765 --bind 127.0.0.1 --directory dist` elsewhere. Open [the local site](http://127.0.0.1:8765).

## Refresh the data

The mapped authors are Luigi De Russis, Nathalie Bressa, Vincent Cavez, and Gonzalo Gabriel Méndez. To add an author, put their full program name, program person ID, and ORCID URL in `author-map.json`. For a DBLP profile, provide its URL under `dblp` and a verified OpenAlex author ID under `openAlexId`.

Run `py scripts/build-data.py` on Windows or `python3 scripts/build-data.py` elsewhere. The script reads `../CHI_2026_program.json` by default and accepts an optional program path as its first argument. Set `OPENALEX_API_KEY` in your environment if you need a larger request budget.

The site matches conference papers by DOI and citation relationships by OpenAlex work and author IDs. The three views show direct citations, papers by authors who previously cited the selected author's work, and papers by authors the selected author cites. The outgoing view can be filtered by whether the citation appeared in the selected author's CHI 2026 or other work. Expand a result to inspect the works behind it.

Recommendations can be shown as a **List** or a **Schedule**. The Schedule view shows every recommendation for the current tab and filter as it would sit in the program. A week grid has one row per 12-minute presentation slot, grouped by session block, and its shading shows how many recommended papers are presented at the same time. Each cell shows the title of its strongest paper and how many others share the slot. Hovering over or focusing a cell opens a card with each paper's session, title, authors, time, room, and number of citation links, plus an **Add to My List** button. The card stays open while the pointer moves into it. With the keyboard, Tab moves from a cell into its card, and Escape closes it. Select a cell to see those papers in the timeline. Below it, a day-by-day timeline lists the session blocks, their parallel sessions and rooms, and each paper's time, with **Add to My List** buttons.

The **Network** view shows how the recommended papers relate through their authors. Papers are squares, sized by how many citation links support the recommendation, and they turn green once added to My List. Authors are circles, each linked to every recommended paper they wrote. Authors on several papers have a dashed ring and a count badge, and they pull those papers together, so groups of related papers stand out. The summary counts the groups and their size. Author color shows their citation link to you: blue if they cite you, orange if you cite them, purple if both, and grey if there is no direct link. Choose papers from **This tab** or **All three tabs**, how many of the strongest papers to include, and **All** authors or **Only shared** ones. **Only shared** also hides papers with no shared authors. The view uses semantic zoom. The default view has no labels, and hovering over a node names it and its neighbors. Zooming in labels the authors of several papers first, then paper titles, then every author, and labels keep a constant size. A side list ranks the authors on several papers, and hovering over one highlights them in the graph. OpenAlex author names are matched to the program's authors on the same paper. When the CHI data lists one person under two records with the same name and institution, the records are combined.

Select any person, in the graph, the list, or any author name on the site, to open their details from the CHI program data. The details show their affiliations, a link to their SIGCHI program page, every program item they contribute (papers, posters, workshops, and more) with time and room, and the sessions they chair. When recommendations are open, the details also show the citations connecting them to the selected author. `dist/people.json` holds this data. Rebuild it without any OpenAlex requests with `py scripts/build-data.py --people-only`.

## Authors without prebuilt data

The search box also covers authors who are not mapped in `author-map.json`, including authors outside the CHI 2026 program. Type a name and choose **Search OpenAlex**, or paste an ORCID or OpenAlex author ID. Selecting an unmapped program author opens the same profile picker. Profiles that appear on a CHI 2026 paper are marked and listed first.

The browser computes these recommendations live with the same logic as `build-data.py`. It fetches the author's works, the works they cite, and the works that cite them. The program papers' OpenAlex records come from the precomputed `dist/program-works.json`. A typical author takes 10–30 requests and a few seconds.

Everything fetched from OpenAlex is cached in the browser's IndexedDB, so an author found once is never requested again from that browser. The cache holds computed recommendations, author searches, ORCID lookups, and the profile chosen for each program author. Saved authors appear under **Saved in this browser** and in the search suggestions, and they open with no requests. A program author whose profile was chosen before goes straight to the results, with **Choose another profile** to change it. Only **Recompute** and **Search OpenAlex again** make new requests. The cache belongs to one browser; other visitors build their own.

Without an API key, OpenAlex gives everyone on a network one small daily budget ($0.10), and it does not allow cursor paging past the first page. The site therefore uses page-number paging. If the budget runs out, people can paste a free personal key under **OpenAlex API key (optional)**. The key is stored only in their browser. Run `py scripts/build-data.py --program-only` to refresh `program.json` and `program-works.json` without rebuilding the author snapshots.

## Type colors

Program items use the same type colors as the SIGCHI program app. The colors come from the content types in `CHI_2026_program.json` and are exported to `program.json` as `types`. Papers are blue and video presentations use the yellow "Event" color. Other types, such as posters and workshops, keep their own colors in the person details. The color appears on the left bar of every card, the dot before the type name, the schedule grid's shading, the hover cards, and the network's paper squares. A white ✓ on a network square marks a paper in My List, so color always means type.

## My List and My Schedule

Each recommended paper shows its session, presentation time, and room, taken from the program. Papers get consecutive 12-minute slots in session order, as on programs.sigchi.org. Remote papers appear as video presentations. Select **Add to My List** to save a paper. **My List** shows saved papers sorted by time, title, or date added. **My Schedule** arranges them by day and time and flags papers that overlap. Both pages can download the saved papers as an `.ics` calendar file in conference local time (UTC+02:00). The list is stored in the browser's local storage, so it stays on that browser and device.

The program data is credited to [ACM SIGCHI](https://programs.sigchi.org/) and licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Citation evidence comes from [OpenAlex](https://openalex.org/) and depends on its indexing and author disambiguation. The SIGCHI badges name the specific conference or journal (for example, CHI, UIST, or TOCHI) and use a list of recognized venue names based on the [SIGCHI conference directory](https://sigchi.org/conferences/) and ACM HCI journals.
