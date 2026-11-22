# SAM generation and recovery

SAM's original GLM-5.3 reliability fix used Low reasoning and a fixed 6,000-token output request per model step. In the original incident, Ollama returned `length` after a reasoning-only step, even though the OpenSEO tools had succeeded. The current configuration plans each model step separately and uses the SDK's normalized finish reason to decide whether the stream can complete.

## Provider parameters and limits

The installed AI SDK exposes `maxOutputTokens` on the model call and lets middleware adjust it per step. OpenSEO's OpenAI-compatible adapter maps it to `max_tokens`. Its Ollama Cloud configuration also requests `stream_options.include_usage`. Ollama documents `reasoning_effort`, `tool_choice`, and `max_tokens` for the compatibility endpoint. Ollama's GLM-5.3 listing documents Low, High, Max, and a 1M context window. The listing does not publish a separate output ceiling for that endpoint. Z.ai's benchmark budgets describe its own evaluations. [Ollama API](https://docs.ollama.com/api/openai-compatibility) · [GLM-5.3 model profile](https://ollama.com/library/glm-5.3) · [Z.ai model card](https://huggingface.co/zai-org/GLM-5.3)

GLM-5.3 uses the same completion allowance for reasoning and visible text. The trace reports provider-supplied input and output totals and shows reasoning usage only when Ollama supplies the reasoning breakdown. The OpenAI-compatible adapter maps `stop`, `length`, `tool_calls`, and `content_filter` to the SDK's normalized reasons. The end-of-stream guard requires a user-facing answer for a normal stop or a genuine pending tool approval for an approval pause.

| Task                          | Analysis effort on GLM-5.3 | Per-step target |
| ----------------------------- | -------------------------- | --------------: |
| Lookup or summary             | Low                        |           4,096 |
| Standard or ambiguous request | Low                        |           8,192 |
| Comprehensive SEO analysis    | High                       |          16,384 |
| Exceptional investigation     | Max                        |          32,768 |

The defaults cap GLM-5.3 requests at 16,384. The opt-in ceiling is 32,768. A text-only synthesis or recovery uses Low and targets 4,096 for lookup or 8,192 for larger tasks. SAM applies the model-specific ceiling, remaining turn allowance, and a conservative context-size check with room for the provider template. An unverified model uses the existing 6,000-token ceiling and its native reasoning defaults.

## Execution behavior

The task policy weighs requested sources, deliverables, task structure, and analysis intent. It uses no classification model call. SAM can synthesize immediately after a lookup or a broad keyword report with usable Rank Tracker and Search Console results. Requests with explicit breakdowns can gather additional evidence. A final model step stays available at the agent's execution limits.

SAM can rerun an empty, reasoning-only `length` attempt as a text-only generation. The prompt carries completed tool evidence as untrusted data. No recovery path executes tools. A partial Markdown response stays in history and is marked incomplete rather than being spliced with a fresh answer. A budget-specific HTTP 400 or 422 can trigger the 6,000-token fallback for the rest of the turn. Both recovery paths draw from the same bounded attempt pool. The user can stop an active response and continue later in the same conversation.

Search Console and Rank Tracker results are cached per turn by normalized input. Object-key order does not affect cache identity. Filter values, array order, dimensions, dates, and pagination remain part of the key.

## Local configuration

| Setting                            |                                   Default |
| ---------------------------------- | ----------------------------------------: |
| `AI_AGENT_MAX_STEPS`               | 48, including the reserved synthesis step |
| `AI_AGENT_MAX_TOOL_CALLS`          |                                        24 |
| `AI_AGENT_MAX_RECOVERY_ATTEMPTS`   |                    1, permitted range 0–2 |
| `AI_AGENT_MAX_TURN_INPUT_TOKENS`   |                                   524,288 |
| `AI_AGENT_MAX_TURN_OUTPUT_TOKENS`  |                                    65,536 |
| `AI_AGENT_MAX_TURN_MS`             |                                   240,000 |
| `AI_AGENT_GLM53_MAX_OUTPUT_TOKENS` |                 16,384, bounded at 32,768 |

Token budgets are admission controls. SAM estimates input from the serialized payload before a call and reconciles estimates with reported usage after completion. For missing output usage, it retains the requested allowance against the turn budget. Provider-specific tokenization and downstream tools can have independent limits. The SDK deadline aborts the model stream. An already-started data provider request remains subject to its own cancellation and timeout support.

Generation diagnostics are ephemeral, scoped to the conversation, and contain only settings, known usage, counts, and outcomes. No raw provider payload, prompt, or reasoning content is included.
