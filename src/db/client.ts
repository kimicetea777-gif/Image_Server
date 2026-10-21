import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(env.DATABASE_PATH), { recursive: true });

export const db = new DatabaseSync(env.DATABASE_PATH);

db.exec("PRAGMA journal_mode = WAL"); //읽기와 쓰기가 서로를 막지 않음
db.exec("PRAGMA busy_timeout = 5000");  //다른 쓰기에 걸리면 즉시 실패하지 않고 최대 5초 기다림
db.exec("PRAGMA foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
db.exec(schema);

// CREATE TABLE IF NOT EXISTS는 이미 있는 테이블에 새 컬럼을 추가해 주지 않으므로, 이 컬럼이 생기기 전에
// 만들어진 DB 파일(운영 중인 볼륨)에는 직접 보강한다. 기존 프로젝트는 DEFAULT 1로 활성 상태를 유지한다.
const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as unknown as { name: string }[];
if (!projectColumns.some((column) => column.name === "active")) {
  db.exec("ALTER TABLE projects ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
}
