CREATE TABLE IF NOT EXISTS radar_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_dossiers (
  market_id TEXT PRIMARY KEY,
  event_slug TEXT NOT NULL,
  question TEXT NOT NULL,
  crowd_prob REAL NOT NULL,
  fair_prob REAL NOT NULL,
  edge_bps INTEGER NOT NULL,
  direction TEXT NOT NULL,
  confidence REAL NOT NULL,
  model_name TEXT NOT NULL,
  base_rate_card_json TEXT NOT NULL,
  trap_devil_card_json TEXT NOT NULL,
  chief_card_json TEXT NOT NULL,
  verbatim_check_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sealed_epochs (
  epoch_hour INTEGER PRIMARY KEY,
  merkle_root TEXT NOT NULL,
  market_count INTEGER NOT NULL,
  mispriced_count INTEGER NOT NULL,
  tx_hash TEXT,
  chain_id INTEGER NOT NULL DEFAULT 4663,
  sealed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sealed_forecasts (
  epoch_hour INTEGER NOT NULL,
  market_id TEXT NOT NULL,
  event_slug TEXT NOT NULL,
  question TEXT NOT NULL,
  crowd_prob_bps INTEGER NOT NULL,
  fair_prob_bps INTEGER NOT NULL,
  edge_bps INTEGER NOT NULL,
  direction TEXT NOT NULL,
  confidence_bps INTEGER NOT NULL,
  model_source TEXT NOT NULL,
  leaf_hash TEXT NOT NULL,
  canonical_leaf TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  resolved_outcome INTEGER,
  resolved_at INTEGER,
  PRIMARY KEY (epoch_hour, market_id)
);

CREATE TABLE IF NOT EXISTS priority_burns (
  tx_hash TEXT PRIMARY KEY,
  burner_wallet TEXT NOT NULL,
  burned_tokens INTEGER NOT NULL,
  target_query TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_quotas (
  actor_key TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  kind TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (actor_key, day_utc, kind)
);
