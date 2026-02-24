/**
 * Regression tests for Agent Readiness Scorer
 * Run: bun test
 * 
 * Live tests hit real sites and take 30-60s each.
 * HTML tests are instant.
 */
import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { scoreUrl } from "./scorer";

// Scoring requires crawling real sites — needs generous timeout
setDefaultTimeout(120_000);

// Cache results so we don't re-crawl the same site for every test
const cache = new Map<string, Awaited<ReturnType<typeof scoreUrl>>>();
async function score(url: string): Promise<Awaited<ReturnType<typeof scoreUrl>>> {
  if (!cache.has(url)) cache.set(url, await scoreUrl(url));
  return cache.get(url)!;
}

function getCategoryScore(result: Awaited<ReturnType<typeof scoreUrl>>, name: string) {
  return result.categories.find(c => c.name === name);
}

function getSubScore(result: Awaited<ReturnType<typeof scoreUrl>>, subName: string) {
  for (const cat of result.categories) {
    const sub = cat.subScores.find(s => s.name === subName);
    if (sub) return sub;
  }
  return undefined;
}

// ===== URL VALIDATION =====
describe("URL validation", () => {
  test("rejects invalid URL", async () => {
    await expect(score("not-a-url")).rejects.toThrow();
  });

  test("rejects bare word without TLD", async () => {
    await expect(score("stripe")).rejects.toThrow("doesn't look like a full URL");
  });

  test("handles URL with https://", async () => {
    const r = await score("https://stripe.com");
    expect(r.url).toContain("stripe.com");
  });

  test("handles URL without protocol", async () => {
    const r = await score("stripe.com");
    expect(r.url).toContain("stripe.com");
  });

  test("normalizes www prefix", async () => {
    const r = await score("www.stripe.com");
    expect(r.url).not.toContain("www.");
  });
});

// ===== SCORING STRUCTURE =====
describe("scoring structure", () => {
  test("returns all required fields", async () => {
    const r = await score("stripe.com");
    expect(r.id).toBeDefined();
    expect(r.url).toBeDefined();
    expect(r.timestamp).toBeDefined();
    expect(r.totalScore).toBeGreaterThanOrEqual(0);
    expect(r.maxScore).toBe(40);
    expect(r.grade).toMatch(/^[ABCDF]$/);
    expect(r.categories).toHaveLength(4);
    expect(r.crawledPages).toBeInstanceOf(Array);
    expect(r.errors).toBeInstanceOf(Array);
    expect(r.frictionSummary).toBeDefined();
  });

  test("has four categories with correct names", async () => {
    const r = await score("stripe.com");
    const names = r.categories.map(c => c.name);
    expect(names).toEqual(["DISCOVERY", "PURCHASE", "INTEGRATION", "TRUST"]);
  });

  test("each category maxPoints is 10", async () => {
    const r = await score("stripe.com");
    for (const cat of r.categories) {
      expect(cat.maxPoints).toBe(10);
    }
  });

  test("category score does not exceed maxPoints", async () => {
    const r = await score("stripe.com");
    for (const cat of r.categories) {
      expect(cat.score).toBeLessThanOrEqual(cat.maxPoints);
      expect(cat.score).toBeGreaterThanOrEqual(0);
    }
  });

  test("totalScore equals sum of category scores", async () => {
    const r = await score("stripe.com");
    const sum = r.categories.reduce((s, c) => s + c.score, 0);
    expect(r.totalScore).toBe(sum);
  });

  test("grade matches score thresholds", async () => {
    const r = await score("stripe.com");
    if (r.totalScore >= 35) expect(r.grade).toBe("A");
    else if (r.totalScore >= 28) expect(r.grade).toBe("B");
    else if (r.totalScore >= 20) expect(r.grade).toBe("C");
    else if (r.totalScore >= 10) expect(r.grade).toBe("D");
    else expect(r.grade).toBe("F");
  });
});

// ===== CRAWLING =====
describe("crawling", () => {
  test("crawls multiple pages for well-known sites", async () => {
    const r = await score("stripe.com");
    expect(r.crawledPages.length).toBeGreaterThan(1);
  });

  test("discovers subdomains", async () => {
    const r = await score("stripe.com");
    const hasSubdomain = r.crawledPages.some(p => {
      const hostname = new URL(p).hostname;
      return hostname !== "stripe.com" && hostname.endsWith("stripe.com");
    });
    expect(hasSubdomain).toBe(true);
  });

  test("discovers nested subdomains for coinbase", async () => {
    const r = await score("coinbase.com");
    const hasCdpDocs = r.crawledPages.some(p => p.includes("docs.cdp.coinbase.com"));
    const hasCloudDocs = r.crawledPages.some(p => p.includes("docs.cloud.coinbase.com"));
    expect(hasCdpDocs || hasCloudDocs).toBe(true);
  });

  test("crawls more than 1 page for coinbase", async () => {
    const r = await score("coinbase.com");
    expect(r.crawledPages.length).toBeGreaterThan(1);
  });

  test("respects MAX_CRAWL_PAGES limit", async () => {
    const r = await score("stripe.com");
    expect(r.crawledPages.length).toBeLessThanOrEqual(30);
  });
});

// ===== KNOWN SCORES (sanity checks, not exact) =====
describe("known product baselines", () => {
  test("stripe scores A or high B (>= 30)", async () => {
    const r = await score("stripe.com");
    expect(r.totalScore).toBeGreaterThanOrEqual(30);
  });

  test("stripe has high discovery score", async () => {
    const r = await score("stripe.com");
    const disc = getCategoryScore(r, "DISCOVERY")!;
    expect(disc.score).toBeGreaterThanOrEqual(7);
  });

  test("stripe has high integration score", async () => {
    const r = await score("stripe.com");
    const int = getCategoryScore(r, "INTEGRATION")!;
    expect(int.score).toBeGreaterThanOrEqual(7);
  });

  test("coinbase scores >= B (>= 28)", async () => {
    const r = await score("coinbase.com");
    expect(r.totalScore).toBeGreaterThanOrEqual(28);
  });

  test("coinbase has regulatory friction flags", async () => {
    const r = await score("coinbase.com");
    expect(r.frictionSummary.regulatoryFriction.length).toBeGreaterThan(0);
  });
});

// ===== FRICTION ANALYSIS =====
describe("friction analysis", () => {
  test("frictionSummary has required fields", async () => {
    const r = await score("stripe.com");
    expect(r.frictionSummary).toHaveProperty("voluntaryFriction");
    expect(r.frictionSummary).toHaveProperty("regulatoryFriction");
    expect(r.frictionSummary).toHaveProperty("agentReadyPending");
    expect(Array.isArray(r.frictionSummary.voluntaryFriction)).toBe(true);
    expect(Array.isArray(r.frictionSummary.regulatoryFriction)).toBe(true);
  });

  test("agentReadyPending is true when regulatory friction exists", async () => {
    const r = await score("coinbase.com");
    if (r.frictionSummary.regulatoryFriction.length > 0) {
      expect(r.frictionSummary.agentReadyPending).toBe(true);
    }
  });
});

// ===== FRONTEND (index.html) =====
describe("index.html", () => {
  const html = require("fs").readFileSync("index.html", "utf-8");

  test("has page title", () => {
    expect(html).toContain("<title>");
    expect(html).toContain("Agent Readiness Scorer");
  });

  test("has meta description", () => {
    expect(html).toContain('meta name="description"');
  });

  test("has favicon", () => {
    expect(html).toContain('rel="icon"');
  });

  test("has scoring form", () => {
    expect(html).toContain('id="urlInput"');
    expect(html).toContain('id="scoreBtn"');
  });

  test("has about section with rubric", () => {
    expect(html).toContain("What is this?");
    expect(html).toContain("The Rubric");
    expect(html).toContain("Discovery");
    expect(html).toContain("Purchase");
    expect(html).toContain("Integration");
    expect(html).toContain("Trust");
  });

  test("has collapsible category sections", () => {
    expect(html).toContain("<details");
    expect(html).toContain("about-section");
  });

  test("has correct TenOneTen footer link", () => {
    expect(html).toContain('href="https://tenoneten.com"');
    expect(html).toContain("TenOneTen Ventures");
  });

  test("has correct X link (not Twitter)", () => {
    expect(html).toContain(">X</a>");
    expect(html).not.toContain(">Twitter</a>");
  });

  test("has correct Substack link", () => {
    expect(html).toContain("waxmand.substack.com/p/a-simple-test-can-an-ai-agent-use");
  });

  test("does not reference Catena Labs", () => {
    expect(html).not.toContain("Catena");
  });

  test("does not show voluntary friction section", () => {
    expect(html).not.toContain("Design choices (full penalty)");
  });

  test("shows regulatory friction section", () => {
    expect(html).toContain("Regulatory requirements");
  });
});
