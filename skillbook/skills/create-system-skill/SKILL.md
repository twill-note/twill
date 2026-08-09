---
name: create-system-skill
description: Create or update an app-only skill in this project's Skill Book. Use when a user asks Twill AI to register a reusable workflow, domain guide, or tool-assisted procedure for Twill.
---

# Create System Skill

Create skills only under this project's `skillbook/skills` directory. Do not install
them into a user's global Codex skill directory.

## Workflow

1. Call `list_skillbook` before creating a skill to detect an existing or overlapping
   skill.
2. Turn the requested behavior into a lowercase hyphenated skill name and a concise
   trigger-oriented description.
3. Read [references/skill-structure.md](references/skill-structure.md) before deciding
   which optional directories are needed.
4. Initialize the skill with:

   ```bash
   python3 scripts/init_skill.py <skill-name> --description "<description>" [--resources scripts,references,assets]
   ```

5. Replace the generated `SKILL.md` TODO with direct, actionable instructions.
   Keep the main file small and move detailed reference material into `references/`.
6. Add only resources that are necessary for the workflow.
7. Validate the result with:

   ```bash
   python3 scripts/validate_skill.py <skill-name>
   ```

8. Report the created Skill Book ID as `skillbook:<skill-name>`.

## Rules

- `SKILL.md` frontmatter must contain exactly `name` and `description`.
- The frontmatter name must match its directory name.
- Do not duplicate a system manual. System manuals are read-only Skill Book entries.
- Do not overwrite an existing skill unless the user asked to update it.
- Keep reusable scripts deterministic and safe to run more than once where practical.
- After creating or updating files, always run validation and fix every reported error.
