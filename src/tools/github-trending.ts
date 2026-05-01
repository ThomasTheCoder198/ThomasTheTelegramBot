import { z } from "zod";

export const toolName = "github_trending";

export const toolDescription =
  "Fetch the current trending repositories on GitHub directly from github.com/trending. " +
  "Use this tool when the user asks about top/trending GitHub repos today, this week, or this month. " +
  "Returns repo names, descriptions, languages, and star counts.";

export const toolSchema = z.object({
  language: z
    .string()
    .optional()
    .describe(
      "Filter by programming language (e.g., 'javascript', 'python'). Omit for all languages.",
    ),
  since: z
    .enum(["daily", "weekly", "monthly"])
    .optional()
    .describe("Time range for trending. Defaults to 'daily'."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Number of repos to return. Defaults to 10."),
});

export type GitHubTrendingInput = z.infer<typeof toolSchema>;

interface RepoInfo {
  repo: string;
  description: string;
  language: string;
  stars: string;
  todayStars: string;
}

function parseRepos(html: string, limit: number): RepoInfo[] {
  const repos: RepoInfo[] = [];
  const articleRx = /<article[^>]*Box-row[^>]*>([\s\S]*?)<\/article>/g;
  let m: RegExpExecArray | null;

  while ((m = articleRx.exec(html)) !== null && repos.length < limit) {
    const block = m[1];

    const linkM = /<h2[^>]*>[\s\S]*?<a\s+href="(\/[^/"]+\/[^"?#]+)"/.exec(block);
    if (!linkM) continue;
    const repo = "https://github.com" + linkM[1].trim();

    const descM = /<p[^>]*col-9[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const description = descM
      ? descM[1].replace(/<[^>]+>/g, "").trim()
      : "";

    const langM = /itemprop="programmingLanguage"[^>]*>\s*([^<]+?)\s*</.exec(block);
    const language = langM ? langM[1].trim() : "";

    const starsM =
      /href="[^"]*\/stargazers"[^>]*>[\s\S]*?<\/svg>\s*([\d,]+)\s*<\/a>/.exec(block);
    const stars = starsM ? starsM[1].trim() : "";

    const todayM = /([\d,]+)\s+stars?\s+today/i.exec(block);
    const todayStars = todayM ? todayM[1].trim() : "";

    repos.push({ repo, description, language, stars, todayStars });
  }

  return repos;
}

function formatRepos(repos: RepoInfo[]): string {
  if (repos.length === 0) return "No trending repositories found.";

  return repos
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.repo}`];
      if (r.description) lines.push(`   ${r.description}`);
      const meta: string[] = [];
      if (r.language) meta.push(r.language);
      if (r.stars) meta.push(`⭐ ${r.stars}`);
      if (r.todayStars) meta.push(`+${r.todayStars} today`);
      if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export async function execute(input: GitHubTrendingInput): Promise<string> {
  const since = input.since ?? "daily";
  const lang = input.language
    ? encodeURIComponent(input.language.toLowerCase())
    : "";
  const limit = input.limit ?? 10;
  const url = `https://github.com/trending/${lang}?since=${since}`;

  console.log(`[github_trending] fetching ${url}`);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TelegramBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      return `Failed to fetch GitHub trending: HTTP ${response.status}`;
    }

    const html = await response.text();
    const repos = parseRepos(html, limit);

    if (repos.length === 0) {
      return "Could not parse trending repositories. GitHub may have updated their page structure.";
    }

    console.log(`[github_trending] parsed ${repos.length} repos`);
    return formatRepos(repos);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[github_trending] failed: ${msg}`);
    return `Failed to fetch GitHub trending: ${msg}`;
  }
}
