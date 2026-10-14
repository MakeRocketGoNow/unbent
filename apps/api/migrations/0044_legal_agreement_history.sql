-- Every version of the terms each account has agreed to, and when (MAK-209).
--
-- 0043 kept only the latest: `user.legalVersion` for the session to carry, and beside it
-- `legalAgreedAt`, which the next agreement overwrote. The terms say the version someone
-- agreed to applies until they agree to a newer one, so when an earlier version was agreed
-- to is the record a dispute about it would need, and it cannot be rebuilt once it is
-- gone. This table is written beside `legalVersion` by `POST /api/legal/agree` and never
-- updated or deleted from: one row per account and version, the first time it was agreed
-- to (`INSERT OR IGNORE` keeps a repeat press from moving it).
--
-- It goes with the account (`ON DELETE CASCADE`), like every other row about a person:
-- the privacy policy says deleting an account removes its records, and a record of
-- agreement is one.
--
-- No index beyond the key, whose first column is how it is read.
CREATE TABLE legal_agreement (
  user_id   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  version   TEXT NOT NULL,
  agreed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, version)
);

-- What 0043 recorded until now, so no agreement already given is lost.
INSERT INTO legal_agreement (user_id, version, agreed_at)
  SELECT id, legalVersion, legalAgreedAt FROM user
  WHERE legalVersion IS NOT NULL AND legalAgreedAt IS NOT NULL;

-- The table holds the time now; a second copy on `user` would only drift from it.
ALTER TABLE user DROP COLUMN legalAgreedAt;
