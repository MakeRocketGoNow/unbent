-- Which version of the terms and privacy policy each account agreed to, and when (MAK-209).
--
-- On Better Auth's `user` table because the session carries `legalVersion` to the app
-- (`additionalFields` in src/auth.ts), so the app can tell whether to ask without a request
-- of its own. `legalAgreedAt` is the record of when, written beside it by
-- `POST /api/legal/agree` and read by nobody in the app; it is the answer to "did this
-- person agree, and to what" if anyone ever has to show it.
--
-- Null in both for every account that existed before this, which is every account that
-- has not agreed yet: they are asked the next time they open the app.
ALTER TABLE user ADD COLUMN legalVersion TEXT;
ALTER TABLE user ADD COLUMN legalAgreedAt TEXT;
