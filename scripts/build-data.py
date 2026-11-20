"""Build a static conference index and evidence-backed OpenAlex snapshots."""

import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
ARGS = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
# --program-only refreshes program.json and program-works.json without rebuilding author snapshots.
PROGRAM_ONLY = "--program-only" in sys.argv[1:]
# --people-only writes people.json from the program file alone (no OpenAlex requests).
PEOPLE_ONLY = "--people-only" in sys.argv[1:]
PROGRAM = Path(ARGS[0]) if ARGS else ROOT.parent / "CHI_2026_program.json"
DIST = ROOT / "dist"
FIELDS = "id,doi,title,publication_year,primary_location,authorships,referenced_works"
# Ordered so more specific names (CHI EA, CHI PLAY) win over broader ones (CHI).
SIGCHI_VENUES = [(label, re.compile(pattern, re.I)) for label, pattern in [
    ("CHI EA", r"extended abstracts on human factors in computing systems|\bchi ea\b"),
    ("CHI", r"human factors in computing systems"),
    ("CHI PLAY", r"computer.human interaction in play|\bchi play\b"),
    ("CSCW", r"computer.supported cooperative work|\bcscw\b"),
    ("DIS", r"designing interactive systems"),
    ("UIST", r"user interface software and technology"),
    ("IUI", r"intelligent user interfaces"),
    ("EICS", r"engineering interactive computing systems"),
    ("MobileHCI", r"mobile human.computer interaction|human.computer interaction with mobile devices"),
    ("UbiComp", r"pervasive and ubiquitous computing|\bubicomp\b"),
    ("ISS", r"interactive surfaces and spaces"),
    ("SUI", r"spatial user interaction"),
    ("TEI", r"tangible,? embedded,? and embodied interaction"),
    ("CUI", r"conversational user interfaces"),
    ("AutomotiveUI", r"automotive user interfaces"),
    ("TOCHI", r"acm transactions on computer.human interaction"),
    ("PACMHCI", r"proceedings of the acm on human.computer interaction"),
    ("C&C", r"creativity (?:&|and) cognition"),
    ("ETRA", r"eye tracking research"),
    ("GROUP", r"supporting group work"),
    ("HRI", r"human.robot interaction"),
    ("ICMI", r"multimodal interaction"),
    ("IDC", r"interaction design and children"),
    ("RecSys", r"recommender systems"),
    ("SCF", r"computational fabrication"),
    ("VRST", r"virtual reality software and technology"),
]]


def sigchi_venue(*names):
    """Return the SIGCHI venue acronym for the first matching name, or None."""
    for name in names:
        for label, pattern in SIGCHI_VENUES:
            if name and pattern.search(name):
                return label
    return None


def api(path, **params):
    if os.getenv("OPENALEX_API_KEY"):
        params["api_key"] = os.environ["OPENALEX_API_KEY"]
    request = Request(
        f"https://api.openalex.org/{path}?{urlencode(params)}",
        headers={"User-Agent": "CHI-Citation-Explorer/1.0"},
    )
    for attempt in range(4):
        try:
            with urlopen(request, timeout=45) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code not in {429, 500, 502, 503, 504}:
                try:
                    message = json.load(error).get("message", "")
                except ValueError:
                    message = ""
                raise RuntimeError(f"OpenAlex returned HTTP {error.code} for {path.split('/')[0]} ({len(params.get('filter', ''))} filter characters): {message}") from None
        except (URLError, TimeoutError):
            pass
        time.sleep(2 ** attempt)
    raise RuntimeError("OpenAlex request failed after retries")


def works(filter_string, fields=FIELDS):
    for page in range(1, 51):
        data = api("works", filter=filter_string, select=fields, per_page=200, page=page)
        yield from data["results"]
        if page * 200 >= data["meta"]["count"] or not data["results"]:
            return
    raise RuntimeError("OpenAlex result exceeded 10,000 works. Reduce the batch size.")


def batches(field, values, fields=FIELDS, size=45):
    values = sorted(set(values))
    filters = [
        f"{field}:{'|'.join(values[start:start + size])}"
        for start in range(0, len(values), size)
    ]
    with ThreadPoolExecutor(max_workers=4) as pool:
        for batch in pool.map(lambda query: list(works(query, fields)), filters):
            yield from batch


def short_id(value):
    return (value or "").rsplit("/", 1)[-1]


def doi_key(value):
    return urlparse(value or "").path.lstrip("/").lower()


def people_on(work):
    return {
        short_id(entry["author"]["id"]): entry["author"]["display_name"]
        for entry in work.get("authorships", [])
        if entry["author"].get("id")
    }


def references(work):
    return {short_id(ref) for ref in work.get("referenced_works", [])}


def cite_record(work):
    location = work.get("primary_location") or {}
    source = location.get("source") or {}
    venue = source.get("display_name") or location.get("raw_source_name") or "Venue unavailable"
    raw = location.get("raw_source_name") or ""
    return {
        "title": work.get("title") or "Untitled work",
        "year": work.get("publication_year"),
        "venue": venue,
        "sigchi": sigchi_venue(venue, raw),
        "url": work.get("doi") or work["id"],
    }


def write_json(name, data):
    target = DIST / name
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(target)


def resolve_author(entry):
    if entry.get("orcid"):
        return short_id(api(f"authors/{entry['orcid']}", select="id")["id"])
    if entry.get("dblp"):
        # OpenAlex does not expose a DBLP author lookup. Bind a verified OpenAlex
        # author ID alongside the DBLP profile in author-map.json.
        author_id = short_id(entry.get("openAlexId"))
        if re.fullmatch(r"A\d+", author_id):
            return author_id
    raise ValueError("Supply an ORCID or a DBLP profile with a verified OpenAlex author ID")


def build_profile(entry, candidates, conference_dois, conference_titles, by_doi):
    author_id = resolve_author(entry)
    history = {
        short_id(work["id"]): work for work in works(f"author.id:{author_id}")
    }
    # Program works can be ahead of OpenAlex's author index or split across profiles.
    for doi in conference_dois:
        if doi in by_doi:
            work = by_doi[doi]
            history[short_id(work["id"])] = work
    print(f"{len(history)} authored works for {author_id}", flush=True)
    refs_by_source = {work_id: references(work) for work_id, work in history.items()}
    all_refs = set().union(*refs_by_source.values())
    candidates_by_id = {c["id"]: by_doi[doi_key(c["doi"])] for c in candidates if doi_key(c["doi"]) in by_doi}
    conference_author_ids = set().union(*(people_on(work).keys() for work in candidates_by_id.values()))
    conference_author_ids.discard(author_id)

    outgoing_targets = {}
    outgoing_by_author = {}
    for work in batches("openalex_id", all_refs, size=75):
        matched = people_on(work).keys() & conference_author_ids
        if matched:
            work_id = short_id(work["id"])
            outgoing_targets[work_id] = work
            for person_id in matched:
                outgoing_by_author.setdefault(person_id, set()).add(work_id)
    outgoing_sources = {}
    for source_id, refs in refs_by_source.items():
        for target_id in refs & outgoing_targets.keys():
            outgoing_sources.setdefault(target_id, set()).add(source_id)
    print(f"{len(outgoing_targets)} outgoing references matched to program authors", flush=True)

    incoming_by_author = {}
    incoming_sources = {}
    # Restrict historical results to conference author IDs locally and deduplicate
    # citing works by ID.
    def incoming_batch(ids):
        return list(works(f"cites:{'|'.join(ids)}", FIELDS))

    history_ids = sorted(history)
    chunks = [history_ids[i:i + 20] for i in range(0, len(history_ids), 20)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        for batch in pool.map(incoming_batch, chunks):
            for work in batch:
                cited = references(work) & history.keys()
                matched = people_on(work).keys() & conference_author_ids
                if cited and matched:
                    work_id = short_id(work["id"])
                    incoming_sources[work_id] = work
                    for person_id in matched:
                        incoming_by_author.setdefault(person_id, {})[work_id] = cited
    print(f"{len(incoming_sources)} incoming citing works matched to program authors", flush=True)

    conference_work_ids = {
        work_id for work_id, work in history.items()
        if doi_key(work.get("doi")) in conference_dois
        or (work.get("title") or "").casefold().strip() in conference_titles
    }
    records = {}

    def register(work_id, collection):
        if work_id not in records:
            records[work_id] = cite_record(collection[work_id])
        return work_id

    recommendations = {}
    for paper_id, work in candidates_by_id.items():
        if author_id in people_on(work) or doi_key(work.get("doi")) in conference_dois:
            continue
        work_id = short_id(work["id"])
        direct = sorted(references(work) & history.keys())
        incoming = {}
        outgoing = {}
        for person_id, name in people_on(work).items():
            if person_id in incoming_by_author:
                incoming[name] = [
                    [register(source, incoming_sources), [register(ref, history) for ref in sorted(refs)]]
                    for source, refs in sorted(incoming_by_author[person_id].items())
                    if source != work_id
                ]
            if person_id in outgoing_by_author:
                outgoing[name] = [
                    [register(target, outgoing_targets), [
                        [register(source, history), source in conference_work_ids]
                        for source in sorted(outgoing_sources[target])
                    ]]
                    for target in sorted(outgoing_by_author[person_id])
                ]
        incoming = {name: edges for name, edges in incoming.items() if edges}
        if direct or incoming or outgoing:
            recommendations[paper_id] = {
                "direct": [register(ref, history) for ref in direct],
                "incoming": incoming,
                "outgoing": outgoing,
            }
    return {"profile": entry, "works": records, "matches": recommendations,
            "indexedPapers": len(candidates_by_id),
            "papersWithReferences": sum(bool(references(w)) for w in candidates_by_id.values()),
            "authoredWorks": len(history)}


def schedule_for(content, program):
    """Return when and where a paper is presented, as the SIGCHI program shows it.

    Papers in a session get consecutive slots of the content type's duration
    (12 minutes for papers), in the session's content order. Remote papers have
    no session and appear in the video presentation event instead.
    """
    sessions = {item["id"]: item for item in program["sessions"]}
    slots = {item["id"]: item for item in program["timeSlots"]}
    rooms = {item["id"]: item["name"] for item in program["rooms"]}
    minutes = {item["id"]: item.get("duration") or 0 for item in program["contentTypes"]}
    for session_id in content.get("sessionIds", []):
        session = sessions.get(session_id)
        slot = slots.get(session and session.get("timeSlotId"))
        if not slot:
            continue
        start, end = slot["startDate"], slot["endDate"]
        if not session.get("isParallelPresentation") and minutes[content["typeId"]]:
            length = minutes[content["typeId"]] * 60_000
            start += session["contentIds"].index(content["id"]) * length
            end = min(start + length, end)
        return {"session": session["name"], "sessionId": session_id, "start": start, "end": end,
                "sessionStart": slot["startDate"], "sessionEnd": slot["endDate"],
                "room": rooms.get(session.get("roomId"))}
    for event in program["events"]:
        if content["id"] in event["contentIds"] and event.get("startDate"):
            return {"session": event["name"], "eventId": event["id"], "video": True,
                    "start": event["startDate"], "end": event["endDate"],
                    "room": rooms.get(event.get("roomId"))}
    return {"session": None}


def people_index(program, names):
    """Everyone with a role in the program: affiliations, contributions, chairs.

    The site loads this when someone opens a person's details. Contents are any
    program item (papers, posters, workshops, ...), each with when and where it
    is presented.
    """
    types = {item["id"]: item for item in program["contentTypes"]}
    rooms = {item["id"]: item["name"] for item in program["rooms"]}
    slots = {item["id"]: item for item in program["timeSlots"]}
    people, contents, sessions = {}, {}, {}

    def person(person_id):
        return people.setdefault(person_id, {"name": names.get(person_id, ""), "affiliations": [], "contents": [], "chairs": []})

    for content in program["contents"]:
        authors = content.get("authors", [])
        if not authors:
            continue
        kind = types.get(content["typeId"], {})
        when = schedule_for(content, program)
        contents[content["id"]] = {
            "title": content["title"],
            "type": kind.get("displayName") or kind.get("name"),
            "color": kind.get("color"),
            "authors": [a["personId"] for a in authors],
            "doi": content.get("addons", {}).get("doi", {}).get("url"),
            **{key: value for key, value in when.items() if value is not None},
        }
        for author in authors:
            entry = person(author["personId"])
            entry["contents"].append(content["id"])
            for affiliation in author.get("affiliations", []):
                place = ", ".join(part for part in (affiliation.get("city"), affiliation.get("country")) if part)
                label = " | ".join(part for part in (affiliation.get("institution"), place) if part)
                if label and label not in entry["affiliations"]:
                    entry["affiliations"].append(label)
    for session in program["sessions"]:
        slot = slots.get(session.get("timeSlotId"))
        for chair in session.get("chairIds", []):
            person(chair)["chairs"].append(session["id"])
            sessions[session["id"]] = {
                "name": session["name"], "room": rooms.get(session.get("roomId")),
                "start": slot and slot["startDate"], "end": slot and slot["endDate"],
                "type": types.get(session["typeId"], {}).get("displayName"),
            }
    return {"people": people, "contents": contents, "sessions": sessions}


def main():
    program = json.loads(PROGRAM.read_text(encoding="utf-8-sig"))
    author_map = json.loads((ROOT / "author-map.json").read_text(encoding="utf-8"))
    all_authors = {a["personId"] for c in program["contents"] for a in c.get("authors", [])}
    people = {
        p["id"]: " ".join(p[key].strip() for key in ("firstName", "middleInitial", "lastName") if p.get(key, "").strip())
        for p in program["people"] if p["id"] in all_authors
    }
    everyone = {
        p["id"]: " ".join(p[key].strip() for key in ("firstName", "middleInitial", "lastName") if p.get(key, "").strip())
        for p in program["people"]
    }
    write_json("people.json", people_index(program, everyone))
    if PEOPLE_ONLY:
        return
    types = {item["id"]: item["name"] for item in program["contentTypes"]}
    candidates = [
        {"id": c["id"], "title": c["title"], "doi": c["addons"]["doi"]["url"],
         "authors": [a["personId"] for a in c.get("authors", []) if a["personId"] in people],
         **schedule_for(c, program)}
        for c in program["contents"]
        if types[c["typeId"]] == "Paper" and c.get("addons", {}).get("doi", {}).get("url")
    ]
    profiles = {entry["programId"]: {"name": name, **entry} for name, entry in author_map.items()}
    for person_id, entry in profiles.items():
        if people.get(person_id) != entry["name"]:
            raise ValueError(f"Mapped author does not match program entry {person_id}")
    conference_dois = {
        person_id: {
            doi_key(c.get("addons", {}).get("doi", {}).get("url"))
            for c in program["contents"]
            if any(a["personId"] == person_id for a in c.get("authors", []))
        } - {""} for person_id in profiles
    }
    conference_titles = {
        person_id: {
            c["title"].casefold().strip()
            for c in program["contents"]
            if any(a["personId"] == person_id for a in c.get("authors", []))
        } for person_id in profiles
    }
    dois = {doi_key(c["doi"]) for c in candidates}
    dois.update(set().union(*conference_dois.values()))
    by_doi = {doi_key(work["doi"]): work for work in batches("doi", dois)}
    print(f"{len(by_doi)}/{len(dois)} program DOIs resolved", flush=True)
    # Compact index of the program papers' OpenAlex records. The site uses it to
    # compute recommendations live for authors without a prebuilt snapshot.
    program_works = {}
    for c in candidates:
        work = by_doi.get(doi_key(c["doi"]))
        if work:
            program_works[c["id"]] = {
                "work": short_id(work["id"]),
                "authors": [[person_id, name] for person_id, name in people_on(work).items()],
                "refs": sorted(references(work)),
            }
    write_json("program-works.json", program_works)
    for person_id, entry in ({} if PROGRAM_ONLY else profiles).items():
        profile = build_profile(entry, candidates, conference_dois[person_id], conference_titles[person_id], by_doi)
        write_json(f"citations-{person_id}.json", profile)
        print(f"{len(profile['matches'])} recommendations for {entry['name']}", flush=True)
    conference = program["conference"]
    write_json("program.json", {
        # Program timestamps hold the conference's local wall-clock time encoded
        # as UTC; timeZoneOffset (minutes) converts them to real UTC instants.
        "conference": {"name": conference["name"], "timeZone": conference["timeZoneName"],
                       "timeZoneOffset": conference["timeZoneOffset"],
                       "programUrl": f"https://programs.sigchi.org/{conference['shortName'].lower()}/{conference['year']}"},
        "authors": people, "papers": candidates, "profiles": profiles,
        "sigchiVenues": [[label, pattern.pattern] for label, pattern in SIGCHI_VENUES],
        # Colours of the program's content types, as the SIGCHI program app shows them.
        "types": {t["name"]: {"label": t.get("displayName") or t["name"], "color": t["color"]} for t in program["contentTypes"]},
    })


if __name__ == "__main__":
    main()
