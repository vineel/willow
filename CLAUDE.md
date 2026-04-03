# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Willow is a personal AI agent system with two core purposes: a **Second Brain** (memory graph of people, events, facts, relationships) and an **Agent Runner** (scheduled/on-demand TypeScript agent scripts). It runs on a Mac Mini behind Tailscale VPN.

The project is currently in the **pre-code/design phase**. Architecture documents and experiment notes are in `notes/`. No source code has been written yet.

## Architecture Summary

**Two LLM paths, one subscription:**
- **qwen3:8b** (local Ollama) — mechanical work: fact extraction, tagging, keyword assignment
- **Claude Sonnet** (via Claude Code Max subscription) — reasoning: entity resolution, code generation, judgment calls. Accessed exclusively through Claude Code (never direct API) to stay within Max subscription terms

**Key components (all TypeScript/Bun except where noted):**
- **Bridge Server** (Fastify) — single HTTP entry point on Mac Mini, routes interactive requests through Claude Code channels and agent reasoning through `claude -p` subprocesses
- **Custom Channel Plugin** (MCP stdio) — connects bridge to long-running Claude Code sessions in tmux for interactive use
- **Agent SDK** (`sdk/`) — TypeScript library that generated agent scripts import; routes `llm.ask("sonnet")` through bridge→`claude -p`, routes `llm.ask("qwen")` directly to Ollama
- **Memory Store** — PostgreSQL + pgvector; facts cluster under factoids (typed root entities) via `root_id`; relationships are first-class table, not attributes
- **Fact Pipeline** — two-stage: Extractor (qwen3:8b, stateless) → Processor (qwen+sonnet, clusters/verifies/enriches)
- **Agent Runner** — pg-boss scheduler, executes generated `.ts` scripts with scoped memory access
- **Browser Automation** — Node.js/Playwright subprocess (Bun-incompatible), exposed via local HTTP to SDK

**Node.js is used only for Playwright.** Everything else is Bun.

## Critical Channel Gotchas

These were discovered experimentally and are easy to hit:
- Use `--dangerously-load-development-channels server:<name>`, NOT `--channels` (which only accepts published plugins)
- Always use `bun run --silent` for MCP servers — Bun stdout corrupts MCP stdio
- Never embed behavioral instructions in channel notification content — triggers prompt injection detection. Use the MCP Server constructor's `instructions` field instead
- `/clear` breaks the reply tool (lazy-loaded via ToolSearch); use the session reset protocol: `/clear` → warm-up prompt → wait ~10s for tool re-discovery

## Design Documents

- `notes/first-architecture-doc.md` — v2.0 original design
- `notes/second-architecture-doc.md` — v2.1 updated with experiment findings (this is the current/authoritative version)
- `notes/experiment-claude-p-mcp-tools.md` — test plan for `claude -p` with MCP tool calls
- `notes/experiment-concurrent-claude-p.md` — test plan for concurrent `claude -p` under Max subscription

## Build Phases

The project follows 7 phases, each producing daily-usable output:
1. **Prove the Architecture** — bridge + channel + session pool + `claude -p` wiring
2. **Memory Foundation** — Postgres/pgvector + fact schema + extractor + basic processor
3. **Bootstrap** — ingest markdown notes + emails into memory
4. **Agent Foundation** — SDK + scheduler + agent runner + New Agent Mode
5. **Full Fact Pipeline** — semantic clustering, verify_world/verify_human branches, expiry
6. **Browser Automation** — Playwright subprocess + portfolio tracker
7. **iPhone App** — Swift/SwiftUI client

## Tech Stack

- **Runtime:** Bun (Node.js only for Playwright)
- **Language:** TypeScript
- **HTTP Framework:** Fastify
- **Database:** PostgreSQL + pgvector
- **Local LLM:** Ollama (qwen3:8b)
- **Embeddings:** nomic-embed-text via Ollama
- **Scheduling:** pg-boss
- **Process Management:** tmux (headless Mac Mini)
- **Network:** Tailscale (WireGuard)
- **Secrets:** macOS Keychain
