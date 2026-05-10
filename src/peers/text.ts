export function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// v2.23.0: structured parse result so callers can distinguish three cases:
// (a) text was successfully extracted; (b) content array had blocks but no
// usable `text` blocks (e.g. Claude Opus extended-thinking response where
// the whole output budget went into `thinking` / `redacted_thinking` blocks
// without producing a final `text` block); (c) content array was empty.
// Pre-v2.23.0 the helper returned `string` and silently coalesced all three
// to `""`, which masked a real bug: the relator-revision path in the
// orchestrator (orchestrator.ts:2925) promoted the empty text to the
// next-round draft, dispatching peer calls against an empty `Draft Or
// Solution Under Review:` block. Sessão `8187f5a8` 2026-05-10 burned
// ~$0.21 USD on that failure mode before max-rounds was hit.
export interface AnthropicParseResult {
  text: string;
  parser_warning?: string;
}

const ANTHROPIC_THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

export function parseAnthropicContent(
  content: Array<{ type: string; text?: string }>,
): AnthropicParseResult {
  const textBlocks = content.filter(
    (block) => block.type === "text" && typeof block.text === "string",
  );
  const text = textBlocks
    .map((block) => block.text as string)
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text === "" && content.length > 0) {
    const hasThinking = content.some((block) => ANTHROPIC_THINKING_BLOCK_TYPES.has(block.type));
    return {
      text: "",
      parser_warning: hasThinking
        ? "anthropic_thinking_only_no_text_block"
        : "anthropic_empty_text_blocks",
    };
  }
  return { text };
}

// Thin backward-compatibility shim — discards the parser_warning. New code
// SHOULD call `parseAnthropicContent` directly so the warning can flow to
// `PeerResult.parser_warnings` / `GenerationResult.parser_warnings` and
// (for the relator-revision path) block promotion of an empty draft.
export function textFromAnthropicContent(content: Array<{ type: string; text?: string }>): string {
  return parseAnthropicContent(content).text;
}

export function textFromOpenAIResponse(response: {
  output_text?: string;
  output?: unknown;
}): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  return compactJson(response.output ?? response);
}

export function userPrompt(reviewPrompt: string): string {
  return reviewPrompt.trim();
}
