---
title: ERD Designer File Tool
description: How to create database designs, draw DB structures, model tables and relationships, and produce native ERD designer files
keywords:
  - database design
  - database schema
  - DB design
  - DB structure
  - draw database
  - table relationships
  - data model
  - ERD designer
---

# ERD Designer File Tool

An ERD is a workspace file ending in `*.erd.json`, not a Markdown note. It appears in the file tree like a regular file and opens in Twill's built-in ERD Designer. There is no required `database/` folder; save it in any regular folder the user requests.

## When to use this tool

When the user asks to design a database, draw a DB structure, create an ER diagram, model tables and relationships, or turn DDL into a diagram, create or update a native `.erd.json` file. Do not substitute a Markdown-only explanation or a Figma diagram for the editable ERD artifact.

## Workflow

1. Use the requested destination folder. If none is given, inspect the relevant project folder first; save at the workspace root only when there is no reasonable project folder.
2. If the request changes an existing design, read its `.erd.json` first and preserve unrelated tables and relationships.
3. Write and validate the file using the schema below. The file must remain in the workspace and its name must end in `.erd.json`.
4. In the final response, report the created or updated path and briefly list the tables so the user can open and review it in the ERD Designer.

## File schema

```json
{
  "version": 1,
  "meta": {
    "title": "Order Service ERD",
    "dialect": "postgres",
    "updated": 1760000000
  },
  "tables": [
    {
      "id": "t_users",
      "name": "users",
      "x": 80,
      "y": 80,
      "width": 600,
      "color": "#3b82f6",
      "columns": [
        {
          "id": "c_users_id",
          "name": "id",
          "type": "BIGINT",
          "isPK": true,
          "isFK": false,
          "nullable": false,
          "unique": false
        }
      ]
    }
  ],
  "relations": []
}
```

`meta.dialect` must be one of `postgres`, `mysql`, `sqlite`, or `generic`. Every table, column, and relationship ID must be unique within the file. Space tables about 300 px apart so they do not overlap. A typical table width is `600`; rotate colors such as `#3b82f6`, `#10b981`, `#8b5cf6`, and `#f59e0b`.

Put table descriptions in `table.note` and user-visible column comments in `column.note`. Store SQL defaults in `column.defaultVal`. Preserve domain terms and explanations supplied by the user in these notes instead of dropping them.

## Relationships

Represent each relationship from the parent (the one side) to the child (the many side). If `orders.user_id` references `users.id`, `users` is `from` and `orders` is `to`:

```json
{
  "id": "r_users_orders",
  "fromTable": "t_users",
  "fromColumn": "c_users_id",
  "toTable": "t_orders",
  "toColumn": "c_orders_user_id",
  "cardinality": "1:N",
  "optional": false
}
```

Mark a child foreign-key column with `isFK: true`. Set `optional` to `true` only when the child foreign key is nullable. For a composite key, create one relationship for each corresponding column pair.

## DDL import and export

The ERD Designer's **Import DDL** action converts `CREATE TABLE` statements, including tables, primary keys, unique constraints, defaults, and foreign keys. It also supports standard `COMMENT ON` and MySQL `COMMENT` syntax. **Export DDL** copies the diagram as SQL or saves it as a `.sql` file, including `table.note` and `column.note` as SQL comments where supported.

When the user provides DDL, create the corresponding `.erd.json` when practical so they can continue reviewing and editing it in Twill's ERD Designer.
