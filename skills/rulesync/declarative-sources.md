# Declarative Sources

Rulesync can fetch features (skills, rules, commands, subagents, mcp, hooks, ignore) from external repositories using the `install` command. Instead of manually running `fetch` for each source, declare them in your `rulesync.jsonc` and run `rulesync install` to resolve and fetch them. Then `rulesync generate` picks them up alongside local definitions. Typical workflow: `rulesync install && rulesync generate`.

## Configuration

Add a `sources` array to your `rulesync.jsonc`:

```jsonc
{
  "$schema": "https://github.com/dyoshikawa/rulesync/releases/latest/download/config-schema.json",
  "targets": ["copilot", "claudecode"],
  "features": ["rules", "skills"],
  "sources": [
    // Fetch all features from a GitHub repository (default transport)
    { "source": "owner/repo" },

    // Fetch only specific feature types
    { "source": "owner/repo", "features": ["rules", "commands"] },

    // Fetch only specific skills by name
    { "source": "anthropics/skills", "skills": ["skill-creator"] },

    // With ref pinning and subdirectory path (same syntax as fetch command)
    { "source": "owner/repo@v1.0.0:path/to/rulesync" },

    // Git transport — works with any git remote (Azure DevOps, Bitbucket, etc.)
    {
      "source": "https://dev.azure.com/org/project/_git/repo",
      "transport": "git",
      "ref": "main",
      "path": "exports/rulesync",
    },

    // Git transport with a local repository
    { "source": "file:///path/to/local/repo", "transport": "git" },
  ],
}
```

Each entry in `sources` accepts:

| Property    | Type       | Description                                                                                                                                                                                                                                                                |
| ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`    | `string`   | Repository source. For GitHub transport: `owner/repo` or `owner/repo@ref:path`. For git transport: a full git URL.                                                                                                                                                         |
| `features`  | `string[]` | Optional list of feature types to fetch (`skills`, `rules`, `commands`, `subagents`, `mcp`, `hooks`, `ignore`, or `*`). Defaults to all (`["*"]`).                                                                                                                         |
| `skills`    | `string[]` | Optional list of skill names to fetch. If omitted, all skills are fetched.                                                                                                                                                                                                 |
| `transport` | `string`   | `"github"` (default) uses the GitHub REST API. `"git"` uses git CLI and works with any git remote.                                                                                                                                                                         |
| `ref`       | `string`   | Branch, tag, or ref to fetch from. Defaults to the remote's default branch. For GitHub transport, use the `@ref` source syntax.                                                                                                                                            |
| `path`      | `string`   | Base path within the repository where rulesync content lives. All feature directories (skills/, rules/, etc.) and feature files (mcp.json, etc.) are resolved relative to this path. Defaults to the repository root. For GitHub transport, use the `:path` source syntax. |

## How It Works

When `rulesync install` runs and `sources` is configured:

1. **Lockfile resolution** -- Each source's ref is resolved to a commit SHA and stored in `rulesync.lock` (at the project root). On subsequent runs the locked SHA is reused for deterministic builds.
2. **Feature fetching** -- For each source, the requested features are fetched from the remote repository. Directory features (skills, rules, commands, subagents) are fetched recursively. Single-file features (mcp.json, hooks.json, .aiignore) are fetched individually.
3. **Source cache** -- Fetched content is written to `.rulesync/.sources/<source-key>/`, preserving the rulesync directory structure. This cache is used by `rulesync generate`.
4. **Filtering** -- If `skills` is specified, only matching skill directories are fetched. If `features` is specified, only matching feature types are fetched.
5. **Precedence rules**:
   - **Local items always win** -- Items in `.rulesync/<feature>/` take precedence; a remote item with the same name is skipped.
   - **First-declared source wins** -- If two sources provide an item with the same name, the one declared first in the `sources` array is used.
   - **Single-file features merge** -- For mcp.json, hooks.json, and .aiignore, content is merged across sources. Local content is applied first, then sources in declaration order. Server entries, event keys, and ignore lines are merged with local values taking precedence.

## CLI Options

The `install` command accepts these flags:

| Flag              | Description                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--update`        | Force re-resolve all source refs, ignoring the lockfile (useful to pull new updates).                                                                         |
| `--frozen`        | Fail if lockfile is missing or out of sync. Fetches missing content using locked refs without updating the lockfile. Useful for CI to ensure reproducibility. |
| `--token <token>` | GitHub token for private repositories.                                                                                                                        |

```bash
# Install sources using locked refs
rulesync install

# Force update to latest refs
rulesync install --update

# Strict CI mode — fail if lockfile doesn't cover all sources
rulesync install --frozen

# Install then generate
rulesync install && rulesync generate

# Skip source installation — just don't run install
rulesync generate
```

## Lockfile

The lockfile at `rulesync.lock` (at the project root) records the resolved commit SHA and per-file integrity hashes for each source so that builds are reproducible. It is safe to commit this file. An example:

```json
{
  "lockfileVersion": 2,
  "sources": {
    "owner/repo": {
      "requestedRef": "main",
      "resolvedRef": "abc123def456...",
      "resolvedAt": "2025-01-15T12:00:00.000Z",
      "files": {
        "skills/my-skill/SKILL.md": { "integrity": "sha256-abcdef..." },
        "rules/coding-standards.md": { "integrity": "sha256-123456..." },
        "mcp.json": { "integrity": "sha256-789abc..." }
      }
    }
  }
}
```

To update locked refs, run `rulesync install --update`.

## Authentication

GitHub transport uses the `GITHUB_TOKEN` or `GH_TOKEN` environment variable for authentication. This is required for private repositories and recommended for better rate limits. Git transport relies on your local git credential configuration (SSH keys, credential helpers, etc.).

```bash
# Using environment variable
export GITHUB_TOKEN=ghp_xxxx
npx rulesync install

# Or using GitHub CLI
GITHUB_TOKEN=$(gh auth token) npx rulesync install
```

> [!TIP]
> The `install` command also accepts a `--token` flag for explicit authentication: `rulesync install --token ghp_xxxx`.

## Source Cache vs Local Content

| Location                                 | Type   | Precedence | Committed to Git |
| ---------------------------------------- | ------ | ---------- | ---------------- |
| `.rulesync/<feature>/`                   | Local  | Highest    | Yes              |
| `.rulesync/.sources/<source>/<feature>/` | Source | Lower      | No (gitignored)  |

When both a local and a source item share the same name, the local item is used and the remote one is skipped.
