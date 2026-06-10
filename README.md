# LockSpec

Your AI coding agent writes code that calls your API, but it guesses parts of the contract that it can't see and doesn't know about. It invents field names, calls paths that don't exist, and gets the types wrong. LockSpec is an MCP server that gives the agent the real contract from your OpenAPI spec. When the agent needs an endpoint signature or a type, it gets the exact shape your API accepts.

Most API context tools for agents cover public libraries. LockSpec is for any API that you have a spec for, regardless of whether it's private, internal, or a third party's.

v1 supports OpenAPI 3.0 and 3.1.

## Why

You might ask why the agent can't just read the spec from your repo. This works fine in many cases. But if you're working with a spec that the agent can't access (because it's not in the repo, or because it's too large to fit into context), the agent can't get accurate information about the contract it needs to fulfill. You might also want the agent pinned to a specific spec version you choose, not whatever is currently the latest version in the repo. LockSpec loads the spec you provide, indexes it, and serves answers from a pinned snapshot that you control. It returns only the slice that the agent asked for, so an agent can ground the code it writes in the actual contract rather than hallucinating it.

LockSpec can also help agents prevent API version skew. Suppose prod runs v1, a few services already moved to v2, and both are live. You want the agent to write against the right one the *first* time around. Writing against the wrong one breaks tests, or worse, ships a broken call. With LockSpec, you can load multiple versions of the same API spec at once. You control which one the agent uses. When more than one version of a spec is loaded, the tools that feed code-writing stop *before* writing code to ask which version should be used. The agent commits to a version on purpose instead of using the one that it saw most recently.

When the agent has a draft request, `validate_call` checks it against the pinned spec and reports any structural problems it finds. It's a check that catches structural mistakes in the draft before they fail tests and burn extra turns.

## Install

Requires Node 22 or newer. Your MCP client runs it through `npx`:

```bash
npx lockspec
```

### From source

```bash
git clone https://github.com/LockSpec/lockspec.git
cd lockspec
npm install
npm run build      # compiles TypeScript to dist/
node dist/index.js # starts the server over stdio
```

## Connect your agent

LockSpec runs locally over stdio. Point your MCP client at the `lockspec` command:

```jsonc
{
  "mcpServers": {
    "lockspec": { "command": "npx", "args": ["lockspec"] }
  }
}
```

- Claude Code: `claude mcp add lockspec -- npx lockspec`
- Gemini CLI: `gemini mcp add lockspec npx lockspec`
- Codex: `codex mcp add lockspec -- npx lockspec`
- Cursor: add the block above to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global).
- Cline / Windsurf: add the block above to the client's MCP settings (`cline_mcp_settings.json` for Cline).

To run from a source checkout instead of npm, point `command`/`args` at the built entrypoint:

```jsonc
{
  "mcpServers": {
    "lockspec": { "command": "node", "args": ["/absolute/path/to/lockspec/dist/index.js"] }
  }
}
```

## The tools

| Tool | What it does |
|---|---|
| `load_spec` | Ingest an OpenAPI file, URL, or text; normalize, index, and pin a version. |
| `find_endpoint` | Find operations by intent or by exact path/operationId. |
| `find_type` | Find named schemas and types. |
| `get_signature` | Exact request and response shape: params, required fields, types. |
| `validate_call` | Structurally validate a draft request against the spec and report what's wrong. |
| `list_specs` | What's loaded, and which version is active. |
| `activate_version` | Switch the active (pinned) version. |
| `remove_spec` | Remove a spec or a single version. |
| `diff_versions` | Structural diff of two versions, classified breaking or non-breaking. |

## How it works

`load_spec` fetches a spec once, normalizes it (bundles external `$ref`s, reconciles 3.0 and 3.1), hashes the result to use as the version's identity, and stores it under `~/.lockspec/`. After that everything is pinned and offline. Your specs never leave your machine.

Multiple specs, and multiple versions of one spec, coexist and are queried independently. Each spec has one active version, used when you don't name one. When more than one version is loaded, `get_signature` and `validate_call` won't guess. They return an error asking you to pin a `version`. `find_endpoint` and `find_type` use the active version and tell you which one they used.

## Examples

### Discovering an operation

`find_endpoint` scores and ranks operations by intent, returning the match or matches the agent will work with.

```js
find_endpoint({ query: "create" })
```

<!-- demo:find_endpoint -->
```json
{
  "ok": true,
  "spec_id": "petstore",
  "version_id": "sv_f403f8b0c4465bd7db52a4cd",
  "results": [
    {
      "operation_key": "POST:/pets",
      "operation_id": "createPet",
      "summary": "Create a pet"
    }
  ],
  "truncated": false
}
```

### Reading the operation's request shape

`get_signature` returns the exact request body schema: required fields, types, and allowed values.

```js
get_signature({ operation_id: "createPet" })
```

<!-- demo:get_signature -->
```json
{
  "ok": true,
  "spec_id": "petstore",
  "version_id": "sv_f403f8b0c4465bd7db52a4cd",
  "operation_key": "POST:/pets",
  "method": "POST",
  "path": "/pets",
  "operation_id": "createPet",
  "summary": "Create a pet",
  "deprecated": false,
  "parameters": [],
  "responses": {
    "201": {
      "description": "Created",
      "content": {
        "application/json": {
          "schema": "…"
        }
      }
    }
  },
  "truncated_paths": [],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "type": "object",
          "required": ["id", "name"],
          "examples": [
            {
              "id": 1,
              "name": "Rex",
              "status": "available"
            }
          ],
          "properties": {
            "id": {
              "type": "integer"
            },
            "name": {
              "type": "string"
            },
            "tag": {
              "type": ["string", "null"]
            },
            "weight": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "status": {
              "type": "string",
              "enum": ["available", "pending", "sold"]
            }
          }
        }
      }
    }
  }
}
```

### Confirming a correct draft

A structurally valid draft body returns `valid: true` with no errors.

```js
validate_call({ operation_id: "createPet", request: { body: { id: 1, name: "Rex" } } })
```

<!-- demo:validate_call_pass -->
```json
{
  "ok": true,
  "valid": true,
  "spec_id": "petstore",
  "version_id": "sv_f403f8b0c4465bd7db52a4cd",
  "operation_key": "POST:/pets",
  "errors": [],
  "warnings": []
}
```

### Validating a draft request

`validate_call` collects all structural violations in one pass. Missing required fields, type mismatches, enum failures:

```js
validate_call({ operation_id: "createPet", request: { body: { id: "1", status: "unknown" } } })
```

<!-- demo:validate_call -->
```json
{
  "ok": true,
  "valid": false,
  "spec_id": "petstore",
  "version_id": "sv_f403f8b0c4465bd7db52a4cd",
  "operation_key": "POST:/pets",
  "errors": [
    {
      "location": "body",
      "pointer": "/id",
      "code": "type",
      "message": "Expected integer, got string.",
      "expected": "integer",
      "actual": "string"
    },
    {
      "location": "body",
      "pointer": "/name",
      "code": "required",
      "message": "Missing required property 'name'."
    },
    {
      "location": "body",
      "pointer": "/status",
      "code": "enum",
      "message": "Value is not one of the allowed values [available, pending, sold].",
      "expected": ["available", "pending", "sold"],
      "actual": "unknown"
    }
  ],
  "warnings": []
}
```

### Multiple versions loaded

When two versions of the same spec are loaded, `get_signature` and `validate_call` refuse to guess which one you mean:

```js
get_signature({ operation_id: "createInvoice" })
```

<!-- demo:ambiguous -->
```json
{
  "ok": false,
  "error": {
    "code": "ambiguous",
    "message": "Spec \"billing-api\" has 2 loaded versions (1.0.0, 2.0.0) — pass version (version_id or version_label) to choose one.",
    "details": {
      "loaded_versions": [
        {
          "version_id": "sv_a5a2fdfa11e7038e6eb6b4b1",
          "version_label": "1.0.0",
          "active": false
        },
        {
          "version_id": "sv_bcfbfdc5783f3292208c9dc7",
          "version_label": "2.0.0",
          "active": true
        }
      ]
    }
  }
}
```

## License

[Apache-2.0](LICENSE).
