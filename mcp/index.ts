#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { writeFile, unlink } from "node:fs/promises"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DOCS_ROOT = process.env.WEBPULL_DOCS_DIR ?? join(homedir(), ".webpull-docs")

// ---------------------------------------------------------------------------
// MCP protocol types (hand-rolled, no SDK)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
	jsonrpc: "2.0"
	id?: number | string | null
	method: string
	params?: unknown
}

interface JsonRpcResponse {
	jsonrpc: "2.0"
	id: number | string | null
	result?: unknown
	error?: { code: number; message: string; data?: unknown }
}

interface Tool {
	name: string
	description: string
	inputSchema: {
		type: "object"
		properties: Record<string, unknown>
		required?: string[]
	}
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
	{
		name: "pull_docs",
		description:
			"Crawl a documentation URL using the webpull engine and save the output as markdown files. Inherits webpull's crawl intelligence: sitemap parsing, nav extraction, SPA detection, and headless Chromium fallback.",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "Root URL to crawl" },
				max_pages: {
					type: "number",
					description: "Maximum pages to crawl before stopping (default: 200)",
				},
				out_dir: {
					type: "string",
					description: "Subdirectory name under DOCS_ROOT (default: hostname from URL)",
				},
			},
			required: ["url"],
		},
	},
	{
		name: "search_docs",
		description:
			"Full-text search across locally pulled documentation. Scores files by term frequency and returns ranked results with snippets. No external index required.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Space-separated search terms" },
				site: {
					type: "string",
					description: "Hostname to scope the search to (e.g. docs.anthropic.com). Omit to search all sites.",
				},
				max_results: {
					type: "number",
					description: "Number of results to return (default: 10)",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "read_doc",
		description:
			"Read the full content of a specific markdown file. Intended to be called after search_docs identifies a relevant file. Content is capped at 50,000 characters.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Relative path from DOCS_ROOT (e.g. docs.anthropic.com/api/messages.md) or absolute path",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "list_docs",
		description:
			"List all pulled documentation sites, or list all files within a specific site. Shows file counts per site when no site is specified.",
		inputSchema: {
			type: "object",
			properties: {
				site: {
					type: "string",
					description: "Hostname to list individual files for (e.g. docs.anthropic.com). Omit to list all sites.",
				},
			},
		},
	},
	{
		name: "run_code",
		description:
			"Execute a code snippet in a sandboxed subprocess. Supports JavaScript/TypeScript (via Bun), Python, and Bash. Captures stdout and stderr separately. Security note: inherits user's full shell environment — for local developer use only.",
		inputSchema: {
			type: "object",
			properties: {
				language: {
					type: "string",
					enum: ["javascript", "typescript", "python", "bash"],
					description: "Language of the code snippet",
				},
				code: { type: "string", description: "Source code to execute" },
				timeout_ms: {
					type: "number",
					description: "Execution timeout in milliseconds (default: 30000, max: 60000)",
				},
			},
			required: ["language", "code"],
		},
	},
]

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function pullDocs(args: {
	url: string
	max_pages?: number
	out_dir?: string
}): Promise<string> {
	let rawUrl = args.url
	if (!/^https?:\/\//i.test(rawUrl)) rawUrl = `https://${rawUrl}`

	let hostname: string
	try {
		hostname = new URL(rawUrl).hostname
	} catch {
		return `Error: Invalid URL: ${args.url}`
	}

	const outDir = join(DOCS_ROOT, args.out_dir ?? hostname)
	const maxPages = args.max_pages ?? 200
	const timeout = 5 * 60 * 1000 // 5 minutes

	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		let timedOut = false

		const child = spawn("bunx", ["webpull", rawUrl, "--out", outDir, "--max", String(maxPages)], {
			shell: false,
			timeout,
		})

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})

		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, timeout)

		child.on("close", (code) => {
			clearTimeout(timer)
			if (timedOut) {
				resolve(`Timeout after 5 minutes. Partial output saved to: ${outDir}\n${stderr}`)
				return
			}
			if (code !== 0) {
				if (stderr.includes("command not found") || stderr.includes("not found")) {
					resolve("Error: webpull is not installed. Run: bun install -g webpull")
				} else {
					resolve(`Error (exit ${code}):\n${stderr || stdout}`)
				}
				return
			}
			// Count pages written
			let pageCount = 0
			try {
				pageCount = countMdFiles(outDir)
			} catch {}
			resolve(`Done. ${pageCount} pages saved to: ${outDir}\n${stderr}`.trim())
		})

		child.on("error", (err) => {
			clearTimeout(timer)
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				resolve("Error: webpull is not installed. Run: bun install -g webpull")
			} else {
				resolve(`Error spawning webpull: ${err.message}`)
			}
		})
	})
}

function countMdFiles(dir: string): number {
	if (!existsSync(dir)) return 0
	let count = 0
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			if (entry.isDirectory()) walk(join(d, entry.name))
			else if (entry.name.endsWith(".md")) count++
		}
	}
	walk(dir)
	return count
}

function searchDocs(args: {
	query: string
	site?: string
	max_results?: number
}): string {
	const terms = args.query
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 0)
	if (!terms.length) return "Error: query must contain at least one term"

	const searchRoot = args.site ? join(DOCS_ROOT, args.site) : DOCS_ROOT
	if (!existsSync(searchRoot)) {
		return args.site
			? `No docs found for site "${args.site}". Pull them first with pull_docs.`
			: `No docs found. Pull docs first with pull_docs. Docs root: ${DOCS_ROOT}`
	}

	const maxResults = args.max_results ?? 10

	interface Hit {
		relPath: string
		score: number
		snippet: string
	}

	const hits: Hit[] = []

	const walk = (dir: string) => {
		let entries: ReturnType<typeof readdirSync>
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const full = join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(full)
			} else if (entry.name.endsWith(".md")) {
				let content: string
				try {
					content = readFileSync(full, "utf-8")
				} catch {
					continue
				}
				const lower = content.toLowerCase()
				let score = 0
				let firstIdx = -1
				for (const term of terms) {
					let idx = 0
					while (true) {
						const found = lower.indexOf(term, idx)
						if (found === -1) break
						score++
						if (firstIdx === -1) firstIdx = found
						idx = found + 1
					}
				}
				if (score === 0) continue

				// Build ~280-char snippet centered on first match
				const snippetStart = Math.max(0, firstIdx - 100)
				const snippetEnd = Math.min(content.length, firstIdx + 180)
				let snippet = content.slice(snippetStart, snippetEnd).replace(/\n+/g, " ").trim()
				if (snippetStart > 0) snippet = `…${snippet}`
				if (snippetEnd < content.length) snippet = `${snippet}…`

				const relPath = full.slice(DOCS_ROOT.length).replace(/\\/g, "/").replace(/^\//, "")
				hits.push({ relPath, score, snippet })
			}
		}
	}

	walk(searchRoot)

	if (!hits.length) {
		return `No results found for: "${args.query}"${args.site ? ` in ${args.site}` : ""}`
	}

	hits.sort((a, b) => b.score - a.score)
	const top = hits.slice(0, maxResults)

	return top
		.map((h, i) => `[${i + 1}] ${h.relPath} (score: ${h.score})\n  ${h.snippet}`)
		.join("\n\n")
}

function readDoc(args: { path: string }): string {
	const MAX_CHARS = 50_000

	let filePath: string
	if (args.path.match(/^[A-Za-z]:[/\\]/) || args.path.startsWith("/")) {
		filePath = args.path
	} else {
		filePath = join(DOCS_ROOT, args.path)
	}
	filePath = resolve(filePath)

	if (!existsSync(filePath)) {
		return `File not found: ${filePath}`
	}

	let content: string
	try {
		content = readFileSync(filePath, "utf-8")
	} catch (err) {
		return `Error reading file: ${(err as Error).message}`
	}

	if (content.length > MAX_CHARS) {
		return content.slice(0, MAX_CHARS) + `\n\n[truncated at ${MAX_CHARS} characters]`
	}
	return content
}

function listDocs(args: { site?: string }): string {
	if (!existsSync(DOCS_ROOT)) {
		return `No docs pulled yet. Docs root: ${DOCS_ROOT}\nUse pull_docs to pull a site.`
	}

	if (args.site) {
		const siteDir = join(DOCS_ROOT, args.site)
		if (!existsSync(siteDir)) {
			return `No docs found for "${args.site}". Pull them first with pull_docs.`
		}
		const files: string[] = []
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name)
				if (entry.isDirectory()) walk(full)
				else if (entry.name.endsWith(".md")) {
					files.push(full.slice(join(DOCS_ROOT, args.site!).length).replace(/\\/g, "/").replace(/^\//, ""))
				}
			}
		}
		walk(siteDir)
		if (!files.length) return `No markdown files found in ${args.site}`
		return `Files in ${args.site} (${files.length} total):\n${files.join("\n")}`
	}

	// List all top-level site directories
	let entries: ReturnType<typeof readdirSync>
	try {
		entries = readdirSync(DOCS_ROOT, { withFileTypes: true })
	} catch {
		return `Error reading docs root: ${DOCS_ROOT}`
	}

	const sites = entries
		.filter((e) => e.isDirectory())
		.map((e) => {
			const count = countMdFiles(join(DOCS_ROOT, e.name))
			return { name: e.name, count }
		})
		.sort((a, b) => a.name.localeCompare(b.name))

	if (!sites.length) {
		return `No doc sites pulled yet. Docs root: ${DOCS_ROOT}\nUse pull_docs to pull a site.`
	}

	const lines = sites.map((s) => `  ${s.name.padEnd(40)} (${s.count.toLocaleString()} files)`)
	return `Pulled doc sites:\n${lines.join("\n")}\n\nDocs root: ${DOCS_ROOT}`
}

async function runCode(args: {
	language: "javascript" | "typescript" | "python" | "bash"
	code: string
	timeout_ms?: number
}): Promise<string> {
	const MAX_STDOUT = 20_000
	const MAX_STDERR = 5_000
	const timeoutMs = Math.min(args.timeout_ms ?? 30_000, 60_000)

	const ext = { javascript: "js", typescript: "ts", python: "py", bash: "sh" }[args.language]
	const id = createHash("sha256").update(args.code + Date.now()).digest("hex").slice(0, 16)
	const tmpFile = join(tmpdir(), `webpull-mcp-${id}.${ext}`)

	try {
		await writeFile(tmpFile, args.code, "utf-8")
	} catch (err) {
		return `Error creating temp file: ${(err as Error).message}`
	}

	const cmd = args.language === "python" ? ["python3", tmpFile] : args.language === "bash" ? ["bash", tmpFile] : ["bun", "run", tmpFile]

	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		let timedOut = false

		const child = spawn(cmd[0]!, cmd.slice(1), { shell: false })

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})

		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, timeoutMs)

		child.on("close", async (code) => {
			clearTimeout(timer)
			try {
				await unlink(tmpFile)
			} catch {}

			let out = stdout.slice(0, MAX_STDOUT)
			let err = stderr.slice(0, MAX_STDERR)
			if (stdout.length > MAX_STDOUT) out += "\n[stdout truncated]"
			if (stderr.length > MAX_STDERR) err += "\n[stderr truncated]"

			const parts = [`stdout:\n${out || "(empty)"}`, `---\nstderr:\n${err || "(empty)"}`, `---\nexit code: ${timedOut ? "SIGKILL (timeout)" : code}`]
			if (timedOut) parts.push(`[timed out after ${timeoutMs}ms]`)
			resolve(parts.join("\n"))
		})

		child.on("error", async (err) => {
			clearTimeout(timer)
			try {
				await unlink(tmpFile)
			} catch {}
			resolve(`Error spawning ${cmd[0]}: ${(err as Error).message}`)
		})
	})
}

// ---------------------------------------------------------------------------
// MCP dispatch
// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
	switch (name) {
		case "pull_docs":
			return pullDocs(args as Parameters<typeof pullDocs>[0])
		case "search_docs":
			return searchDocs(args as Parameters<typeof searchDocs>[0])
		case "read_doc":
			return readDoc(args as Parameters<typeof readDoc>[0])
		case "list_docs":
			return listDocs(args as Parameters<typeof listDocs>[0])
		case "run_code":
			return runCode(args as Parameters<typeof runCode>[0])
		default:
			return `Unknown tool: ${name}`
	}
}

// ---------------------------------------------------------------------------
// stdio JSON-RPC transport
// ---------------------------------------------------------------------------

function send(obj: JsonRpcResponse): void {
	process.stdout.write(JSON.stringify(obj) + "\n")
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
	const id = req.id ?? null

	if (req.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "webpull-mcp", version: "0.1.3" },
			},
		})
		return
	}

	if (req.method === "notifications/initialized") {
		// No response for notifications
		return
	}

	if (req.method === "tools/list") {
		send({ jsonrpc: "2.0", id, result: { tools: TOOLS } })
		return
	}

	if (req.method === "tools/call") {
		const params = req.params as { name?: string; arguments?: Record<string, unknown> }
		const toolName = params?.name
		const toolArgs = params?.arguments ?? {}

		if (!toolName) {
			send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name" } })
			return
		}

		const known = TOOLS.find((t) => t.name === toolName)
		if (!known) {
			send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${toolName}` } })
			return
		}

		try {
			const content = await callTool(toolName, toolArgs)
			send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: content }] } })
		} catch (err) {
			send({ jsonrpc: "2.0", id, error: { code: -32603, message: (err as Error).message } })
		}
		return
	}

	send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } })
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let buffer = ""

process.stdin.setEncoding("utf-8")
process.stdin.on("data", async (chunk: string) => {
	buffer += chunk
	const lines = buffer.split("\n")
	buffer = lines.pop() ?? ""
	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed) continue
		let req: JsonRpcRequest
		try {
			req = JSON.parse(trimmed)
		} catch {
			send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
			continue
		}
		await handleRequest(req)
	}
})

process.stdin.on("end", () => {
	process.exit(0)
})

process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
