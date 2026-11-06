PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL, business_name TEXT NOT NULL, phone TEXT NOT NULL,
  password_hash TEXT NOT NULL, client_salt TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
  contract TEXT NOT NULL CHECK (contract IN ('SANJYOT','TECHNOEDGE')),
  share_token TEXT NOT NULL UNIQUE,
  whatsapp_consent INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_consent IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS advances (
  id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0 AND amount_paise <= 1000000000),
  date TEXT NOT NULL, method TEXT NOT NULL CHECK (method IN ('cash','online')),
  note TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  request_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  contract TEXT NOT NULL CHECK (contract IN ('SANJYOT','TECHNOEDGE')),
  voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0,1)),
  void_reason TEXT, voided_at TEXT,
  CHECK ((voided = 0 AND void_reason IS NULL AND voided_at IS NULL) OR
         (voided = 1 AND length(void_reason) > 0 AND voided_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS advances_worker_date ON advances(worker_id,date);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);

-- Triggers keep a successful mutation and its audit entry in one D1 transaction.
-- Failed compare-and-swap updates touch no rows and therefore create no audit.
CREATE TRIGGER IF NOT EXISTS owner_created AFTER INSERT ON owner BEGIN
  INSERT INTO audit VALUES (lower(hex(randomblob(16))), 'create', 'owner', '1',
    'Owner account set up.', '{}', NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS owner_profile_updated AFTER UPDATE OF name,business_name,phone ON owner
WHEN OLD.name <> NEW.name OR OLD.business_name <> NEW.business_name OR OLD.phone <> NEW.phone BEGIN
  INSERT INTO audit VALUES (lower(hex(randomblob(16))), 'update', 'owner', '1',
    'Business profile updated.', '{}', NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS owner_password_updated AFTER UPDATE OF password_hash,client_salt ON owner
WHEN OLD.password_hash <> NEW.password_hash OR OLD.client_salt <> NEW.client_salt BEGIN
  DELETE FROM sessions;
  INSERT INTO audit VALUES (lower(hex(randomblob(16))), 'update', 'owner', '1',
    'Owner password changed. All previous sessions signed out.', '{}', NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS worker_created AFTER INSERT ON workers BEGIN
  INSERT INTO audit VALUES (lower(hex(randomblob(16))), 'create', 'worker', NEW.id,
    NEW.name || ' added to ' || NEW.contract || '.', '{}', NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS worker_details_updated AFTER UPDATE OF name,phone,contract,whatsapp_consent ON workers
WHEN OLD.name <> NEW.name OR OLD.phone <> NEW.phone OR OLD.contract <> NEW.contract OR OLD.whatsapp_consent <> NEW.whatsapp_consent BEGIN
  UPDATE workers SET revision=revision+1 WHERE id=NEW.id;
  INSERT INTO audit VALUES (lower(hex(randomblob(16))), 'update', 'worker', NEW.id,
    NEW.name || '’s worker details updated.', '{}', NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS worker_link_rotated AFTER UPDATE OF share_token ON workers
WHEN OLD.share_token <> NEW.share_token BEGIN
  UPDATE workers SET revision=revision+1 WHERE id=NEW.id;
  INSERT INTO audit VALUES (lower(hex(randomblob(16))), 'rotate', 'worker', NEW.id,
    NEW.name || '’s private link replaced. The old link no longer works.', '{}', NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS advance_created AFTER INSERT ON advances BEGIN
  UPDATE workers SET revision=revision+1 WHERE id=NEW.worker_id;
  INSERT INTO audit VALUES (lower(hex(randomblob(16))), 'create', 'advance', NEW.id,
    'INR ' || printf('%.2f', NEW.amount_paise / 100.0) || ' advance recorded for ' ||
    (SELECT name FROM workers WHERE id=NEW.worker_id) || '.',
    json_object('workerId', NEW.worker_id, 'amountPaise', NEW.amount_paise, 'date', NEW.date,
      'method', NEW.method, 'note', NEW.note, 'contract', NEW.contract), NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS advance_invariants BEFORE UPDATE ON advances BEGIN
  SELECT CASE WHEN NEW.worker_id <> OLD.worker_id OR NEW.contract <> OLD.contract
    THEN RAISE(ABORT, 'The worker and contract snapshot cannot be changed.') END;
  SELECT CASE WHEN OLD.voided = 1 THEN RAISE(ABORT, 'A cancelled advance cannot be changed.') END;
  SELECT CASE WHEN NEW.revision <> OLD.revision + 1 THEN RAISE(ABORT, 'Invalid advance revision.') END;
END;
CREATE TRIGGER IF NOT EXISTS advance_updated AFTER UPDATE ON advances BEGIN
  UPDATE workers SET revision=revision+1 WHERE id=NEW.worker_id;
  INSERT INTO audit VALUES (lower(hex(randomblob(16))), CASE WHEN NEW.voided=1 THEN 'void' ELSE 'update' END,
    'advance', NEW.id,
    CASE WHEN NEW.voided=1 THEN
      'INR ' || printf('%.2f', OLD.amount_paise / 100.0) || ' advance for ' ||
      (SELECT name FROM workers WHERE id=NEW.worker_id) || ' cancelled: ' || NEW.void_reason
    ELSE (SELECT name FROM workers WHERE id=NEW.worker_id) || '’s advance corrected from INR ' ||
      printf('%.2f', OLD.amount_paise / 100.0) || ' to INR ' || printf('%.2f', NEW.amount_paise / 100.0) || '.' END,
    json_object('before', json_object('amountPaise', OLD.amount_paise, 'date', OLD.date,
      'method', OLD.method, 'note', OLD.note, 'revision', OLD.revision),
      'after', json_object('amountPaise', NEW.amount_paise, 'date', NEW.date, 'method', NEW.method,
      'note', NEW.note, 'revision', NEW.revision, 'voided', NEW.voided, 'reason', NEW.void_reason)),
    NEW.updated_at);
END;
