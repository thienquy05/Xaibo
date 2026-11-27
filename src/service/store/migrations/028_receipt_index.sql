-- 028 (P6-T10 unit 2a, XAIBO-PROD-574; design review R2): the last lifecycle receipt per agent and profile (Agent Map
-- Agents list, FR-06) is a bounded seek, newest first, never a scan of every delivery.
CREATE INDEX hook_delivery_receipt ON hook_delivery (agent, profile_key, received_ts);
CREATE INDEX report_delivery_receipt ON report_delivery (agent, profile_key, received_ts);
