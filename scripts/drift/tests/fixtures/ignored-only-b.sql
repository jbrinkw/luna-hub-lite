-- scripts/drift/tests/fixtures/ignored-only-b.sql
--
-- "Side B" of the ignored-stanzas-only pair. Structurally identical to
-- ignored-only-a.sql — only the ignored stanzas (roles, grants, owners,
-- comments, SET preamble) differ. The normalizer must produce identical
-- output for both so the diff is empty.

SET statement_timeout = '10min';
SET client_encoding = 'UTF8';
SET search_path = 'public';

CREATE TABLE public.widgets (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz DEFAULT now()
);

CREATE INDEX widgets_name_idx ON public.widgets (name);

CREATE OR REPLACE FUNCTION public.touch_widget(w uuid)
    RETURNS void
    LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.widgets SET name = name WHERE id = w;
END;
$$;

-- Completely different role topology than side A — must be ignored.
GRANT ALL ON TABLE public.widgets TO service_role;
GRANT SELECT ON TABLE public.widgets TO authenticated;
REVOKE ALL ON TABLE public.widgets FROM PUBLIC;
ALTER TABLE public.widgets OWNER TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
COMMENT ON TABLE public.widgets IS 'Prod-managed widget registry';
