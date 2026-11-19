# CHI 2026 Citation Explorer

The explorer searches author names from `CHI_2026_program.json` and recommends main-track CHI 2026 papers. It runs as a static site with a bundled OpenAlex snapshot, so visitors can use it without an API key.

## Run locally

From this directory, run `py -m http.server 8765 --bind 127.0.0.1 --directory dist` on Windows, or `python3 -m http.server 8765 --bind 127.0.0.1 --directory dist` elsewhere. Open [the local explorer](http://127.0.0.1:8765).

## Refresh the data

The only mapped author is Luigi De Russis. To add an author, put their full program name, program person ID, and ORCID URL in `author-map.json`. For a DBLP profile, provide its URL under `dblp` and a verified OpenAlex author ID under `openAlexId`.

Run `py scripts/build-data.py` on Windows or `python3 scripts/build-data.py` elsewhere. The script reads `../CHI_2026_program.json` by default and accepts an optional program path as its first argument. Set `OPENALEX_API_KEY` in your environment if you need a larger request budget.

The explorer matches conference papers by DOI and citation relationships by OpenAlex work and author IDs. The three views show direct citations, papers by authors who previously cited the selected author's work, and papers by authors the selected author cites. The outgoing view can be filtered by whether the citation appeared in the selected author's CHI 2026 or other work. Expand a result to inspect the works behind it.

The program data is credited to [ACM SIGCHI](https://programs.sigchi.org/) and licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Citation evidence comes from [OpenAlex](https://openalex.org/) and depends on its indexing and author disambiguation. The SIGCHI badges use a list of recognized venue names based on the [SIGCHI conference directory](https://sigchi.org/conferences/) and ACM HCI journals.
