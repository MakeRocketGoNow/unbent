# Billing and account deletion

## Selling the plan

unbent.app sells one plan, $60 a year, with 10 GB of attachments and 25 GB more for $12 a
year: about a third of Evernote's cheapest plan with no cap on notes, in the range of Bear
and Obsidian Sync, and well above the few dollars a year an account costs to serve, since
the price is positioning rather than cost recovery (the comparison is in MAK-47). Under
it is a free plan, for an account of up to 100 notes and 1 GB of files; see
[The free plan](#the-free-plan) below. Stripe
is the merchant of record, through Managed Payments: it takes the payment as the seller
(the buyer sees "Sold through Link" and a `LINK.COM*` descriptor), works out, withholds
and remits VAT and sales tax, handles disputes and transaction-level support, and tells
the Worker what happened over a webhook. Nothing about it exists on an instance that has
not set the four `STRIPE_*` settings (every account is active for good there, and no Plan
tab is drawn) so a fork never has to think about it.
The numbers the pages quote are in `packages/shared/src/plan.ts`; the prices Stripe charges
are in its catalog, and the two are changed together.

Paddle was the merchant of record first, and the plan was built and verified against its
sandbox. Its seller verification then asked the LLC for a government document naming its
owner, which Minnesota does not issue, and the review went nowhere; the switch to Stripe
was made on 2026-10-22, before any sale. Only the provider seam moved (`lib/stripe.ts`,
the billing routes, the Plan page's checkout); the plan, the row and the rules below are
as they were, and the row's provider columns are named `billing_*` for that reason.

Every account starts with a fortnight's trial, no card asked for, counted from its first
request after billing is on, so an account that existed before the keys went on gets its
fortnight from then, not from the deploy. When it runs out, or a subscription lapses, the
account is on the free plan: **free** if what it holds fits it, and writing as before, or
**inactive** if not. An inactive account still opens, searches and exports everything,
and every write but a delete is refused with a 402 that the app shows as a read-only
banner, until it subscribes or deletes its way under the free plan. The same states, and
the same code path, for an expired trial, a lapsed subscription and a comp that ended
(`requireActivePlan` and the store's `assertFree` in the API). After a year inactive
the account *may* be deleted, after a reminder to export first (a right the terms reserve,
not a job): nothing deletes on a timer, by decision, since deleting a paperless archive
because someone missed a year of mail would be holding it hostage after all, and a
read-only account costs almost nothing to keep (MAK-47, and `INACTIVE_KEPT_DAYS`).

Comps do not go through Stripe. A 100% coupon there still asks for a card and charges it
when the coupon ends, so an account that should not pay (the owner, a gifted friend) is
comped from the operator's page, with an end date or none, and Stripe never hears of it.
Stripe's coupons and promotion codes are for marketing.

Storage is enforced where bytes come in: an upload, a copy, a fetched picture or a
duplicate past the plan's quota is a 402 that names the numbers, and the Plan page shows
what the account holds against it. The sum is kept on each account's store by triggers
(schema 0008), never by reading the files table.

The store itself has a bound of its own (MAK-234), because the quota counts the bytes in
the bucket and nothing else, and what the account's SQLite holds (note bodies, the copies
the history keeps of them, the text extracted from files, the search index) is the dearer
kind of storage, about thirteen times the bucket's price per gigabyte-month. Once a store
is past half a gigabyte plus a tenth of the quota, a note write (a note made, imported,
duplicated or changed, a body appended to, a copy put back, a bulk change) is the same
402, with a sentence that says notes rather than files, and so is a file's text sent
for indexing, since a text layer is as long as its sender makes it whatever the file's
size. Deleting for good, emptying the trash and clearing a note's history still work,
since they are the way back under; trashing works too, and frees nothing until the trash
is emptied. The Plan page shows the store's size against its limit under the files'
meter, since that refusal sends people there. The margin is wide on purpose: a real
archive's text measured at a few percent of its files, and the limit exists for a loop
writing maximum-size notes on a trial with no card, not for anyone who filed what they
scanned (`storeLimitBytes` in the shared package's `plan.ts` has the numbers and the
reasoning).

Auto-fill is the one thing an account can make the instance pay for per press, and its
daily cap has two numbers for the same reason the trial asks for no card. `AUTOFILL_DAILY_CAP`
bounds one account's day, which is enough against a paying customer's loop: there is a
customer behind the account, and a day of presses costs less than the plan. A trial is
free, needs no card, and email sign-in accepts any address, so a cap per account does
nothing against someone making accounts in a loop: a hundred trials get a hundred days'
worth. `AUTOFILL_TRIAL_DAILY_CAP` is the number a trial gets instead, sized for what a
fortnight's free account should be able to spend before it is a customer; unset, a trial
gets the ordinary number, so an instance that sets one setting behaves as it did. The
account's Maintenance page and the button's refusal both quote the number that applies
to it. An account on the free plan gets the trial's numbers too, and the free plan's pool
beside them (see [The free plan](#the-free-plan)). Where billing is off nobody is on a
trial or the free plan, and only the ordinary cap is read.

The year has a cap of its own, in money rather than presses, because a day's cap bounds a
loop and not a year of days just under it, and because what a press costs varies with
the model and with how many scans it reads. `AUTOFILL_YEARLY_CENTS` and
`AUTOFILL_TRIAL_YEARLY_CENTS` are chosen by plan state the same way and fall back the
same way. The counter keeps tokens, never money; the year's tokens are summed once per
wake of the account's store, kept in step with each press after that, and priced with the
table in `packages/shared/src/llm-prices.ts`, which goes stale when Anthropic changes a
price and is a percent-level error on a guard, not a hole (a corrected price takes effect
the next time a store wakes). A press on
the decision model, which reports no tokens, counts as a fixed tenth of a cent. The
refusal says the account has used this year's Auto-fill and that it returns on 1 January
(UTC, like the day), and names no amount: the cap is the instance's cost, not the
person's bill. A trial on a number of its own is told that the trial's Auto-fill is used
up and that a subscription comes with more, since 1 January would be false for it:
subscribing gives it the paying number at once. A trial that fell back to the ordinary
number is told what everyone else is, because for it that is the truth. Both refusals
and the Maintenance page say the numbers are the account's, never the instance's.

unbent.app sets all four: 500 presses and 5000 cents (fifty dollars) a year for a paying
account, 50 presses and 300 cents (three dollars) for a trial. Fifty dollars is more than
the plan costs and still a ceiling on a loop that never trips the day's cap; three dollars
files a fortnight's worth of scans and bounds what a trial made in bulk can spend.

### The free plan

Decided on 2026-10-24. Free is a state, not a sign-up path: every account still starts on
the same full trial, so an importer sees a whole archive searchable, and when the trial,
a subscription or a comp ends, an account that holds at most `FREE_NOTES` (100) notes,
live and trashed together, and `FREE_STORAGE_GB` (1) gigabyte of files keeps writing, for
good. One past either is inactive as before, and is free again with nothing to press once
it subscribes or deletes for good and empties the trash down to them. One rule, decided
by what the account holds, for every way of lapsing; there is no "go free" control, and
free has no Stripe object.

The limits are on quantity, never on features: notebooks, fields, the offline library,
history, assistants, export and search all stay on, because scale is what the plan sells
and the rest is the demo. A hundred notes because Evernote's free tier is fifty notes and
one notebook and UpNote's is fifty notes; the trash counts, as Evernote counts it, so it is
not free overflow. Cost is not the constraint (a capped account is cents a month to host)
but the support inbox, the abuse surface of accounts with no card and the mail allowance
are. An importer who brought a thousand notes into the trial is read-only when it ends,
which is intended: the free plan changes the outcome only for the small account. A cheaper
paid tier was weighed and not built: the same engineering, support and tax plumbing as the
plan, and the terms' thirty days' notice of a price change twice over.

What the account holds is the store's (`note_counts`, kept by triggers), so the store
decides, in the call that would write. The Worker passes the free plan's limits with each
write of an account no plan holds, the way it passes the store's room (`writeLimitsOf`),
and `UserStore` refuses there: `PLAN_INACTIVE` for every write but a delete when the
account is past the limits, and `FREE_NOTES_FULL` for a write that makes notes (a create,
a duplicate, an import, an assistant's `create_note` and `create_notes`) once the count
would pass 100. No request pays a second call to the object to ask first. The middleware
lets an account no plan holds through only on the routes whose writes the store holds to
the free plan (`HELD_IN_STORE` in `plan-middleware.ts`), and refuses it every other
mutating route, so a new one is read-only for it until someone classifies it. The plan
read (`GET /api/me/plan`) is the one read that asks the store what a lapsed account holds,
to answer `free` or `inactive`. Uploads are bounded by the quota, which for an account no
plan holds is the free plan's gigabyte; its store's room follows from that, as every
account's does. The web app keeps a refused note in the outbox, as it keeps a store-full
refusal, and New says the free plan is full before it makes one the server would refuse.

Auto-fill on the free plan is a lifetime pool of presses, `AUTOFILL_FREE_PRESSES` (100 on
unbent.app), counted only while the account is free, so the trial's presses never come out
of it, beside the trial's daily and yearly numbers, since a free account is as free to
make as a trial. A pool rather than a monthly allowance: it reads as Auto-fill for every
note the free plan holds, it costs at most seventy cents an account, it converts because
it ends, and it needs nothing the counter does not already keep (one row of `llm_usage`,
on the empty day, which no year's range reads). Unset, there is no pool. The refusal
names the pool's number and says a subscription comes with more; Maintenance says how many
are left, and the Plan page meters it beside the notes and files.

The lapse mail says which an end leaves the account as, from what its store holds: a free
account is told it carries on, with its own numbers and what the plan adds, and an
inactive one that it is read-only and that deleting down to the free plan is a way back
as well as subscribing.

### Changing the price

The terms promise every subscriber an email at least 30 days before the renewal a price
change applies to, and nothing sends it. `packages/shared/src/plan.test.ts` pins the two
prices so that changing one fails a test with that promise in its message; it is the
reminder, not a check. The order is:

1. Write to every current subscriber with the new price and the date it starts, at least
   30 days before the first renewal it would apply to. A subscriber who cancels before
   then keeps the year already paid for at the old price.
2. After the 30 days, change the price in Stripe's catalog: a new price on the product,
   with the old one archived, and the existing subscriptions moved to it (Stripe does not
   move them by itself), so renewals move and nothing already in flight does. Then the
   new price id goes in `STRIPE_PLAN_PRICE_ID` or `STRIPE_STORAGE_PRICE_ID`.
3. Change `PLAN_PRICE_USD` or `STORAGE_ADDON_PRICE_USD` in `packages/shared/src/plan.ts`
   and the pinned number in its test in the same commit, and deploy. The front page and
   the Plan page quote the constants; the terms deliberately do not, and their effective
   date does not move for a price.

An inactive account is the other promise the terms make by hand: one past the free plan
is kept read-only for a year and may then be deleted, after an email asking its owner to
export it. A free account is not inactive and is kept like any other. Nothing
deletes on a timer and nothing sends that mail either. The operator's delete confirm says
so on an account whose plan has lapsed, which is the moment it matters.

### Setting up Stripe

A Stripe account has a live mode and sandboxes, each with its own keys, catalog, portal
configuration and webhook endpoints; a sandbox needs no verification and is what to build
against. unbent.app's is the "Unbent" account under MakeRocketGoNow LLC, and its sandbox
is "Unbent sandbox". Managed Payments is switched on for the account at
[dashboard.stripe.com/settings/managed-payments](https://dashboard.stripe.com/settings/managed-payments),
behind an eligibility review (business type, location, dispute history) that the live
account passes once; a sandbox accepts `managed_payments[enabled]` without it (checked on
2026-10-22). Everything below is done in both, the sandbox first; Stripe's own MCP or CLI
does the catalog and the portal configuration, the dashboard the rest.

1. **Product catalog.** Two products: the plan, with one price of $60 a year, and the
   storage add-on, with one price of $12 a year (the quantity is the subscription item's).
   Every product sold under Managed Payments needs a tax code it accepts; both are
   `txcd_10103000`, software as a service for personal use, and their prices are
   `tax_behavior: exclusive`, so the tax is added at checkout for the buyer's own place and
   the pages state prices before tax. Copy both price ids, `price_…`. In the sandbox:
   `prod_VUL0CdGjXfKrHC` / `price_1UTMKJEBtmDnkvwOTwklZHMT` and
   `prod_VUL0zF9Ug4kV46` / `price_1UTMKKEBtmDnkvwOrgnNd4x8`.
2. **API key.** A restricted key from the API keys page, with Customers, Checkout
   Sessions, Subscriptions and the customer portal to write and Invoices and Charges to
   read; shown once. A secret key does too, and is what a sandbox gets. Which environment
   the Worker talks to is read off the key (`sk_test_`/`rk_test_` against `sk_live_`/
   `rk_live_`).
3. **Customer portal.** One configuration, the account's default: invoice history, the
   card, cancelling at the period's end with a reason asked for, and the business name
   and address editable; not changing the plan, which the app does itself. The portal's
   terms and privacy links are `/terms` and `/privacy`. The checkout itself is Stripe's
   hosted page, reached by redirect, so no page of yours needs anything: the Worker makes
   a Checkout Session with Managed Payments on and the browser is sent to its address.
   The sandbox's is `bpc_1UTMKqEBtmDnkvwOgDlmgHUI`.
4. **Webhook.** An endpoint in Workbench at `https://<host>/api/billing/webhook` on API
   version `2025-03-31.basil` or later (the Worker pins its own calls to that version), for
   `customer.subscription.created`, `updated`, `deleted`, `paused` and `resumed`,
   `invoice.paid`, `charge.refunded` and `charge.dispute.created`. Its signing secret,
   `whsec_…`, is what every delivery is signed with. The Worker answers at once and applies
   each event once, in any order, so a retry (Stripe retries for three days) or a late
   delivery changes nothing. The refund events are how a refund reaches the Worker: a
   refund in Stripe leaves the subscription renewing, and the terms say it does not, so a
   refund of the plan cancels the subscription at once and a refund of only the storage
   add-on takes the add-on off; the same for a refund Stripe itself gives a buyer, which
   Managed Payments allows within sixty days. A delivery is accepted only from an address
   Stripe publishes at
   [stripe.com/files/ips/ips_webhooks.json](https://stripe.com/files/ips/ips_webhooks.json),
   which the Worker reads and keeps for an hour rather than writing down, so nothing needs
   allowlisting by hand: any other sender gets a 403 before its signature is read.
5. **The four settings** on the Worker, as secrets: `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `STRIPE_PLAN_PRICE_ID` and `STRIPE_STORAGE_PRICE_ID`. In
   `.dev.vars` locally; as the `DEV_STRIPE_*` GitHub secrets for the dev instance, which
   the deploy carries over with a sandbox's values; and on production by hand,
   `pnpm exec wrangler secret put` from `apps/api` for each, with the live account's, the
   webhook secret last, since the fourth is what turns billing on. `APP_URL` must be set
   too: the checkout and the portal come back to it, and the mail that says a plan has
   ended names it. That mail goes out from the hourly sweep through the same provider and
   allowance as the sign-in codes, so it is capped at two an hour (`LAPSE_MAIL_PER_RUN`):
   on Resend's free tier of a hundred a day, a cluster of trials ending together (every
   account that existed when billing went on starts its fortnight at its first visit) must
   not crowd the codes out. On a paid mail tier the cap can go up (MAK-220).

Locally, Stripe cannot reach a webhook on `localhost`; the Stripe CLI forwards the
sandbox's events to one (`stripe listen --forward-to http://localhost:<API_PORT>/api/billing/webhook`,
after `stripe login`), and the `whsec_…` it prints is the local `STRIPE_WEBHOOK_SECRET`
for as long as it runs. Without it the refresh route is how a local checkout reaches the
row, which the Plan page calls on its own. The live suite proves the rest with a signed
body of its own (`apps/api/test/plan.test.ts`), given the dev server's secret and price
ids as `STRIPE_WEBHOOK_SECRET`, `STRIPE_PLAN_PRICE_ID` and `STRIPE_STORAGE_PRICE_ID`, the
same lines as `.dev.vars`. Test cards are in Stripe's testing docs; `4242 4242 4242 4242`
with any future date succeeds, and a Link account made at a sandbox checkout signs in
with the code `000000`.

Going live is the same four settings from the live account, after Managed Payments is
activated on it. The account's public details (Settings, Business, Public details) carry
a support address and a support website, which Stripe prints on receipts and renewal
mails and reads for a Managed Payments escalation: the website is `/support`, the page
that says where receipts, refunds, cancelling, sign-in, export and deletion are handled
and how to reach a person, and the address is the operator's. The checkout page carries Stripe's own terms as the seller; the
business's are linked from Checkout settings and the portal configuration, and the
built-in documents say the rest wherever the instance sells a plan: billing on, or
`FRONT_PAGE=1`, since the front page states the price. They are the terms' "Plans and
payment" and "Refunds", and Stripe among the policy's services. The refund policy is at
`/terms#refunds`, under the Terms link in the front page's footer rather than a link of
its own, and `/pricing` is the offer on a page of its own, drawn from the same block as
the front page's Pricing section. Everything an account is told (the trial's end, a lapse,
the mail) is the same in both environments.

## Deleting an account

Settings → Maintenance, at the bottom, under everything else the page can destroy. The
button sends a confirmation link to the account's own address and deletes nothing by
itself; `POST /api/auth/delete-user` is the same thing without the page.

The link opens `/delete-account`, which asks once more and deletes on a POST when the
button there is pressed. It deliberately does not point at Better Auth's own
`/delete-user/callback`, which deletes on a bare GET: a GET is fired by link prefetches,
mail scanners, restored tabs and mistaps as readily as by people, and while a request with
no cookies fails, webmail read in the browser that holds the session is exactly the case
cookies do not cover. `/reset-password` has the same shape for the same reason: an emailed
token names an intention, and the click that acts on it should be a person's.

Pressing it sweeps `users/{id}/` out of R2, wipes the account's note store (the object
holding every note, tag, notebook, field and attachment record) and then removes the user
row, whose cascade takes the sessions. It does not touch the backups: the account's
dumps, its mirrored files and the D1 exports that name it age out on their own, every one
within about three months (see [Durability](architecture.md#durability)), and neither the wind-back nor
the load route will put a deleted account back from them. Then it signs the browser out and lands on
`/goodbye`. The account's row in the directory is tombstoned last, and the sweep drops it
once the object reports itself empty and the user row is gone, retrying the wipe if it was
interrupted. The sign-out is not a formality: the
deleting request re-writes the session-cache cookie from the session it resolved on the way
in, so without it the browser would keep a five-minute claim to an account that no longer
exists.

A session on its own is deliberately not enough, and neither is a password. The session
token travels as `Authorization: Bearer` from the phone and the CLI, and this is the one
action in the app with no trash to fish anything back out of; owning the address is the one
proof every account type can give, whether it signed in with Google, a passkey or a
password. The link works once and expires in a day. Export first if you want anything.

Unlike **Delete all notes**, the confirm does not ask you to type `DELETE`. That gate
belongs to a button that *is* the irreversible step; this one only sends mail, and asking
for the word to send an email would be friction guarding nothing, and would teach the
habit of typing it unread on the page where the other control means it. The typed word is
not what is missing from the mail's end either: a second press is.

An instance with no mail configured does not offer the endpoint at all, since the
confirmation is the mechanism: the same test that decides codes by email. `/api/config`
reports it as `accountDeletion` alongside the sign-in methods, so the settings section is
simply absent there rather than drawing a control the server would answer with a 404. In
local development `sendEmail` prints the link to the Worker console instead of sending it,
which is how the flow is exercised without a Resend account.

If the R2 sweep or the store wipe fails, the deletion is abandoned rather than
half-finished: the account survives with attachment rows pointing at objects that are
already gone, or with an empty store, and the failure is logged with the user id. Asking
again is the fix. Blobs and store go before the row here, the reverse of `purge-notes`,
because the user id both need is exactly what the deletion destroys; blobs before the store
because the store's rows are what the blob sweep reads to know which objects are
referenced.

An operator can delete someone else's account from that account's page under Settings →
Operator, for a sign-up that should not exist: a bot, a test account, someone who asked
by other means. It is `DELETE /api/admin/accounts/<id>?confirm=<id>` (the id twice, so
neither a stray retry nor a hand-typed URL deletes anything) and it is the same deletion in
the same order, by the same code (`lib/account-deletion.ts`), with no email: the link is a
person's proof that an account is theirs, which is not what lets an operator act. The
confirm names the account and what is in it, and asks for `DELETE` typed, since here the
button is the irreversible step. The backups are left to age out as above. The operator's
own account is refused; that one is deleted here, with its link.
