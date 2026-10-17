# Auto-fill's decision model, measured

[Auto-fill](search.md#filing-a-note-from-what-it-says) is one press that files a note: it
reads what the note and its files say and chooses a notebook, tags and field values from
the ones that exist. The choosing is done by a decision model, [Jev](https://docs.typesafe.ai)
from TypeSafe, which answers typed questions with a probability over the options rather than
with text. On 2026-10-16 we put [SubQ Snap](https://subq.ai/introducing-subq-snap), a newer
model of the same kind, in Jev's seat and measured both on the same notes. This page is the
result, the method, and how to run it on your own archive.

The short version: on this task Snap filed notebooks worse than Jev, cost half again as
much per press once the press was split to fit its request limit, and was no faster. Its
384k-token context changed no answer on the two long documents tried. We kept Jev.

**What this is not.** It is one task (filing a note into an archive), 46 notes from one
person's archive, scored against how that person filed them. It is not a general
benchmark of either model, and a different task or a press designed around Snap's limits
could come out differently. The limits are listed below with the counts, because a reader
should be able to decide how much of this carries over to their own problem.

## The task

A note goes in with its notebook, tags and field values removed (and its title too when it
has a file with text, since a scan's title is the model's to write). The press asks the
decision model to choose a notebook, to say yes or no to each tag, and to pick each field's
value from candidates the code finds in the text (every date for a date field, every
amount for a number, the document's own lines for a text field). A language model
(`claude-haiku-5-5`) writes the title and any free-text field beside it, in both arms; only
the chooser changed. The answers are scored against what the owner had filed.

The sample was 46 notes across 15 notebooks, 13 of them with file text, one notebook left
out for privacy. It stayed on the owner's machine; nothing from it is in this repository or
in the results below except counts.

## Snap in Jev's seat

Snap speaks the same request and answer shape as Jev, so the client in `lib/jev.ts` was
pointed at Snap's endpoint under Snap's model name and nothing else in the press changed.
One difference could not be avoided. Snap refuses a request of more than 16 questions (a
422, as its documentation says), and the press's first round asks one yes-or-no question
per tag, up to 150 of them. Pointed at Snap as-is, every press fails. So the Snap arm
splits each round into requests of 16, sent at once, each carrying the note's text again.
That is what a real swap would have to do, and its seconds and cents are measured with it.

### Counts

Jev was run three times to see how much its answers move between runs; Snap gave the same
answers on all three of its.

| | Jev, run 1 | Jev, run 2 | Jev, run 3 | Snap (3 runs, identical) |
|---|---|---|---|---|
| Notebook right / wrong / none | 22 / 6 / 18 | 21 / 6 / 19 | 21 / 6 / 19 | 15 / 11 / 20 |
| Field values right / wrong / missed, where the notebook was right | 37 / 17 / 56 of 110 | 36 / 18 / 51 of 105 | 36 / 17 / 49 of 102 | 25 / 6 / 26 of 57 |
| Tags matching the owner's / extra / missed | 9 / 21 / 21 | 9 / 20 / 21 | | 11 / 25 / 19 |
| Titles close to the owner's, of 13 | 3 | 4 | | 4 |
| Seconds per press, median | 1.36 | 1.36 | | 1.38 |
| Cents per press | 0.102 | 0.102 | | 0.152 |
| Decision requests per press | 1.5 | 1.5 | | 10.5 |

### How to read it

- **Jev's repeat runs move one or two notes.** Differences of that size between any two
  columns are noise. Snap's determinism is a real property, and a pleasant one.
- **The notebook gap is not the confidence floor.** The press drops a notebook answered
  below 0.5 confidence, a number tuned on Jev, so run 3 kept each model's answer from before
  the floor and tried others. At its best floor Snap is still behind Jev at today's: 14
  right and 7 wrong at 0.6, 19 and 14 at 0.4, against Jev's 21 and 6 at 0.5. Its top choice
  is right about as often as Jev's (24 of 46 against 26), but it answered "none" once where
  Jev did seven times, it put five notes in the archive's catch-all notebook, and its
  confidence does not separate its right picks from its wrong ones the way Jev's does. No
  threshold closes the gap.
- **Per field it is about as accurate.** 25 of 57 right where the notebook was right,
  against about 36 of 105 for Jev. It gets fewer notebooks right, so it has fewer fields to
  fill.
- **Tags are slightly better.** Two more matching, four more extra.
- **Speed is a tie.** Snap answers each request in 0.3 to 0.5 seconds, the ten requests run
  at once, and either way the press waits on the language model's title call.
- **Cost is higher despite the lower price.** Snap is $0.05 per million input tokens against
  Jev's $0.042, and both bill output at nothing. But the note's text goes out ten times a
  round instead of once. Snap reports its usage, 27k input tokens a press; Jev reports none,
  so its 20k is estimated from request bytes at four to a token.

### The long-context question

Jev takes 32k tokens, so the press cuts a note's text at 40,000 characters
(`MAX_STATE_CHARS` in `lib/autofill.ts`), and a note with many long files loses most of
them. Snap takes 384k. That was the reason to try it. No note in the 46 came near the cap,
so two long notes were pulled from outside the sample: a contract of about 56,000
characters across two files, and a set of agreements of about 108,000 across four. A third
was dropped when copying its text was stopped partway.

| | Jev, 40k cap | Snap, 40k cap | Snap, 300k cap |
|---|---|---|---|
| Notebook right / wrong | 1 / 1 | 1 / 1 | 1 / 1 |
| Notebook confidence, the two notes | 0.81, 0.82 | 0.90, 0.86 | 0.87, 0.87 |
| Tags matching / extra / missed | 3 / 2 / 1 | 2 / 2 / 2 | 2 / 3 / 2 |
| Seconds per press, median | 1.92 | 3.35 | 2.28 |
| Cents per press | 0.28 | 0.76 | 1.42 |

Every choice was the same at both caps. Both documents say what they are on their first
pages, so the cut never reaches the text that decides, and that is likely true of most of a
paperless archive. Raising the cap also sends the extra text to the title call, which is
most of the cost rise. Two notes cannot prove a negative, but nothing here argues for
raising the cap, and nothing argues that Jev's 32k is costing filings.

### What was not tested

- **A press designed for Snap.** Asking tags as a few multiple-choice questions instead of
  150 yes-or-nos would fit in one request and would be billed once. It is a different
  press, and it would have to be measured against Jev on its own. We did not build it.
- **A confidence floor tuned for Snap.** The per-note detail showed no floor that brought
  it level with Jev, so none went into the press.
- **OpenAI's Decisions API**, the third model of this kind. Its shape (an input, an array
  of named questions, up to 200) needs an adapter rather than a URL switch, and we had no
  key. The harness has a place for it.
- **A third long document.** The long-context check ran on two notes, not three.
- **Snap's own benchmarks.** It launched on 2026-10-12 with a lead on 13 of 16 of them. None
  is this task, and we did not run them.

Snap was five days old when this was measured, and its launch post carried a capacity
warning. The three things that would reopen the question are: Snap taking a press's
questions in one request, its notebook choice catching up to within noise of Jev at a floor
where its wrong answers are no more than Jev's, and the archive turning out to hold
documents that say what they are past their first 40,000 characters.

## For comparison: one language-model call

The same harness holds a third arm, measured the same day and reported in full in its own
right, because it is the alternative that would retire the second vendor: one structured
`claude-haiku-5-5` call that answers notebook, tags, title and fields at once, with the
archive's notebooks and tags in a cached prefix and the code holding each value to the rule
Jev's candidates hold it to (a date is one the text writes, a select is one of its options,
a text value is something the note contains). Its Jev column is a separate run from the
three above, which is why its numbers differ by a note or two.

| | Jev press, as shipped | One Haiku call |
|---|---|---|
| Notebook right / wrong / none | 20 / 6 / 20 | 21 / 7 / 18 |
| Field values right / wrong / missed, where the notebook was right | 35 / 15 / 47 of 97 | 43 / 7 / 72 of 122 |
| Tags matching the owner's / extra / missed | 9 / 22 / 21 | 16 / 36 / 14 |
| Titles close to the owner's, of 13 | 4 | 5 |
| Seconds per press, median | 1.41 | 3.00 |
| Cents per press | 0.10 | 0.052 |

One call files about as well as the decision model, puts fewer wrong values in, suggests
more tags (ones the owner used and ones they did not), and costs half. It is a second and a
half slower on every press, and that is structural: a generative model has to write about
400 tokens of answer, where a decision model answers each round in under half a second and
the press's calls overlap. The press is the thing a person waits on, so the second vendor
stays for now. Both decision models' advantage on this task is speed, and only speed.

## Running it yourself

The harness is `apps/api/eval/autofill.eval.ts`, a vitest project that asserts nothing and
prints counts. It runs only when `AUTOFILL_EVAL_SAMPLE` names a directory holding a sample,
and it spends real money on the APIs it calls: a fraction of a cent a press in each arm, so
well under a dollar for a run of this size.

```bash
AUTOFILL_EVAL_SAMPLE=/path/to/sample pnpm --filter @unbent/api exec vitest run --project eval
```

| Variable | What it does |
|---|---|
| `AUTOFILL_EVAL_ARMS` | Which arms to run: `jev`, `onecall`, `snap`. The first two by default. |
| `AUTOFILL_EVAL_LIMIT` | Caps the notes, for a dry run. |
| `AUTOFILL_EVAL_STATE_CHARS` | Raises how much of a note's text the `jev` and `snap` arms send. `MAX_STATE_CHARS` by default; Jev itself refuses much more. |
| `AUTOFILL_EVAL_LABEL` | Added to the results' file names, so a repeat or a raised cap does not write over an earlier run. |
| `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`, `SUBQ_API_KEY` | The keys, from the environment or from `apps/api/.dev.vars`. Only the arms you run need theirs. |

The sample directory holds what the [MCP tools](assistants.md) answer for an account, saved
as they answer it:

```
notebooks.json          list_notebooks
tags.json               list_tags
notes.json              [{ id, notebook, title, body, tags, fields,
                           attachments: [{ filename, read, text }] }]
notebook-examples.json  { [notebook name]: [{ id, title }] }   recent titles per notebook
tag-examples.json       { [tag name]: [{ id, title }] }        recent titles per tag
```

Pulling it is by hand today: connect an assistant to your account over MCP and have it save
those five files for the notes you choose. The notes in `notes.json` are the questions, so
pick ones you filed with some care; the examples are the archive's context, and the harness
leaves each sample note out of every example list, since a note's own title beside its
notebook's name would be the answer. The harness writes the per-note detail beside the
sample, in `results/`, for you to read and then delete. The sample is your notes: keep it
out of any repository.

The counts above came from this harness on 2026-10-16. The decision to keep Jev, and the
reasoning behind the one-call arm, are recorded in the maintainer's tracker (MAK-231 and
MAK-233); the numbers here are the whole of what those records hold.
