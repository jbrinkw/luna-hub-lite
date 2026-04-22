-- scripts/drift/tests/fixtures/ignored-only-a.sql
--
-- "Side A" of the ignored-stanzas-only pair. Against ignored-only-b.sql,
-- the ONLY differences are inside stanzas the normalizer strips (role
-- grants, owners, comments, SET search_path dialect). The meta-test
-- asserts the normalized diff is empty.

SET statement_timeout = 0;
SET search_path = public, pg_catalog;

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

GRANT ALL ON TABLE public.widgets TO postgres;
GRANT SELECT ON TABLE public.widgets TO anon;
ALTER TABLE public.widgets OWNER TO postgres;
COMMENT ON TABLE public.widgets IS 'Local dev comment';
