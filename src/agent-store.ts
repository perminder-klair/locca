import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function agentDataDir(): string {
  return process.env.LOCCA_AGENT_DATA_DIR || join(homedir(), '.locca', 'agent');
}

export interface AgentSession {
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
}

export interface AgentJob {
  id: string;
  title: string;
  prompt: string;
  workspace: string;
  intervalMinutes: number;
  nextRun: number;
  enabled: number;
  lastSession: string | null;
  error: string | null;
}

export function openAgentStore(dir = agentDataDir()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, 'locca.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, workspace TEXT NOT NULL,
      intervalMinutes INTEGER NOT NULL, nextRun INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      lastSession TEXT, error TEXT
    );`);
  return {
    close: () => db.close(),
    sessions: () =>
      db
        .prepare('SELECT * FROM sessions ORDER BY createdAt DESC')
        .all() as unknown as AgentSession[],
    session: (id: string) =>
      db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as unknown as
        | AgentSession
        | undefined,
    addSession: (session: AgentSession) =>
      db
        .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)')
        .run(session.id, session.title, session.workspace, session.createdAt),
    jobs: () => db.prepare('SELECT * FROM jobs ORDER BY nextRun').all() as unknown as AgentJob[],
    addJob: (job: AgentJob) =>
      db
        .prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          job.id,
          job.title,
          job.prompt,
          job.workspace,
          job.intervalMinutes,
          job.nextRun,
          job.enabled,
          job.lastSession,
          job.error,
        ),
    deleteJob: (id: string) => db.prepare('DELETE FROM jobs WHERE id=?').run(id),
    finishJob: (id: string, nextRun: number, session: string | null, error: string | null) =>
      db
        .prepare('UPDATE jobs SET nextRun=?, lastSession=?, error=? WHERE id=?')
        .run(nextRun, session, error, id),
  };
}
