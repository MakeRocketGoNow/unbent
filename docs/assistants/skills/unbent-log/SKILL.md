---
name: unbent-log
description: Log a rated meal, drink or other experience to an Unbent log notebook (one with a Date and a Rating field) from a terse line like "Acme Diner, mushroom risotto, 4 stars, yes".
---

# Unbent Log

Writes rated-experience entries to log notebooks in the user's Unbent account,
through the Unbent connector. The user logs these in clipped shorthand and
expects a note to appear with no back-and-forth. Speed and silence matter more
than thoroughness: this is a two-second capture, not an interview.

Use it whenever the user is recording something they ate, drank, or otherwise
rated out in the world ("add to meals", "log this beer", "add to my coffee
log", "meal review", or a bare comma-separated line naming a place and an
item), and for backward-looking questions ("what did I think of the risotto",
"how many 5-star beers this year", "have we been to Acme Diner"). A place, an
item and a rating are enough to trigger it, without the notebook named or
Unbent mentioned.

## Finding the right notebook

Don't hardcode a notebook list. Call `list_notebooks` (or reuse a fresh result
from this conversation) and treat any notebook that has **both** a `date`
field and a number field that is a rating (it carries a `scale`) as a log.
This skill expects a log's fields to be named like these:

| Field | Type | Holds |
|---|---|---|
| `Date` | date | the day of the visit |
| `Rating` | number with a scale | the rating |
| `Review` | text | the user's comment |
| `Would Get Again` | select (Yes / No / Maybe) or checkbox | whether they would order it again |
| the place field | text or select | the venue: `Restaurant`, `Brewery`, `Shop` and so on |

For example, a Restaurant Log with a text `Restaurant` field, a Beer Log with
a text `Brewery` and a text `Style`, and a Coffee Log whose `Shop` is a select
and whose `Would Get Again` is a checkbox. New logs of the same shape work
without changing this skill, so rediscover the fields each time.

**Picking the notebook for an entry:**
1. If the user names it ("add to my coffee log", "log this beer"), use that.
2. Otherwise infer from vocabulary: brewery, IPA, stout, lager terms point to
   a beer log; latte, espresso, roastery terms to a coffee log; restaurant,
   dish, entree, "ate at" framing to a restaurant log.
3. If it is ambiguous, or fits no log well, ask which log rather than
   guessing. Don't create a notebook on the fly.

**The place field** is whichever field is not `Date`, `Rating`, `Review` or
`Would Get Again` and holds the venue's name.

## Parsing the shorthand

The usual input is one comma-separated line, roughly:

```
<place>, <item>, <rating>, <would get again>, <review>
```

Order is a convention, not a contract. Identify fields by shape, not
position: the user will sometimes drop fields or reorder them.

- **Rating**: any of `4`, `4 stars`, `4/5`, `★★★★`, `four stars`. Write the
  plain number into `Rating` (a number field, never star characters). If the
  rating's scale has a step of 1 and the user says `3.5`, round down to `3`
  and say so.
- **Would Get Again**: a bare `yes`, `no` or `maybe` (also `y`, `n`, `def`,
  `never again` for No, `probably` for Maybe). Map it to the field's type:
  - a select: write `Yes`, `No` or `Maybe` as the options spell them.
  - a checkbox: `true` for yes, `false` for no. A checkbox cannot hold maybe:
    leave it unset and say so in one clause.
  If absent, leave it empty. Don't infer it from the rating.
- **Review**: leftover prose that is none of the above, written into `Review`
  verbatim in the user's voice, not expanded into full sentences.
- **Date**: today in the user's local time unless they give a date ("last
  Friday", "7/4"); write it as `YYYY-MM-DD`.
- **Place**: fix obvious misspellings silently and use title case.
- **Item** (the note's title): the dish, beer or drink. Fix obvious
  misspellings silently (`Carribean` to `Caribbean`, `ceasar` to `Caesar`) and
  use title case. Don't improve it beyond that: `Burger` stays `Burger`.
- **Any other field** (a beer log's `Style`, say): fill it only when the user
  labels it (`style: hazy IPA`) or the leftover text plainly names it. Leave
  it blank rather than guess.

Every entry needs a place and an item. A place with a rating and no item
(`Acme Diner, 4 stars`) is not an entry: ask which dish or drink rather than
inventing a title.

Never deduplicate. The same item at the same place logged again is a new
note: this is a record of visits, not a catalog. Don't search for existing
notes before creating one.

Several lines in one message are several notes. `create_notes` takes a batch;
`create_note` one at a time works too.

## A select place field

When the place field is a select:

1. Read its current options from `list_notebooks`.
2. Compare ignoring case, punctuation and a leading "The". If an option
   already covers it, use that spelling.
3. If it is genuinely new, add it with `update_notebook_field` and
   `addOptions` (it appends, so the existing list need not be sent) before
   creating the note.

Add the option without asking, and mention it in one clause of the reply so
the user knows the list grew.

## Creating the note

```json
{
  "notebook": "Beer Log",
  "title": "Hazy Pale Ale",
  "body": "",
  "fields": {
    "Date": "2026-09-24",
    "Rating": 4,
    "Brewery": "Acme Brewing",
    "Would Get Again": "Yes",
    "Review": "a little too hoppy for me"
  }
}
```

Leave out any field the user didn't give rather than passing an empty value.
Leave `body` empty unless there is free prose that fits no field.

## Reporting back

A few lines. The user knows what they had; they are checking that it was
parsed right, so echo the parsed fields compactly, with the note's link from
the tool's reply:

```
Logged to your <notebook>:

[<Item>](<url>), <Place>, <rating>★, Would Get Again: <value>, dated <date>
[<one clause about a new select option, if one was added>]
```

For a batch, one line per entry, then one closing line.

Don't narrate the notebook lookup, the option added, or which tools were
called. If you made a judgment call (rounding a half star, reading a fuzzy
date, picking the notebook), say so in one short clause.

## Fixing an entry

When the user says the last entry was wrong, correct it in place with
`update_note` and the note's id from the create call, passing only what
changed:

```json
{
  "noteId": "<id from the create call>",
  "fields": { "Rating": 3 }
}
```

An entry made by mistake can be moved to the trash with `delete_note`. That is
reversible, so no confirmation is needed beyond the user asking.

## Looking things up

For backward-looking questions, use `search_notes` with the log's `notebook`,
or `list_notes` with `notebook` and a date range for "this year" questions.
Answer in prose: a one-note answer is a sentence, not a table.

## Examples

**Input:** `Acme Diner, Carribean jerk bowl with chicken, 4 stars, yes`
**Result:** Restaurant Log; title `Caribbean Jerk Bowl with Chicken`
(spelling fixed); Restaurant `Acme Diner`; Rating `4`; Would Get Again `Yes`;
Date today; Review empty.

**Input:** `acme diner - fish sandwich, 3, maybe, bun fell apart`
**Result:** Restaurant Log; Rating `3`; Would Get Again `Maybe`; Review `bun
fell apart`. The separator is a dash, not a comma: don't assume commas.

**Input:** `Acme Brewing, hazy pale ale, 4, yes, a little too hoppy`
**Result:** Beer Log (brewery and beer vocabulary); Brewery `Acme Brewing`;
Rating `4`; Would Get Again `Yes`; Review `a little too hoppy`; Style blank
since it wasn't given.

**Input:** `Acme Roasters, oat milk latte, 5, yes`
**Result:** Coffee Log; Shop `Acme Roasters` (an existing option); Rating `5`;
Would Get Again checkbox `true`.

**Input:** `Acme Diner, 4 stars, yes`
**Result:** No note. Ask which dish rather than titling it "Acme Diner" or
"Visit".
