-- Drop the 8-parameter overloads of upsert_review_queue_from_pi that were
-- superseded by the 10-parameter versions added in 20260429320000.
-- Keeping both causes Postgres ambiguity errors when calling with 8 args
-- that include unknown-typed literals.

DROP FUNCTION IF EXISTS private.upsert_review_queue_from_pi(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ
);

DROP FUNCTION IF EXISTS chefbyte.upsert_review_queue_from_pi_admin(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ
);
