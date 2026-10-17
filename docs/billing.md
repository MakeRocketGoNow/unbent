# Billing and account deletion

## Selling the plan

unbent.app sells one plan, $36 a year, with 10 GB of attachments and 25 GB more for $12 a
year: about a third of Evernote's cheapest plan with no cap on notes, in the range of Bear
and Obsidian Sync, and well above the few dollars a year an account costs to serve, since
the price is positioning rather than cost recovery (the comparison is in MAK-47). Paddle is
the merchant of record: it takes the payment, handles VAT and sales tax, and tells the
Worker what happened over a webhook. Nothing about it exists on an instance that has not
set the five `PADDLE_*` settings (every account is active for good there, and no Plan tab
is drawn) so a fork never has to think about it.
The numbers the pages quote are in `packages/shared/src/plan.ts`; the prices Paddle charges
are in its catalog, and the two are changed together.

Every account starts with a fortnight's trial, no card asked for, counted from its first
request after billing is on, so an account that existed before the keys went on gets its
fortnight from then, not from the deploy. When it runs out, or a subscription lapses, the
account turns **inactive**: everything still opens, searches and
exports, and every write but a delete is refused with a 402 that the app shows as a
read-only banner. The same state, and the same code path, for an expired trial, a lapsed
subscription and a comp that ended (`requireActivePlan` in the API). After a year inactive
the account *may* be deleted, after a reminder to export first (a right the terms reserve,
not a job): nothing deletes on a timer, by decision, since deleting a paperless archive
because someone missed a year of mail would be holding it hostage after all, and a
read-only account costs almost nothing to keep (MAK-47, and `INACTIVE_KEPT_DAYS`).

Comps do not go through Paddle. A 100% discount there still asks for a card and charges it
when the discount ends, so an account that should not pay (the owner, a gifted friend) is
comped from the operator's page, with an end date or none, and Paddle never hears of it.
Paddle discount codes are for marketing.

Storage is enforced where bytes come in: an upload, a copy, a fetched picture or a
duplicate past the plan's quota is a 402 that names the numbers, and the Plan page shows
what the account holds against it. The sum is kept on each account's store by triggers
(schema 0008), never by reading the files table.

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
to it. Where billing is off nobody is on a trial, and only the ordinary cap is read.

The year has a cap of its own, in money rather than presses, because a day's cap bounds a
loop and not a year of days just under it, and because what a press costs varies with
the model and with how many scans it reads. `AUTOFILL_YEARLY_CENTS` and
`AUTOFILL_TRIAL_YEARLY_CENTS` are chosen by plan state the same way and fall back the
same way. The counter keeps tokens, never money; each press sums the year's tokens and
prices them with the table in `packages/shared/src/llm-prices.ts`, which goes stale when
Anthropic changes a price and is a percent-level error on a guard, not a hole. A press on
the decision model, which reports no tokens, counts as a fixed tenth of a cent. The
refusal says this year's included Auto-fill is used up and that it returns on 1 January
(UTC, like the day), and names no amount: the cap is the instance's cost, not the
person's bill.

unbent.app sets all four: 500 presses and 5000 cents (fifty dollars) a year for a paying
account, 50 presses and 300 cents (three dollars) for a trial. Fifty dollars is more than
the plan costs and still a ceiling on a loop that never trips the day's cap; three dollars
files a fortnight's worth of scans and bounds what a trial made in bulk can spend.

### Changing the price

The terms promise every subscriber an email at least 30 days before the renewal a price
change applies to, and nothing sends it. `packages/shared/src/plan.test.ts` pins the two
prices so that changing one fails a test with that promise in its message; it is the
reminder, not a check. The order is:

1. Write to every current subscriber with the new price and the date it starts, at least
   30 days before the first renewal it would apply to. A subscriber who cancels before
   then keeps the year already paid for at the old price.
2. After the 30 days, change the price in Paddle's catalog: a new price on the product,
   with the old one archived, so renewals move and nothing already in flight does.
3. Change `PLAN_PRICE_USD` or `STORAGE_ADDON_PRICE_USD` in `packages/shared/src/plan.ts`
   and the pinned number in its test in the same commit, and deploy. The front page and
   the Plan page quote the constants; the terms deliberately do not, and their effective
   date does not move for a price.

A lapsed account is the other promise the terms make by hand: it is kept read-only for a
year and may then be deleted, after an email asking its owner to export it. Nothing
deletes on a timer and nothing sends that mail either. The operator's delete confirm says
so on an account whose plan has lapsed, which is the moment it matters.

### Setting up Paddle

Sandbox and live are two separate Paddle accounts, with separate logins, keys, prices and
webhook secrets: [sandbox-vendors.paddle.com](https://sandbox-vendors.paddle.com) is for
building against, and needs no approval; [vendors.paddle.com](https://vendors.paddle.com)
is the real one, and its verification (the website review, the business and the
identity checks) takes days, so start it early. Everything below is done in both, the
sandbox first.

1. **Catalog → Products.** Two products: the plan, with one price of $36 a year, and
   the storage add-on, with one price of $12 a year and quantity turned on. The tax
   category is Standard Digital Goods, which needs no approval. Copy both price ids,
   `pri_…`.
2. **Developer tools → Authentication.** An API key with `customer`, `transaction` and
   `subscription` read and write and `customer_portal_session` write, which is shown
   once; and a client-side token, which is public and ships in the page.
3. **Checkout → Checkout configuration.** A default payment link (the homepage is fine,
   and `https://localhost/` in the sandbox) and the payment methods to offer. The
   checkout itself is Paddle's overlay on the Plan page, so no page of yours needs it.
4. **Developer tools → Notifications.** A destination of type webhook at
   `https://<host>/api/billing/webhook`, with the subscription events
   (`subscription.created`, `activated`, `trialing`, `updated`, `past_due`, `paused`,
   `resumed`, `canceled`), `transaction.completed`, and the adjustment events
   (`adjustment.created`, `adjustment.updated`). Its secret, `pdl_ntfset_…`, is
   what every delivery is signed with. The Worker answers inside Paddle's five seconds
   and applies each event once, in any order, so a retry or a late delivery changes
   nothing. The adjustment events are how a refund reaches the Worker: Paddle leaves a
   refunded subscription renewing, and the terms say it does not, so an approved refund
   of the plan cancels the subscription at once and a refund of only the storage add-on
   takes the add-on off. A destination made before those two were listed has to be
   edited to send them, or a refund is money back and nothing else.
5. **The five settings** on the Worker, as secrets: `PADDLE_API_KEY`,
   `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PLAN_PRICE_ID` and
   `PADDLE_STORAGE_PRICE_ID`. Which environment they belong to is read off the key:
   `pdl_sdbx_` is the sandbox, `pdl_live_` is live. In `.dev.vars` locally; as the
   `DEV_PADDLE_*` GitHub secrets for the dev instance, which the deploy carries over with
   the sandbox's values; and on production by hand, `pnpm exec wrangler secret put` from
   `apps/api` for each, with the live account's. `APP_URL` must be set too, since the
   mail that says a plan has ended names it. That mail goes out from the hourly sweep
   through the same provider and allowance as the sign-in codes, so it is capped at two
   an hour (`LAPSE_MAIL_PER_RUN`): on Resend's free tier of a hundred a day, a cluster of
   trials ending together (every account that existed when billing went on starts its
   fortnight at its first visit) must not crowd the codes out. On a paid mail tier the
   cap can go up (MAK-220).

Locally, Paddle cannot reach a webhook on `localhost`; a tunnel (`cloudflared tunnel
--url http://localhost:<API_PORT>`) gives it an address for a session, or the sandbox's
simulator sends a sample event to one. The live suite proves the rest with a signed body
of its own (`apps/api/test/plan.test.ts`), given the dev server's secret and price ids as
`PADDLE_WEBHOOK_SECRET`, `PADDLE_PLAN_PRICE_ID` and `PADDLE_STORAGE_PRICE_ID`, the same
lines as `.dev.vars`. Test cards are in Paddle's sandbox docs; `4242 4242 4242 4242` with
any future date succeeds.

Going live is the same five settings from the live account, after its verification. The
website review wants the pricing public, and terms, a privacy policy and a refund policy
naming Paddle as the merchant of record. Its form refuses a bare domain for the pricing
page, so the addresses to give it are `/pricing` (the offer on a page of its own, drawn
from the same block as the front page's Pricing section), `/terms`, `/privacy` and
`/terms#refunds`. The built-in documents say all of it wherever
the instance sells a plan: billing on, or `FRONT_PAGE=1`, since the front page states the
price and the review comes before the live keys that turn billing on. They are the terms'
"Plans and payment" and "Refunds", and Paddle among the policy's services. The refund
policy is at `/terms#refunds`, under the Terms link in the front page's footer rather than
a link of its own. Everything an account is told (the trial's end, a lapse, the mail) is
the same in both environments.

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
