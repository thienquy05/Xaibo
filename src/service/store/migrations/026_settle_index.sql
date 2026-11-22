-- Gate 5 round 2 G5-N1 (decision 2990): a purge settles a session's requests and turns in row-id batches (purge.ts
-- settleStep); these indexes give each batch a seek on (session_id, rowid), never a sort of the whole session.
CREATE INDEX usage_session ON usage (session_id);
CREATE INDEX turns_session ON turns (session_id);
