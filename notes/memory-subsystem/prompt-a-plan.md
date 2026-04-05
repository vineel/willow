I have three documents in which I have been designing the memory subsytem for willow.

# third priority
~/aidev/willow/notes/second-architecture-doc.md

# second priority
~/aidev/willow-experiments/memory/final-model-evaluation-report.md

# top priority
/Users/vineel/Library/CloudStorage/Dropbox/VineelerNotes/inbox/accordli/willow/2026-04-05-memory-server-review.md

Can you combine them into one design document for Willow's Memory Subsytem, and save it here?

We must achieve clarity. Ask me questions.
-------------------
1. Local LLM for fact extraction

  Doc 3 (architecture) says qwen3:8b throughout. Doc 2 (eval report) concluded ministral-3:8b is the winner. Should the combined doc reflect
  ministral-3:8b as the chosen model for fact extraction, replacing all qwen3:8b references in the memory context?
  
  Vineel: Yes, ministral-3:8b via LMStudio is the winner for all LLM tasks except embeddings.

2. Memory server as a separate service

  Doc 1 describes a standalone memory server (Hono + chokidar + Graphile Worker) — a separate Bun process from the bridge. Doc 3 has memory as
  tables accessed via MCP servers attached to the bridge. Is the memory server a new, separate service from the bridge? If so, how do they interact
   — does the bridge call the memory server's HTTP API, or do both just share the same Postgres?

   Vineel: Let's defer this. We are not designing the bridge today, so we'll decide later if the bridge is part of the same bun service or separate. Honestly, I think the question is just semantics -- does the bridge handle memory? or is there one server that handles both bridge and memory? I'm more comfortable thinking of it in the second way. But ask me more if it matters.

  3. Job queue technology

    Doc 3 uses pg-boss for agent scheduling. Doc 1 uses Graphile Worker for ingest jobs. Are these both staying (pg-boss for agents, Graphile Worker
    for memory), or should one replace the other?

    Vineel: Graphile Worker wins, pg-boss should be changed.

  4. Fact schema: simple vs. full factoid model

  Doc 1's schema is simple (fact_id, source_note_id, content, embedding, memory_type, is_active). Doc 3 has the full factoid/clustering model
  (root_id, root_type, qe_text, expiry_weight, etc.). Which is the target schema? Is Doc 1's schema a "phase 2 minimal" version and Doc 3's the end
   state? Or has the design simplified?

   Vineel: The more Doc 3 complex schema is correct. The Doc 2 extraction experiment was a rough-draft, we have to get it into shape to add to the Doc 3 format. Some of this may be in the prompt for the LLM, other parts might be in the harness around it. Doc 1 was written without my notes at hand -- it's more architecturally relevant.

  5. STM/LTM mechanism

    Doc 1 proposes two options: a memory_type enum column or a promoted_at nullable timestamp. Doc 3 describes STM/LTM conceptually but doesn't pick
    an implementation. Which approach?

    Vineel: memory_type enum

  6. Keyword extraction vs. qe_text vs. tsvector

    Doc 3 has qe_text (LLM-generated query expansion text, reprocessed over time). Doc 1 suggests Postgres tsvector could replace the keyword
    extraction LLM call. Are these addressing the same need, or is tsvector for basic search and qe_text is a separate enrichment that stays?

    Vineel: For v1, will run every query through ministral for keywords, and embedding model for embeddings. After everything is up and running (and has lots of information) we will experiment with no model, quicker or smaller model, etc.

  7. initial_facts — what seeds a conversation?

    Doc 1 flags this as undefined. What facts should be loaded at the start of every conversation? Most recent N? Long-term only? Core identity
    facts? This shapes the user experience significantly.
    
    Vineel: I suspect this will need a lot of iteration. Essential facts about Vineel's life, plus the 10 most recent facts that are important. Just try a prompt to start, I'll work on it over time.

  8. Scope of this document

    Should the combined doc cover only the memory subsystem (schema, server, pipeline, models, retrieval)? Or should it also include the
    bridge/agent/channel architecture from Doc 3 that surrounds memory?
    
    Vineel: Just the memory subsystem. I want to build it, and set it populating. This will take a long time given my local model, so I want to get that going. I will build out other components after it is up and running.

    