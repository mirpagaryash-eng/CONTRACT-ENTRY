-- Server-only PostgreSQL storage. The browser never connects to this schema.
-- Run this whole file in the deployment's migration transaction. No existing
-- rows are deleted, and the definitions can be applied again safely.
CREATE SCHEMA IF NOT EXISTS hisab;
REVOKE ALL ON SCHEMA hisab FROM PUBLIC;

CREATE TABLE IF NOT EXISTS hisab.owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  business_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  client_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hisab.sessions (
  token_hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON hisab.sessions(expires_at);

CREATE TABLE IF NOT EXISTS hisab.workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  contract TEXT NOT NULL CHECK (contract IN ('SANJYOT','TECHNOEDGE')),
  share_token TEXT NOT NULL UNIQUE,
  whatsapp_consent INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_consent IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hisab.advances (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES hisab.workers(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0 AND amount_paise <= 1000000000),
  date TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','online')),
  note TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  request_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  contract TEXT NOT NULL CHECK (contract IN ('SANJYOT','TECHNOEDGE')),
  voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0,1)),
  void_reason TEXT,
  voided_at TEXT,
  CHECK ((voided = 0 AND void_reason IS NULL AND voided_at IS NULL) OR
         (voided = 1 AND length(void_reason) > 0 AND voided_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS advances_worker_date ON hisab.advances(worker_id,date);

CREATE TABLE IF NOT EXISTS hisab.state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0)
);
INSERT INTO hisab.state(id,revision,schema_version) VALUES(1,0,1)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS hisab.audit (
  sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hisab.rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON hisab.rate_limits(expires_at);

-- PostgreSQL identity values can be allocated in a different order from commits.
-- A singleton counter gives polling a committed revision without missing a late
-- transaction whose audit identity is below an already visible MAX value.
CREATE OR REPLACE FUNCTION hisab.bump_revision()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, hisab AS $$
BEGIN
  UPDATE hisab.state SET revision=revision+1 WHERE id=1;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER audit_revision_changed
AFTER INSERT ON hisab.audit FOR EACH ROW
EXECUTE FUNCTION hisab.bump_revision();

-- Every successful mutation and its audit entry commit or roll back together.
-- Trigger functions use fixed schema-qualified objects and invoker privileges.
CREATE OR REPLACE FUNCTION hisab.audit_owner_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, hisab AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO hisab.audit(id,action,entity_type,entity_id,summary,data,created_at)
    VALUES (replace(gen_random_uuid()::text,'-',''), 'create', 'owner', '1',
      'Owner account set up.', '{}', NEW.created_at);
    RETURN NEW;
  END IF;

  IF ROW(OLD.name,OLD.business_name,OLD.phone)
      IS DISTINCT FROM ROW(NEW.name,NEW.business_name,NEW.phone) THEN
    INSERT INTO hisab.audit(id,action,entity_type,entity_id,summary,data,created_at)
    VALUES (replace(gen_random_uuid()::text,'-',''), 'update', 'owner', '1',
      'Business profile updated.', '{}', NEW.updated_at);
  END IF;

  IF ROW(OLD.password_hash,OLD.client_salt)
      IS DISTINCT FROM ROW(NEW.password_hash,NEW.client_salt) THEN
    DELETE FROM hisab.sessions;
    INSERT INTO hisab.audit(id,action,entity_type,entity_id,summary,data,created_at)
    VALUES (replace(gen_random_uuid()::text,'-',''), 'update', 'owner', '1',
      'Owner password changed. All previous sessions signed out.', '{}', NEW.updated_at);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER owner_created
AFTER INSERT ON hisab.owner FOR EACH ROW
EXECUTE FUNCTION hisab.audit_owner_mutation();
CREATE OR REPLACE TRIGGER owner_updated
AFTER UPDATE OF name,business_name,phone,password_hash,client_salt ON hisab.owner
FOR EACH ROW EXECUTE FUNCTION hisab.audit_owner_mutation();

CREATE OR REPLACE FUNCTION hisab.audit_worker_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, hisab AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO hisab.audit(id,action,entity_type,entity_id,summary,data,created_at)
    VALUES (replace(gen_random_uuid()::text,'-',''), 'create', 'worker', NEW.id,
      NEW.name || ' added to ' || NEW.contract || '.', '{}', NEW.created_at);
    RETURN NEW;
  END IF;

  IF ROW(OLD.name,OLD.phone,OLD.contract,OLD.whatsapp_consent)
      IS DISTINCT FROM ROW(NEW.name,NEW.phone,NEW.contract,NEW.whatsapp_consent) THEN
    UPDATE hisab.workers SET revision=revision+1 WHERE id=NEW.id;
    INSERT INTO hisab.audit(id,action,entity_type,entity_id,summary,data,created_at)
    VALUES (replace(gen_random_uuid()::text,'-',''), 'update', 'worker', NEW.id,
      NEW.name || '’s worker details updated.', '{}', NEW.updated_at);
  END IF;

  IF OLD.share_token IS DISTINCT FROM NEW.share_token THEN
    UPDATE hisab.workers SET revision=revision+1 WHERE id=NEW.id;
    INSERT INTO hisab.audit(id,action,entity_type,entity_id,summary,data,created_at)
    VALUES (replace(gen_random_uuid()::text,'-',''), 'rotate', 'worker', NEW.id,
      NEW.name || '’s private link replaced. The old link no longer works.', '{}', NEW.updated_at);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER worker_created
AFTER INSERT ON hisab.workers FOR EACH ROW
EXECUTE FUNCTION hisab.audit_worker_mutation();
CREATE OR REPLACE TRIGGER worker_updated
AFTER UPDATE OF name,phone,contract,whatsapp_consent,share_token ON hisab.workers
FOR EACH ROW EXECUTE FUNCTION hisab.audit_worker_mutation();

CREATE OR REPLACE FUNCTION hisab.check_advance_invariants()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, hisab AS $$
BEGIN
  IF NEW.worker_id IS DISTINCT FROM OLD.worker_id
      OR NEW.contract IS DISTINCT FROM OLD.contract THEN
    RAISE EXCEPTION 'The worker and contract snapshot cannot be changed.'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.voided = 1 THEN
    RAISE EXCEPTION 'A cancelled advance cannot be changed.'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revision IS DISTINCT FROM OLD.revision+1 THEN
    RAISE EXCEPTION 'Invalid advance revision.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER advance_invariants
BEFORE UPDATE ON hisab.advances FOR EACH ROW
EXECUTE FUNCTION hisab.check_advance_invariants();

CREATE OR REPLACE FUNCTION hisab.audit_advance_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, hisab AS $$
DECLARE
  worker_name TEXT;
  event_action TEXT;
  event_summary TEXT;
  event_data TEXT;
BEGIN
  UPDATE hisab.workers SET revision=revision+1 WHERE id=NEW.worker_id;
  SELECT name INTO STRICT worker_name FROM hisab.workers WHERE id=NEW.worker_id;

  IF TG_OP = 'INSERT' THEN
    event_action := 'create';
    event_summary := 'INR ' || to_char(NEW.amount_paise::numeric / 100,'FM999999999990.00') ||
      ' advance recorded for ' || worker_name || '.';
    event_data := json_build_object('workerId', NEW.worker_id,
      'amountPaise', NEW.amount_paise, 'date', NEW.date, 'method', NEW.method,
      'note', NEW.note, 'contract', NEW.contract)::text;
  ELSE
    IF NEW.voided = 1 THEN
      event_action := 'void';
      event_summary := 'INR ' || to_char(OLD.amount_paise::numeric / 100,'FM999999999990.00') ||
        ' advance for ' || worker_name || ' cancelled: ' || NEW.void_reason;
    ELSE
      event_action := 'update';
      event_summary := worker_name || '’s advance corrected from INR ' ||
        to_char(OLD.amount_paise::numeric / 100,'FM999999999990.00') || ' to INR ' ||
        to_char(NEW.amount_paise::numeric / 100,'FM999999999990.00') || '.';
    END IF;
    event_data := json_build_object(
      'before', json_build_object('amountPaise', OLD.amount_paise, 'date', OLD.date,
        'method', OLD.method, 'note', OLD.note, 'revision', OLD.revision),
      'after', json_build_object('amountPaise', NEW.amount_paise, 'date', NEW.date,
        'method', NEW.method, 'note', NEW.note, 'revision', NEW.revision,
        'voided', NEW.voided, 'reason', NEW.void_reason))::text;
  END IF;

  INSERT INTO hisab.audit(id,action,entity_type,entity_id,summary,data,created_at)
  VALUES (replace(gen_random_uuid()::text,'-',''), event_action, 'advance', NEW.id,
    event_summary, event_data, CASE WHEN TG_OP='INSERT' THEN NEW.created_at ELSE NEW.updated_at END);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER advance_created
AFTER INSERT ON hisab.advances FOR EACH ROW
EXECUTE FUNCTION hisab.audit_advance_mutation();
CREATE OR REPLACE TRIGGER advance_updated
AFTER UPDATE ON hisab.advances FOR EACH ROW
EXECUTE FUNCTION hisab.audit_advance_mutation();

-- No browser or Supabase Data API role can use this server-only schema. RLS
-- remains enabled as another boundary if someone later adds it to API exposure.
ALTER TABLE hisab.owner ENABLE ROW LEVEL SECURITY;
ALTER TABLE hisab.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hisab.workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE hisab.advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE hisab.audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE hisab.rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE hisab.state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA hisab FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hisab FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hisab FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA hisab REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA hisab REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA hisab REVOKE ALL ON FUNCTIONS FROM PUBLIC;

DO $$
DECLARE browser_role TEXT;
BEGIN
  FOR browser_role IN SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname IN ('anon','authenticated') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA hisab FROM %I',browser_role);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA hisab FROM %I',browser_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA hisab FROM %I',browser_role);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hisab FROM %I',browser_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA hisab REVOKE ALL ON TABLES FROM %I',browser_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA hisab REVOKE ALL ON SEQUENCES FROM %I',browser_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA hisab REVOKE ALL ON FUNCTIONS FROM %I',browser_role);
  END LOOP;
END;
$$;
