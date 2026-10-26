---
name: add-to-wishlist
description: Add a product to a Shopping notebook in Unbent as a wish-list entry, from a URL and an optional star priority, attaching any image the user provides.
---

# Add to wishlist

Use when the user shares a product link (and maybe a star count, an image, or
both) and asks to add it to their shopping list, wish list or gift ideas.

The notebook is called **Shopping**. This skill expects these fields, and sets
only the ones the notebook has (`list_notebooks` lists them, with each
select's options):

| Field | Type |
|---|---|
| `Url` | URL |
| `Name` | text |
| `Price` | number |
| `Store` | text |
| `Image` | URL |
| `Category` | select |
| `Status` | select, with a `Want` option |
| `Captured` | date |
| `Priority` | number, a rating out of 5 with halves |
| `Gift Idea` | multi-select of who it is for, with a `Me` option |

## Inputs (all optional, but expect at least a URL or an image)

- **URL**: the product page.
- **Stars**: a number like "4 stars" or "4.5". This is the `Priority` field,
  not a product review.
- **Image**: an image file attached to the message. Attach it to the note
  (see below).
- **Gift Idea**: `Me` unless the user names someone else; use the field's
  existing options.

With no URL, build the note from what the user typed or from the image. Ask
nothing unless there is nothing to go on.

## Steps

1. Load the Unbent tools if they are deferred, along with a web fetch tool.
2. If a URL was given, fetch it and take the product name, the price, the
   brand or store, a short description (colours, materials, fit), and the main
   image's address (`og:image`, the largest variant). Never invent values;
   leave a field out if the page doesn't give it.
3. Check `search_notes` for the URL to avoid a duplicate. If the product is
   already there, say so and link it instead of creating another.
4. Create the note with `create_note` in notebook **Shopping**:
   - title: `<Brand> <Product name>`
   - body: one or two plain sentences describing the product.
   - fields:
     - `Url`: the product URL
     - `Name`: the product name
     - `Price`: a number, if known
     - `Store`: the brand or retailer
     - `Image`: the page's `og:image` address, if found
     - `Category`: the best fit among the field's options
     - `Status`: `Want`
     - `Captured`: today's date, `YYYY-MM-DD`
     - `Priority`: the stars given (1 to 5, halves allowed); leave it out if
       none were given
     - `Gift Idea`: `["Me"]` unless the user said otherwise
5. If an image file came with the message, upload it to the note:
   - Find the file on disk (in a Claude chat, usually under
     `/mnt/user-data/uploads/`).
   - Call `prepare_attachment_upload` with the note's id, a descriptive
     filename with its extension (such as `trail-jacket.png`), and the
     content type.
   - Send the bytes with
     `curl -sS -T <file> -H "Content-Type: <contentType>" "<uploadUrl>"`.
     The reply confirms the upload and that the image is in the note's body.
   - Don't use `add_attachment` for a file on disk: it takes a URL.
6. Reply briefly: what was added (name, price, category, priority, gift
   idea), whether the image was attached, and the note's link from the tool's
   reply. Always include the link.

## Style

Direct and concise, in the note and in the reply.
