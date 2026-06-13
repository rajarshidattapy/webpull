# webpull-mcp

MCP server that exposes [webpull](https://github.com/Dhravya/webpull) to any MCP-compatible coding agent (Claude Code, Cursor, Windsurf, etc.).

## Prerequisites

```bash
bun install -g webpull
```

## Register with Claude Code

```bash
claude mcp add webpull bun -- run /path/to/webpull/mcp/index.ts
```

Or via `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "webpull": {
      "command": "bun",
      "args": ["run", "/path/to/webpull/mcp/index.ts"]
    }
  }
}
```

## Register with Cursor / other MCP clients

```json
{
  "mcpServers": {
    "webpull": {
      "command": "bunx",
      "args": ["webpull-mcp"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `pull_docs` | Crawl any public docs site and save as local markdown |
| `search_docs` | Full-text search across locally pulled docs |
| `read_doc` | Read a specific markdown file (capped at 50k chars) |
| `list_docs` | List all pulled sites or files within a site |
| `run_code` | Execute JS/TS/Python/Bash snippets in a subprocess |

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `WEBPULL_DOCS_DIR` | `~/.webpull-docs` | Root directory for saved docs |
