---
name: watch-later
description: Add a film, series, documentary or special to a Watch Later notebook in Unbent, usually from a Letterboxd link (letterboxd.com/film/... or boxd.it/...).
---

# Watch Later

Use when the user shares a Letterboxd link (or a title, or another film or TV
page such as IMDb or JustWatch) and asks to add it to their Watch Later list
or watch list. Also use it when they say "add this" while looking at a
Letterboxd film page.

The notebook is called **Watch Later**. This skill expects these fields, and
sets only the ones the notebook has (`list_notebooks` lists them, with each
select's options):

| Field | Type |
|---|---|
| `Type` | select: Movie, TV Series, Documentary and so on |
| `Status` | select, with a `Want to Watch` option |
| `Priority` | select, such as Must Watch, Want To, Someday, Maybe |
| `Where to Watch` | select of streaming services |
| `Recommended By` | text |
| `Year` | number |
| `URL` | URL |

## Hard rule: always return the Unbent link

Every reply must include the Unbent note's link, as a Markdown link, for every
title touched: created, already there, or updated.

- Take it from the `url` in the tool's reply (`create_note`, `search_notes`,
  `get_note` and `update_note_fields` all return one).
- If a reply has no `url`, call `get_note` with the note's id to get it.
- If no note was created (an error, or nothing to identify the title), say so
  plainly. Never say a title was added without a link to its note.

## Inputs

- **Link**: usually Letterboxd. Short links (`https://boxd.it/XXXX`) redirect
  to `https://letterboxd.com/film/<slug>/`.
- **Title only**: with no link, use the title typed. Look it up on Letterboxd
  if that helps to find the year.
- **Priority** (optional): map loose phrasing to the field's options ("must
  see" to Must Watch, "eventually" to Someday). Leave it out if not given.
- **Recommended By** (optional): only if the user says who recommended it.
- **Status** (optional): `Want to Watch` unless the user says otherwise.

Ask nothing unless there is nothing to identify the title.

## Steps

1. Load the Unbent tools if they are deferred, along with a web fetch tool.
2. Get the film's details:
   - For a `boxd.it` link, fetch it; it redirects, so fetch the
     `letterboxd.com/film/<slug>/` address it gives.
   - From the Letterboxd page take the title, year, director, runtime, type
     (feature, documentary, series, comedy special, short), a one-sentence
     synopsis, and any services under "Where to watch".
   - If fetching is blocked or returns nothing useful, read the page through
     a browser tool if one is connected. Failing that, ask the user to open
     the page.
   - Never invent values. Leave out anything the page doesn't give.
3. Check for a duplicate with `search_notes` in notebook `Watch Later`, by
   title (and by the boxd.it code or film slug). If it is already there, don't
   create another: say so and give the existing note's link. Change its fields
   only if the user asked for a change.
4. Create the note with `create_note` in notebook **Watch Later**:
   - title: the title exactly as Letterboxd shows it, without the year.
   - body: one or two short plain lines, such as
     `Directed by Jane Example. 127 min.` and then the one-sentence synopsis.
   - fields:
     - `Type`: the option that fits; Movie for a feature film.
     - `Status`: `Want to Watch` unless the user said otherwise.
     - `Year`: the release year, as a number.
     - `URL`: the link given. Keep a boxd.it short link as it is; otherwise
       the canonical `https://letterboxd.com/film/<slug>/`.
     - `Priority`: only if given.
     - `Where to Watch`: only when the page lists a service that matches one
       of the field's options exactly or obviously (a longer name for the
       same service, say). A service that is not an option goes in the body
       instead; don't add options. Rental or purchase listings don't count.
     - `Recommended By`: only if the user said so.
5. Reply briefly, link first: `[<Title> (<Year>)](<url>)`, then the type,
   status, priority if set, and where to watch if set.

## Several titles

For several links or titles at once, handle each the same way and reply with
one line per title, each starting with its note's link. Titles already there
get their existing link too. Any that failed are listed with the reason.

## Style

Direct and concise, in the note and in the reply.
