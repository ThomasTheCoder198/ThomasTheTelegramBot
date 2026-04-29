import { Exa } from "exa-js";
import { z } from "zod";
import { config } from "../config.js";

export const toolName = "web_search";

export const toolDescription =
  "Search the public web for up-to-date information using Exa. " +
  "Use this when the user asks about current events, recent news, or any topic " +
  "that may have changed since the model was trained. Returns a list of results " +
  "with title, URL, and a relevant snippet.";

export const toolSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "The natural-language search query to send to the web search engine.",
    ),
  numResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Number of results to return (1-10). Defaults to 5."),
});

export type WebSearchInput = z.infer<typeof toolSchema>;

let exaClient: Exa | null = null;
function getExaClient(): Exa {
  if (exaClient === null) {
    exaClient = new Exa(config.exaApiKey);
  }
  return exaClient;
}

interface ExaResultLike {
  title?: string | null;
  url?: string;
  highlights?: string[];
  text?: string;
}

function formatResults(results: ExaResultLike[]): string {
  if (results.length === 0) {
    return "No results found.";
  }

  const lines: string[] = [];
  results.forEach((r, idx) => {
    const title = (r.title ?? "").trim() || "(no title)";
    const url = r.url ?? "";
    const highlight = (r.highlights?.[0] ?? "").trim();
    const snippet =
      highlight.length > 0
        ? highlight
        : (r.text ?? "").trim().slice(0, 280) || "(no snippet)";

    lines.push(`${idx + 1}. ${title}`);
    if (url) lines.push(`   ${url}`);
    lines.push(`   ${snippet}`);
  });

  return lines.join("\n");
}

export async function execute(input: WebSearchInput): Promise<string> {
  const numResults = input.numResults ?? 10;
  const query = input.query.trim();

  if (query.length === 0) {
    return "Web search error: query is empty.";
  }

  console.log(`[web_search] query="${query}" numResults=${numResults}`);
  try {
    const exa = getExaClient();
    const response = await exa.searchAndContents(query, {
      type: "auto",
      numResults,
      highlights: true,
    });
    const results = (response.results ?? []) as ExaResultLike[];
    console.log(`[web_search] got ${results.length} result(s)`);
    return formatResults(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[web_search] failed: ${message}`);
    return `Web search is currently unavailable. Reason: ${message}`;
  }
}
