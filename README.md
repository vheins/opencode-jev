# opencode-jev

An [opencode](https://opencode.ai) plugin that routes **TypeSafe Jev (System One)** structured judgments through opencode's built-in plugin hooks.

Jev is not a drop-in model replacement. It answers named questions about a piece of state and returns **typed** results (`choice`, `score`, `noul`) that the plugin branches on to make guardrail decisions: block a destructive tool call, arbitrate a permission prompt, triage a session error, and so on.

All Jev calls go through the existing **9router-spasi** provider, which exposes a pass-through route at `POST /v1/systemone`. The router forwards the body untouched and returns the native System One JSON.

## Install

Copy the `.opencode/` directory into your opencode project (or point opencode at this plugin):

```
your-project/
  .opencode/
    plugins/jev.ts
    package.json
    .env.example
```

opencode auto-discovers any `*.ts` file in `.opencode/plugins/`, so `jev.ts` loads automatically. Install the plugin's dependencies once:

```bash
cd .opencode && bun install   # or: npm install
```

Then restart opencode (config and plugins load at startup).

## Configuration

Copy `.opencode/.env.example` to `.env` (or export the variables in your shell). Every value is optional except the spasi key, which enables the guardrails.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPASI_API_KEY` | — | Bearer key for the 9router-spasi provider. If unset, the plugin falls back to the key file below, then no-ops with a warning. |
| `JEV_BASE_URL` | `https://model.spasi.biz.id/v1/systemone` | Router pass-through route for System One judgments. |
| `JEV_MODEL` | `oc/jev-1.13-free` | Jev model id (confirmed against this deployment). |
| `JEV_BLOCK_THRESHOLD` | `0.85` | Block a destructive tool call when confidence exceeds this value. |
| `JEV_ALLOW_THRESHOLD` | `0.7` | Auto-allow a read-only action at or above this confidence. |
| `JEV_ROUTE_THRESHOLD` | `0.8` | Toast when `chat.message` routes to `needs_human` at or above this confidence. |
| `JEV_SEVERITY_THRESHOLD` | `0.8` | Toast when a `session.error` severity resolves to `real_bug`/`fatal` at or above this confidence. |
| `JEV_COMPACT_THRESHOLD` | `0.75` | Append a preservation reminder to compaction context at or above this probability. |

Key resolution order: `SPASI_API_KEY` environment variable, then the file `/home/kali/.config/opencode/.spasi-key`. **Never commit a real key.** The repository ignores `.env`, `*.key`, and similar files.

## Hook / event map

| Hook or event | Jev question | Behavior |
| --- | --- | --- |
| `tool.execute.before` | Choice: `read_only` \| `mutating` \| `destructive` | Blocks (throws) when the verdict is `destructive` and confidence > `JEV_BLOCK_THRESHOLD`. |
| `permission.ask` | Choice: same risk labels | Sets `allow` for a confident `read_only`; sets `deny` for a confident `destructive`; otherwise leaves the prompt to the human. |
| `chat.message` | Choice: `code_only` \| `needs_model` \| `needs_human` | Cascade-routes each user message; logs the verdict; raises a TUI toast on a confident `needs_human`. Never alters the message flow. |
| `experimental.session.compacting` | Noul: "does this session hold unrecoverable decisions?" | Pushes a preservation reminder line into the summary context when the probability is high. Never replaces the compaction prompt. |
| `event` → `session.error` | Choice: `transient` \| `real_bug` \| `fatal` | Logs the severity; raises a toast on a confident non-transient verdict. |
| `event` → `file.edited` | Noul: "is this path security-sensitive / needs review?" | Logs a high verdict and raises a review toast. |
| `tool.jev_decide` (custom tool) | Choice / Score / Noul over arbitrary state | Exposes Jev directly to the agent; returns the typed answer as JSON. |

## Safety

The plugin is designed to **fail open** so it can never break opencode's flow:

- **No key / missing key** — every hook degrades to a no-op and logs a warning once. opencode startup never crashes.
- **Jev error or timeout** — each classifier catches the failure, logs a warning, and returns `undefined`; the affected hook then does nothing (the action proceeds under opencode's native approval flow).
- **10s fetch timeout** — every Jev request carries an `AbortSignal.timeout(10000)`, so a hung router degrades to the no-op path instead of stalling tool calls, messages, or events.
- **Verdict-shape validation** — before any allow/deny/block decision, the remote `choice`/`confidence` is validated (known label, finite number, `0 <= confidence <= 1`). A malformed answer is ignored rather than trusted.

## License

MIT. See [LICENSE](./LICENSE).
