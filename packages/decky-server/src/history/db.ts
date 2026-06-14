import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deckStateDir } from '@decky/shared/node'

// Global history DB lives in deckStateDir() so it spans every workspace on this machine.
// Each row carries workspace_id so the renderer can filter to the active workspace
// (default view) or expand cross-workspace when the user asks.
let db: Database.Database | null = null

export function historyDbPath(): string {
  return join(deckStateDir(), 'history.db')
}

export function openHistoryDb(): Database.Database {
  if (db) return db
  const path = historyDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const inst = new Database(path)
  inst.pragma('journal_mode = WAL')
  inst.pragma('foreign_keys = ON')
  migrate(inst)
  db = inst
  return inst
}

export function getHistoryDb(): Database.Database {
  if (!db) throw new Error('[history] db not opened — call openHistoryDb() first')
  return db
}

export function closeHistoryDb(): void {
  if (!db) return
  try {
    db.close()
  } catch {
    // already closing
  }
  db = null
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `)
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null
  }
  const current = row?.v ?? 0
  if (current < 1) applyV1(db)
}

function applyV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      title TEXT,
      favicon TEXT,
      card_id TEXT,
      workspace_id TEXT NOT NULL,
      visited_at INTEGER NOT NULL,
      dwell_ms INTEGER NOT NULL DEFAULT 0,
      navigated_from TEXT,
      transition TEXT
    );
    CREATE INDEX idx_visits_ws_time ON visits(workspace_id, visited_at DESC);
    CREATE INDEX idx_visits_card_time ON visits(card_id, visited_at DESC);
    CREATE INDEX idx_visits_url ON visits(url);

    CREATE TABLE pages (
      url TEXT PRIMARY KEY,
      text TEXT,
      text_extracted_at INTEGER,
      embedding BLOB,
      embedded_at INTEGER
    );

    CREATE VIRTUAL TABLE pages_fts USING fts5(
      url UNINDEXED, title, text,
      tokenize="unicode61 remove_diacritics 2"
    );

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      summary TEXT,
      visit_ids TEXT NOT NULL
    );

    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );

    CREATE TABLE tag_links (
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (tag_id, target_type, target_id)
    );
    CREATE INDEX idx_tag_links_target ON tag_links(target_type, target_id);

    INSERT INTO schema_version (version) VALUES (1);
  `)
}
