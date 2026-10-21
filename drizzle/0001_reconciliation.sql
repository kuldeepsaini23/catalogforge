-- An import may only be marked completed when every sheet row exists and is in a terminal state
-- (done / needs_review / failed). This makes "counts always add up to the sheet" a database
-- invariant rather than an application promise.
CREATE OR REPLACE FUNCTION imports_reconcile_check() RETURNS trigger AS $$
DECLARE
  total integer;
  pending integer;
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    SELECT count(*), count(*) FILTER (WHERE status = 'pending')
      INTO total, pending
      FROM source_rows WHERE import_id = NEW.id;
    IF NEW.total_rows IS NULL OR total <> NEW.total_rows THEN
      RAISE EXCEPTION 'reconciliation failed for import %: % rows stored, sheet has %', NEW.id, total, NEW.total_rows
        USING ERRCODE = 'check_violation';
    END IF;
    IF pending > 0 THEN
      RAISE EXCEPTION 'reconciliation failed for import %: % rows still pending', NEW.id, pending
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER imports_reconcile_check
  BEFORE UPDATE OF status ON imports
  FOR EACH ROW EXECUTE FUNCTION imports_reconcile_check();
--> statement-breakpoint
-- Rows of a completed import cannot be silently reset to pending.
CREATE OR REPLACE FUNCTION source_rows_no_regress() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'pending' AND OLD.status <> 'pending'
     AND EXISTS (SELECT 1 FROM imports WHERE id = NEW.import_id AND status = 'completed') THEN
    RAISE EXCEPTION 'row % of completed import % cannot return to pending', NEW.row_number, NEW.import_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER source_rows_no_regress
  BEFORE UPDATE OF status ON source_rows
  FOR EACH ROW EXECUTE FUNCTION source_rows_no_regress();
