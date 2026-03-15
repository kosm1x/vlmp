import type Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

const TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS library_folders (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  scan_status TEXT NOT NULL DEFAULT 'pending',
  last_scanned INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS media_items (
  id INTEGER PRIMARY KEY,
  library_folder_id INTEGER REFERENCES library_folders(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  file_path TEXT UNIQUE NOT NULL,
  file_size INTEGER,
  title TEXT NOT NULL,
  sort_title TEXT,
  year INTEGER,
  description TEXT,
  genres TEXT,
  rating REAL,
  duration INTEGER,
  codec_video TEXT,
  codec_audio TEXT,
  resolution_width INTEGER,
  resolution_height INTEGER,
  bitrate INTEGER,
  audio_tracks TEXT,
  poster_path TEXT,
  backdrop_path TEXT,
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS tv_shows (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  year INTEGER,
  description TEXT,
  poster_path TEXT,
  backdrop_path TEXT,
  folder_path TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY,
  show_id INTEGER NOT NULL REFERENCES tv_shows(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL,
  title TEXT,
  poster_path TEXT,
  UNIQUE(show_id, season_number)
);
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  media_id INTEGER UNIQUE NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  episode_number INTEGER NOT NULL,
  UNIQUE(season_id, episode_number)
);
CREATE TABLE IF NOT EXISTS doc_series (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  poster_path TEXT,
  folder_path TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_series_episodes (
  id INTEGER PRIMARY KEY,
  series_id INTEGER NOT NULL REFERENCES doc_series(id) ON DELETE CASCADE,
  media_id INTEGER UNIQUE NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  episode_number INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guest_passes (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  max_views INTEGER NOT NULL DEFAULT 1,
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS watch_progress (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  position_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, media_id)
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  UNIQUE(playlist_id, position)
);
CREATE TABLE IF NOT EXISTS subtitles (
  id INTEGER PRIMARY KEY,
  media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  label TEXT,
  format TEXT NOT NULL,
  file_path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local',
  UNIQUE(media_id, language, source)
);
CREATE TABLE IF NOT EXISTS metadata_cache (
  id INTEGER PRIMARY KEY,
  media_id INTEGER REFERENCES media_items(id) ON DELETE CASCADE,
  show_id INTEGER REFERENCES tv_shows(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(media_id, provider),
  UNIQUE(show_id, provider)
);
CREATE TABLE IF NOT EXISTS federated_servers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  shared_secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_seen INTEGER,
  added_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS federation_invites (
  id INTEGER PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS viewing_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  watched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  position_seconds REAL NOT NULL,
  duration_seconds REAL,
  completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_preferences (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('like', 'dislike')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, media_id)
);
CREATE TABLE IF NOT EXISTS ai_cache (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  computed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, cache_key)
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(type);
CREATE INDEX IF NOT EXISTS idx_media_title ON media_items(title);
CREATE INDEX IF NOT EXISTS idx_media_library ON media_items(library_folder_id);
CREATE INDEX IF NOT EXISTS idx_media_sort_title ON media_items(sort_title);
CREATE INDEX IF NOT EXISTS idx_media_added_at ON media_items(added_at);
CREATE INDEX IF NOT EXISTS idx_episodes_season ON episodes(season_id);
CREATE INDEX IF NOT EXISTS idx_subtitles_media ON subtitles(media_id);
CREATE INDEX IF NOT EXISTS idx_guest_code ON guest_passes(code);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_federated_status ON federated_servers(status);
CREATE INDEX IF NOT EXISTS idx_viewing_log_user_completed ON viewing_log(user_id, completed, watched_at);
CREATE INDEX IF NOT EXISTS idx_viewing_log_media ON viewing_log(media_id);
CREATE INDEX IF NOT EXISTS idx_user_prefs_user ON user_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_cache_user_key ON ai_cache(user_id, cache_key);
CREATE INDEX IF NOT EXISTS idx_metadata_cache_media ON metadata_cache(media_id);
CREATE INDEX IF NOT EXISTS idx_metadata_cache_show ON metadata_cache(show_id);
`;

export function initSchema(db: Database.Database): void {
  db.exec(TABLES);
  db.exec(INDEXES);
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`,
  );
  const row = db.prepare("SELECT version FROM schema_version").get() as
    | { version: number }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
      SCHEMA_VERSION,
    );
  }
}
