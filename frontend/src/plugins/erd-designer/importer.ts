import {
  DEFAULT_TABLE_COLOR,
  TABLE_COLORS,
  uid,
  type ErdColumn,
  type ErdRelation,
  type ErdTable,
} from './types'

type ForeignKey = {
  childTable: string
  childColumns: string[]
  parentTable: string
  parentColumns: string[]
}

type ParsedTable = {
  table: ErdTable
  foreignKeys: ForeignKey[]
}

type SqlComment = {
  table: string
  column?: string
  note: string
}

export type DdlImportResult = {
  tables: ErdTable[]
  relations: ErdRelation[]
  warnings: string[]
}

/**
 * 일반적인 PostgreSQL/MySQL/SQLite CREATE TABLE DDL을 ERD 모델로 변환한다.
 * 지원 범위는 컬럼, PK, UNIQUE, DEFAULT, 인라인/테이블 수준 FK와 ALTER TABLE FK다.
 * 지원하지 않는 제약 조건은 무시하되, 테이블과 컬럼 정의는 최대한 보존한다.
 */
export function parseSqlDdl(source: string, existingTables: ErdTable[] = []): DdlImportResult {
  const statements = splitStatements(removeComments(source))
  const parsed: ParsedTable[] = []
  const foreignKeys: ForeignKey[] = []
  const comments: SqlComment[] = []

  for (const statement of statements) {
    const table = parseCreateTable(statement, parsed.length)
    if (table) {
      parsed.push(table)
      foreignKeys.push(...table.foreignKeys)
      continue
    }
    const alterForeignKey = parseAlterTableForeignKey(statement)
    if (alterForeignKey) foreignKeys.push(alterForeignKey)
    const sqlComment = parseCommentOn(statement)
    if (sqlComment) comments.push(sqlComment)
  }

  const tables = parsed.map(({ table }) => table)
  const warnings: string[] = []
  const importedTableByName = new Map(tables.map((table) => [keyOf(table.name), table]))
  // 새 DDL의 자식 테이블이 이미 저장된 부모 테이블을 참조할 수 있다. 기존 테이블은
  // 관계를 찾는 데만 사용하고, DDL 가져오기로 그 테이블의 컬럼이나 설명을 수정하지 않는다.
  const tableByName = new Map([...existingTables, ...tables].map((table) => [keyOf(table.name), table]))
  const relations: ErdRelation[] = []
  const relationKeys = new Set<string>()

  for (const comment of comments) {
    const table = importedTableByName.get(keyOf(comment.table))
    if (!table) {
      warnings.push(`COMMENT 대상 테이블을 찾지 못했습니다: ${comment.table}`)
      continue
    }
    if (!comment.column) {
      table.note = comment.note
      continue
    }
    const column = findColumn(table, comment.column)
    if (!column) {
      warnings.push(`COMMENT 대상 컬럼을 찾지 못했습니다: ${comment.table}.${comment.column}`)
      continue
    }
    column.note = comment.note
  }

  for (const foreignKey of foreignKeys) {
    const child = importedTableByName.get(keyOf(foreignKey.childTable))
    const parent = tableByName.get(keyOf(foreignKey.parentTable))
    if (!child || !parent) {
      warnings.push(`관계를 연결하지 못했습니다: ${foreignKey.childTable} → ${foreignKey.parentTable}`)
      continue
    }
    const parentColumns = foreignKey.parentColumns.length > 0
      ? foreignKey.parentColumns
      : parent.columns.filter((column) => column.isPK).map((column) => column.name).slice(0, 1)
    if (parentColumns.length !== foreignKey.childColumns.length) {
      warnings.push(`복합 FK의 컬럼 수가 맞지 않습니다: ${child.name} → ${parent.name}`)
      continue
    }

    foreignKey.childColumns.forEach((childName, index) => {
      const childColumn = findColumn(child, childName)
      const parentColumn = findColumn(parent, parentColumns[index] ?? '')
      if (!childColumn || !parentColumn) {
        warnings.push(`FK 컬럼을 찾지 못했습니다: ${child.name}.${childName}`)
        return
      }
      childColumn.isFK = true
      const relationKey = `${child.id}:${childColumn.id}:${parent.id}:${parentColumn.id}`
      if (relationKeys.has(relationKey)) return
      relationKeys.add(relationKey)
      relations.push({
        id: uid('r_'),
        // ERD의 관계 방향은 1쪽(부모) → N쪽(자식)이다.
        fromTable: parent.id,
        fromColumn: parentColumn.id,
        toTable: child.id,
        toColumn: childColumn.id,
        cardinality: '1:N',
        optional: childColumn.nullable,
      })
    })
  }

  return { tables, relations, warnings: [...new Set(warnings)] }
}

function parseCreateTable(statement: string, index: number): ParsedTable | null {
  const match = statement.match(/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(.+?)\s*\(/i)
  if (!match) return null
  const tableName = normalizeIdentifier(match[1] ?? '')
  const openAt = statement.indexOf('(', match[0].length - 1)
  const closeAt = findClosingParen(statement, openAt)
  if (!tableName || openAt < 0 || closeAt < 0) return null

  const table: ErdTable = {
    id: uid('t_'),
    name: tableName,
    x: 80 + (index % 3) * 680,
    y: 80 + Math.floor(index / 3) * 320,
    width: 600,
    color: TABLE_COLORS[index % TABLE_COLORS.length] ?? DEFAULT_TABLE_COLOR,
    columns: [],
  }
  const tableComment = extractComment(statement.slice(closeAt + 1))
  if (tableComment !== undefined) table.note = tableComment
  const foreignKeys: ForeignKey[] = []
  const primaryKeys: string[] = []
  const uniqueKeys: string[] = []

  for (const part of splitTopLevel(statement.slice(openAt + 1, closeAt), ',')) {
    const definition = part.trim()
    if (!definition) continue
    const constraint = definition.replace(/^CONSTRAINT\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)\s+/i, '')
    const primaryKey = constraint.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i)
    if (primaryKey) {
      primaryKeys.push(...splitIdentifiers(primaryKey[1] ?? ''))
      continue
    }
    const uniqueKey = constraint.match(/^UNIQUE(?:\s+KEY|\s+INDEX)?\s*(?:\S+\s*)?\(([^)]+)\)/i)
    if (uniqueKey) {
      uniqueKeys.push(...splitIdentifiers(uniqueKey[1] ?? ''))
      continue
    }
    const foreignKey = parseForeignKey(constraint, tableName)
    if (foreignKey) {
      foreignKeys.push(foreignKey)
      continue
    }
    const column = parseColumn(definition)
    if (!column) continue
    table.columns.push(column)
    if (column.isPK) primaryKeys.push(column.name)
    if (column.unique) uniqueKeys.push(column.name)
    const inlineForeignKey = parseInlineForeignKey(definition, tableName, column.name)
    if (inlineForeignKey) foreignKeys.push(inlineForeignKey)
  }

  for (const name of primaryKeys) {
    const column = findColumn(table, name)
    if (column) {
      column.isPK = true
      column.nullable = false
    }
  }
  for (const name of uniqueKeys) {
    const column = findColumn(table, name)
    if (column && !column.isPK) column.unique = true
  }
  for (const foreignKey of foreignKeys) {
    for (const name of foreignKey.childColumns) {
      const column = findColumn(table, name)
      if (column) column.isFK = true
    }
  }

  return { table, foreignKeys }
}

function parseColumn(definition: string): ErdColumn | null {
  const match = definition.match(/^((?:"[^"]+")|(?:`[^`]+`)|(?:\[[^\]]+\])|(?:[A-Za-z_][\w$]*))\s+([\s\S]+)$/)
  if (!match) return null
  const name = normalizeIdentifier(match[1] ?? '')
  const rest = (match[2] ?? '').trim()
  if (!name || !rest) return null
  const type = rest.split(/\s+(?=(?:CONSTRAINT|PRIMARY\s+KEY|REFERENCES|NOT\s+NULL|NULL|UNIQUE|DEFAULT|COMMENT|CHECK|COLLATE|GENERATED|AUTO_INCREMENT|AUTOINCREMENT|IDENTITY)\b)/i)[0]?.trim() || 'TEXT'
  const isPK = /\bPRIMARY\s+KEY\b/i.test(rest)
  const nullable = !isPK && !/\bNOT\s+NULL\b/i.test(rest)
  const defaultVal = extractDefault(rest)
  const note = extractComment(rest)
  return {
    id: uid('c_'),
    name,
    type,
    isPK,
    isFK: /\bREFERENCES\b/i.test(rest),
    nullable,
    unique: /\bUNIQUE\b/i.test(rest),
    ...(defaultVal ? { defaultVal } : {}),
    ...(note !== undefined ? { note } : {}),
  }
}

function parseForeignKey(definition: string, childTable: string): ForeignKey | null {
  const match = definition.match(/^FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(.+?)(?:\s*\(([^)]+)\))?\s*$/i)
  if (!match) return null
  return {
    childTable,
    childColumns: splitIdentifiers(match[1] ?? ''),
    parentTable: normalizeIdentifier(match[2] ?? ''),
    parentColumns: splitIdentifiers(match[3] ?? ''),
  }
}

function parseInlineForeignKey(definition: string, childTable: string, childColumn: string): ForeignKey | null {
  const match = definition.match(/\bREFERENCES\s+(.+?)(?:\s*\(([^)]+)\))?(?:\s|$)/i)
  if (!match) return null
  return {
    childTable,
    childColumns: [childColumn],
    parentTable: normalizeIdentifier(match[1] ?? ''),
    parentColumns: splitIdentifiers(match[2] ?? ''),
  }
}

function parseAlterTableForeignKey(statement: string): ForeignKey | null {
  const match = statement.match(/^ALTER\s+TABLE\s+(.+?)\s+ADD\s+(?:CONSTRAINT\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(.+?)(?:\s*\(([^)]+)\))?\s*$/i)
  if (!match) return null
  return {
    childTable: normalizeIdentifier(match[1] ?? ''),
    childColumns: splitIdentifiers(match[2] ?? ''),
    parentTable: normalizeIdentifier(match[3] ?? ''),
    parentColumns: splitIdentifiers(match[4] ?? ''),
  }
}

function parseCommentOn(statement: string): SqlComment | null {
  const match = statement.match(/^COMMENT\s+ON\s+(TABLE|COLUMN)\s+(.+?)\s+IS\s+((?:'(?:''|[^'])*')|NULL)\s*$/i)
  if (!match || match[3]?.toUpperCase() === 'NULL') return null
  const note = parseSqlString(match[3] ?? '')
  if (note === null) return null
  const kind = (match[1] ?? '').toUpperCase()
  const target = splitTopLevel(match[2] ?? '', '.')
  if (kind === 'TABLE') {
    return { table: normalizeIdentifier(target.at(-1) ?? ''), note }
  }
  if (target.length < 2) return null
  return {
    table: normalizeIdentifier(target.at(-2) ?? ''),
    column: normalizeIdentifier(target.at(-1) ?? ''),
    note,
  }
}

function extractDefault(rest: string): string | undefined {
  const match = rest.match(/\bDEFAULT\s+([\s\S]+?)(?=\s+(?:CONSTRAINT|NOT\s+NULL|NULL|UNIQUE|PRIMARY\s+KEY|REFERENCES|COMMENT|CHECK|COLLATE|GENERATED|AUTO_INCREMENT|AUTOINCREMENT|IDENTITY)\b|$)/i)
  const value = match?.[1]?.trim()
  return value || undefined
}

function extractComment(rest: string): string | undefined {
  const match = rest.match(/\bCOMMENT\s*(?:=\s*)?('(?:''|[^'])*')/i)
  if (!match) return undefined
  const value = parseSqlString(match[1] ?? '')
  return value ?? undefined
}

function parseSqlString(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) return null
  return trimmed.slice(1, -1).replace(/''/g, "'")
}

function findColumn(table: ErdTable, name: string): ErdColumn | undefined {
  return table.columns.find((column) => keyOf(column.name) === keyOf(name))
}

function splitIdentifiers(value: string): string[] {
  if (!value.trim()) return []
  return splitTopLevel(value, ',').map(normalizeIdentifier).filter(Boolean)
}

function normalizeIdentifier(value: string): string {
  const segment = splitTopLevel(value.trim(), '.').at(-1)?.trim() ?? ''
  if ((segment.startsWith('"') && segment.endsWith('"')) || (segment.startsWith('`') && segment.endsWith('`'))) {
    return segment.slice(1, -1).replace(/""/g, '"')
  }
  if (segment.startsWith('[') && segment.endsWith(']')) return segment.slice(1, -1)
  return segment.replace(/[\s;]+$/g, '')
}

function keyOf(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function removeComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}

function splitStatements(source: string): string[] {
  return splitTopLevel(source, ';')
}

function splitTopLevel(value: string, delimiter: ',' | ';' | '.'): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? ''
    if (quote) {
      if (char === quote) {
        if ((quote === '\'' || quote === '"') && value[index + 1] === quote) index += 1
        else quote = ''
      }
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '[') {
      quote = ']'
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')' && depth > 0) depth -= 1
    else if (char === delimiter && depth === 0) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

function findClosingParen(value: string, openAt: number): number {
  let depth = 0
  let quote = ''
  for (let index = openAt; index < value.length; index += 1) {
    const char = value[index] ?? ''
    if (quote) {
      if (char === quote) {
        if ((quote === '\'' || quote === '"') && value[index + 1] === quote) index += 1
        else quote = ''
      }
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '[') {
      quote = ']'
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}
