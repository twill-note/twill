export type Cardinality = '1:1' | '1:N' | 'N:N'

export interface ErdColumn {
  id: string
  name: string
  type: string           // "INT", "VARCHAR(255)", "TIMESTAMP" 등 자유 문자열
  isPK: boolean
  isFK: boolean          // 관계에서 자동 표시하기도 하지만, 명시적 마킹도 허용
  nullable: boolean
  unique: boolean
  defaultVal?: string
  note?: string
}

export interface ErdTable {
  id: string
  name: string
  x: number              // 캔버스 좌표
  y: number
  width: number
  color: string          // 헤더 색 (Tailwind 팔레트 hex)
  columns: ErdColumn[]
  note?: string
}

export interface ErdRelation {
  id: string
  fromTable: string      // ErdTable.id
  fromColumn: string     // ErdColumn.id
  toTable: string
  toColumn: string
  cardinality: Cardinality
  optional?: boolean     // 점선(선택적) vs 실선(필수)
  label?: string
}

/** ERD 내보내기는 MariaDB DDL을 표준으로 사용한다. 이전 파일의 방언 값은 읽기 호환용으로만 남긴다. */
export type SqlDialect = 'mariadb' | 'postgres' | 'mysql' | 'sqlite' | 'generic'

export interface ErdMeta {
  title: string
  dialect: SqlDialect
  updated?: number
  /** `title`이면 제목을 바꿔 저장할 때 파일명도 함께 바꾼다. */
  filenameMode?: 'title' | 'manual'
}

export interface ErdDiagram {
  version: 1
  meta: ErdMeta
  tables: ErdTable[]
  relations: ErdRelation[]
}

export const DEFAULT_TABLE_COLOR = '#3b82f6'  // blue
export const TABLE_COLORS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#8b5cf6', // purple
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#14b8a6', // teal
  '#6366f1', // indigo
  '#6b7280', // gray
]

export function emptyDiagram(title = '새 다이어그램'): ErdDiagram {
  return {
    version: 1,
    meta: { title, dialect: 'mariadb', updated: 0 },
    tables: [],
    relations: [],
  }
}

/** 각 SQL 방언별 흔한 타입 (컬럼 타입 오토컴플리트용). */
export const TYPE_SUGGESTIONS: Record<SqlDialect, string[]> = {
  mariadb: [
    'INT', 'BIGINT', 'SMALLINT', 'TINYINT',
    'VARCHAR(255)', 'TEXT', 'LONGTEXT', 'CHAR(1)',
    'TINYINT(1)',
    'DATETIME', 'TIMESTAMP', 'DATE', 'TIME',
    'DECIMAL(10,2)', 'FLOAT', 'DOUBLE',
    'JSON', 'BINARY(16)', 'BLOB', 'LONGBLOB',
  ],
  postgres: [
    'INT', 'BIGINT', 'SMALLINT', 'SERIAL', 'BIGSERIAL',
    'VARCHAR(255)', 'TEXT', 'CHAR(1)',
    'BOOLEAN',
    'TIMESTAMP', 'TIMESTAMPTZ', 'DATE', 'TIME',
    'NUMERIC(10,2)', 'DECIMAL(10,2)', 'REAL', 'DOUBLE PRECISION',
    'JSON', 'JSONB', 'UUID', 'BYTEA',
  ],
  mysql: [
    'INT', 'BIGINT', 'SMALLINT', 'TINYINT',
    'VARCHAR(255)', 'TEXT', 'LONGTEXT', 'CHAR(1)',
    'BOOLEAN', 'TINYINT(1)',
    'DATETIME', 'TIMESTAMP', 'DATE', 'TIME',
    'DECIMAL(10,2)', 'FLOAT', 'DOUBLE',
    'JSON', 'BINARY(16)', 'BLOB',
  ],
  sqlite: [
    'INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC',
    'BOOLEAN', 'DATETIME', 'DATE',
  ],
  generic: [
    'INT', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'BOOLEAN',
    'TIMESTAMP', 'DATE', 'DECIMAL(10,2)', 'JSON',
  ],
}

/** 저장돼 있던 PostgreSQL/MySQL ERD도 다음 저장부터 MariaDB 기준으로 통일한다. */
export function normalizeMariaDbDiagram(diagram: ErdDiagram): ErdDiagram {
  return diagram.meta.dialect === 'mariadb'
    ? diagram
    : { ...diagram, meta: { ...diagram.meta, dialect: 'mariadb' } }
}

/** 짧은 uid 생성기 — 저장 파일 크기 절약. */
export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10)
}
