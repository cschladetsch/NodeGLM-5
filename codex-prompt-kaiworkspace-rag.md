# Task: add RAG grounding to KaiWorkspace against the KAI codebase

## Context

KaiWorkspace is a local AI coding assistant running against a small quantized
model (qwen2.5-coder:7b class, Q4_K_M, ~6-7GB VRAM) via Ollama on an RTX 2070
(8GB VRAM). At this parameter count and quantization, the model reliably
confuses low-frequency C++ idioms with superficially similar high-frequency
ones — e.g. asked about CRTP (`template <class Derived> class Base`), it
answers with runtime virtual-function polymorphism instead, because that
pattern dominates its training distribution. This is a capacity problem, not
a prompting problem, and no amount of system-prompt engineering fixes it
reliably.

Fine-tuning is off the table (no labelled dataset, no interest in maintaining
custom weights). The fix is retrieval: ground every technical answer in an
actual correct example pulled from a curated corpus *before* the model
generates, so it's summarizing/adapting real source rather than free-recalling
from parametric memory.

The KAI codebase (github.com/[owner]/KAI and its submodules CppKaiCore,
CppKaiLanguage) is a large, correct, heavily-templated modern C++ codebase
already on disk. It's the natural first corpus: real CRTP, real SFINAE, real
template metaprogramming, all idiomatic and known-good.

## Objective

Add a retrieval-augmented generation layer to KaiWorkspace so that C++
questions get answered against real indexed source rather than raw model
recall. Success criterion: asking about CRTP returns an answer that actually
uses the `template <class Derived>` pattern, ideally citing or adapting a real
example from the indexed corpus, not a virtual-function tangent.

## Requirements

1. **Inspect the existing KaiWorkspace repo structure first.** Do not assume
   file layout, backend framework, or how the Ollama call is currently wired.
   Read the actual code before proposing changes. Report what you find before
   implementing.

2. **Indexing pipeline**
   - Chunk source files from the KAI codebase (start with CppKaiCore and
     CppKaiLanguage submodules) at a granularity that preserves whole
     template declarations/definitions and their surrounding doc comments —
     not fixed-line-count chunks that split a template mid-declaration.
   - Generate embeddings for each chunk using a local embedding model
     (e.g. nomic-embed-text or similar via Ollama, so it fits the existing
     local-only constraint — no cloud embedding APIs).
   - Store vectors in a lightweight local vector store appropriate for a
     single-user desktop tool — sqlite-vec or a flat-file/in-memory index is
     preferable to standing up a separate vector DB service. Justify the
     choice in a short comment or README note.
   - Make indexing incremental/re-runnable — re-indexing after a `git pull`
     on KAI should only re-embed changed files, not the whole corpus.

3. **Retrieval + generation flow**
   - On a query, retrieve top-k relevant chunks (k configurable, default
     reasonable for an 8GB card's context budget — leave room for the
     quantized model's context window minus retrieved content minus response).
   - Inject retrieved chunks into the prompt as clearly delimited reference
     material, with instructions to the model to ground its answer in the
     provided source and to say so explicitly if the retrieved context
     doesn't actually cover the question (avoid the model treating irrelevant
     retrieved chunks as if they answer the question).
   - Preserve the existing non-RAG path as a fallback/toggle — not every
     query needs corpus grounding (e.g. general chat, non-C++ questions), and
     forcing retrieval on everything adds latency for no benefit.

4. **Corpus scope for v1**
   - CppKaiCore and CppKaiLanguage only, not the full KAI monorepo history —
     keep the index tight and high-signal rather than broad.
   - Design the indexer so adding a second corpus later (e.g. cppreference
     template docs, or another of my ~170 public repos) is a config change,
     not a rewrite.

5. **Hardware constraints — do not violate these**
   - Everything must run locally on an RTX 2070, 8GB VRAM, alongside the
     existing qwen2.5-coder:7b Ollama instance. Embedding model + LLM must
     coexist in that budget — check whether they need to be loaded
     simultaneously or can be sequenced (embed at index time, offline;
     LLM only needed at query time).
   - No cloud API calls anywhere in the pipeline. Fully offline.

6. **Output**
   - A short design note (README or inline doc) explaining: corpus format
     chosen, chunking strategy, vector store choice, and how to re-index.
   - The actual implementation, integrated into KaiWorkspace's existing
     backend, not a standalone prototype script.
   - One worked example in the note: the CRTP query, showing retrieved
     chunk(s) and the resulting grounded answer, as a regression check for
     "did this actually fix the problem it was built to fix."

## Explicit non-goals

- No fine-tuning, no LoRA, no weight modification of any kind.
- No new hosted infrastructure — this stays a local single-user tool.
- No UI redesign — wire retrieval into the existing query path, don't build
  a new interface around it unless the existing one genuinely can't show
  retrieved-source attribution at all.

## Deliverable format

Work directly in the KaiWorkspace repo. Report back with: what you found on
inspection, the design decisions made and why, and the CRTP worked example
showing before/after behavior.
