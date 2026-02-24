import * as cheerio from "cheerio";

export type FrictionType = "voluntary" | "regulatory" | "none";

export interface SubScore {
  name: string;
  maxPoints: number;
  score: number;
  findings: string[];
  frictionType?: FrictionType;
  frictionNote?: string;
}

export interface CategoryScore {
  name: string;
  description: string;
  maxPoints: number;
  score: number;
  subScores: SubScore[];
}

export interface FrictionSummary {
  voluntaryFriction: string[];   // Design choices the company made (score harshly)
  regulatoryFriction: string[];  // KYC/AML/compliance (half penalty)
  agentReadyPending: boolean;    // True if score would improve once agent identity infra exists
}

export interface ScoringResult {
  id: string;
  url: string;
  timestamp: string;
  totalScore: number;
  maxScore: number;
  grade: string;
  categories: CategoryScore[];
  frictionSummary: FrictionSummary;
  crawledPages: string[];
  errors: string[];
}

// Seed paths to always try
const SEED_PATHS = [
  "", "/docs", "/api", "/pricing", "/developers", "/developer",
  "/api-docs", "/documentation", "/swagger", "/openapi",
  "/terms", "/tos", "/terms-of-service", "/legal",
  "/sla", "/status", "/security",
  "/sandbox", "/playground", "/test",
  "/integrations", "/plugins", "/marketplace",
];

// Patterns that indicate a page is relevant for scoring
const RELEVANT_PATTERNS = [
  /\b(api|docs?|documentation|developer|reference|sdk)\b/i,
  /\b(pric|plan|billing|subscription|cost)\b/i,
  /\b(terms|tos|legal|privacy|policy|compliance)\b/i,
  /\b(integrat|plugin|marketplace|partner|connect)\b/i,
  /\b(security|sla|status|uptime|trust)\b/i,
  /\b(sandbox|playground|test|demo|trial|get-?started)\b/i,
  /\b(sign-?up|register|onboard|quick-?start)\b/i,
  /\b(openapi|swagger|graphql|rest|webhook)\b/i,
  /\b(kyc|identity|verif|aml|comply)\b/i,
];

const MAX_CRAWL_PAGES = 30;

function isRelevantUrl(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  // Skip obvious non-relevant pages
  if (/\.(png|jpg|jpeg|gif|svg|css|js|woff|ico|pdf|mp4|webm)$/i.test(path)) return false;
  if (/\/(blog|press|news|careers|jobs|about-us|team|contact-us|events|podcast|webinar)\b/i.test(path)) return false;
  return RELEVANT_PATTERNS.some(p => p.test(path));
}

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];
const UA = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

async function fetchPage(url: string, timeout = 12000, retries = 2): Promise<{ html: string; status: number } | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });
      clearTimeout(timer);
      const html = await resp.text();
      return { html, status: resp.status };
    } catch {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  return null;
}

function textContains(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter(k => lower.includes(k.toLowerCase()));
}

function findLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      try {
        links.push(new URL(href, baseUrl).href);
      } catch {}
    }
  });
  return links;
}

export async function scoreUrl(inputUrl: string): Promise<ScoringResult> {
  let baseUrl: URL;
  try {
    baseUrl = new URL(inputUrl.startsWith("http") ? inputUrl : `https://${inputUrl}`);
  } catch {
    throw new Error("Invalid URL. Try something like: stripe.com");
  }

  // Validate it looks like a real domain (must have a dot, e.g. stripe.com not just "stripe")
  if (!baseUrl.hostname.includes(".")) {
    throw new Error(`"${inputUrl}" doesn't look like a full URL. Try: ${inputUrl}.com`);
  }

  // Normalize: strip www. so twilio.com and www.twilio.com produce the same result
  if (baseUrl.hostname.startsWith("www.")) {
    baseUrl = new URL(baseUrl.href.replace(`://www.`, `://`));
  }

  const origin = baseUrl.origin;
  const pages: Map<string, string> = new Map();
  const errors: string[] = [];
  const crawledPages: string[] = [];
  const visited = new Set<string>();

  // Phase 0: Build subdomain seeds (common dev/docs subdomains)
  const baseDomain = baseUrl.hostname.replace(/^www\./, "");
  const SUBDOMAIN_PREFIXES = ["docs", "developer", "developers", "api", "status"];
  const subdomainSeeds: string[] = [];
  for (const sub of SUBDOMAIN_PREFIXES) {
    subdomainSeeds.push(`https://${sub}.${baseDomain}`);
  }

  // Phase 1: Try seed paths on main origin + subdomain roots (parallel, batched)
  const allSeeds: string[] = [
    ...SEED_PATHS.map(p => origin + p),
    ...subdomainSeeds,
  ];
  const BATCH_SIZE = 5;
  const uniqueSeeds = allSeeds.filter(u => { if (visited.has(u)) return false; visited.add(u); return true; });
  for (let i = 0; i < uniqueSeeds.length; i += BATCH_SIZE) {
    const batch = uniqueSeeds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (fullUrl) => {
      const result = await fetchPage(fullUrl);
      return { fullUrl, result };
    }));
    for (const { fullUrl, result } of results) {
      if (result && result.status < 400) {
        const path = fullUrl.startsWith(origin) ? (new URL(fullUrl).pathname || "/") : fullUrl;
        pages.set(path, result.html);
        crawledPages.push(fullUrl);
      }
    }
    if (i + BATCH_SIZE < uniqueSeeds.length) await new Promise(r => setTimeout(r, 300));
  }

  // Phase 2: Discover relevant links from crawled pages
  const discoveredUrls: string[] = [];
  for (const [, html] of pages) {
    const links = findLinks(html, origin);
    for (const link of links) {
      try {
        const parsed = new URL(link);
        // Same domain (allow subdomains)
        const linkDomain = parsed.hostname.replace(/^www\./, "");
        if (!linkDomain.endsWith(baseDomain)) continue;
        const normalized = parsed.origin + parsed.pathname.replace(/\/$/, "");
        if (visited.has(normalized)) continue;
        if (isRelevantUrl(normalized)) {
          discoveredUrls.push(normalized);
        }
      } catch {}
    }
  }

  // Dedupe and cap discovered URLs
  const uniqueDiscovered = [...new Set(discoveredUrls)].slice(0, MAX_CRAWL_PAGES - pages.size);

  // Phase 3: Crawl discovered pages (parallel, batched)
  for (let i = 0; i < uniqueDiscovered.length && pages.size < MAX_CRAWL_PAGES; i += BATCH_SIZE) {
    const batch = uniqueDiscovered.slice(i, i + BATCH_SIZE);
    batch.forEach(u => visited.add(u));
    const results = await Promise.all(batch.map(async (url) => {
      const result = await fetchPage(url);
      return { url, result };
    }));
    for (const { url, result } of results) {
      if (pages.size >= MAX_CRAWL_PAGES) break;
      if (result && result.status < 400) {
        const path = new URL(url).pathname;
        pages.set(path, result.html);
        crawledPages.push(url);
      }
    }
    if (i + BATCH_SIZE < uniqueDiscovered.length && pages.size < MAX_CRAWL_PAGES) await new Promise(r => setTimeout(r, 300));
  }

  if (pages.size === 0) {
    errors.push("Could not fetch any pages from this URL");
  }

  const allText = [...pages.values()].join("\n").toLowerCase();
  const allLinks = [...pages.entries()].flatMap(([, html]) => findLinks(html, origin));
  const allLinksText = allLinks.join(" ").toLowerCase();

  // Helper
  const hasAny = (keywords: string[]) => textContains(allText, keywords);
  const linkHasAny = (keywords: string[]) => textContains(allLinksText, keywords);

  // ===== DISCOVERY =====
  const disc_api: SubScore = { name: "Public API with docs", maxPoints: 3, score: 0, findings: [] };
  {
    const apiIndicators = hasAny(["api documentation", "api reference", "api docs", "developer docs", "rest api", "graphql api"]);
    const apiLinks = linkHasAny(["/api", "/docs", "/developer", "/reference", "/api-docs"]);
    if (apiIndicators.length > 0) {
      disc_api.score += 2;
      disc_api.findings.push(`Found API doc references: ${apiIndicators.join(", ")}`);
    }
    if (apiLinks.length > 0) {
      disc_api.score = Math.min(3, disc_api.score + 1);
      disc_api.findings.push(`Found API-related links`);
    }
    if (pages.has("/docs") || pages.has("/api") || pages.has("/api-docs") || pages.has("/documentation")) {
      disc_api.score = Math.min(3, disc_api.score + 1);
      disc_api.findings.push("Dedicated docs/API page accessible");
    }
    if (disc_api.score === 0) disc_api.findings.push("No public API documentation detected");
  }

  const disc_pricing: SubScore = { name: "Machine-readable pricing", maxPoints: 3, score: 0, findings: [] };
  {
    const pricingPage = pages.has("/pricing");
    const pricingKeywords = hasAny(["pricing", "price", "per month", "/mo", "free tier", "free plan", "pay as you go", "usage-based"]);
    const structuredPricing = hasAny(["application/ld+json", "schema.org/offer", "schema.org/product", "itemtype=\"http"]);
    if (pricingPage) {
      disc_pricing.score += 1;
      disc_pricing.findings.push("Pricing page found");
    }
    if (pricingKeywords.length > 0) {
      disc_pricing.score = Math.min(2, disc_pricing.score + 1);
      disc_pricing.findings.push(`Pricing keywords: ${pricingKeywords.slice(0, 3).join(", ")}`);
    }
    if (structuredPricing.length > 0) {
      disc_pricing.score = 3;
      disc_pricing.findings.push("Structured pricing data (schema.org) detected");
    }
    if (disc_pricing.score === 0) disc_pricing.findings.push("No machine-readable pricing detected");
  }

  const disc_directories: SubScore = { name: "Listed in agent directories", maxPoints: 2, score: 0, findings: [] };
  {
    const dirKeywords = hasAny(["rapidapi", "programmableweb", "api marketplace", "api directory", "agent directory", "mcp server", "agent protocol"]);
    if (dirKeywords.length > 0) {
      disc_directories.score = Math.min(2, dirKeywords.length);
      disc_directories.findings.push(`Directory mentions: ${dirKeywords.join(", ")}`);
    } else {
      disc_directories.findings.push("No agent/API directory listings detected (hard to verify automatically)");
    }
  }

  const disc_metadata: SubScore = { name: "Structured metadata / OpenAPI spec", maxPoints: 2, score: 0, findings: [] };
  {
    const openapiIndicators = hasAny(["openapi", "swagger", "api-spec", "openapi.json", "openapi.yaml", "swagger.json", "swagger.yaml", "redoc"]);
    if (openapiIndicators.length > 0) {
      disc_metadata.score = 2;
      disc_metadata.findings.push(`OpenAPI/Swagger indicators: ${openapiIndicators.join(", ")}`);
    }
    // Check for common OpenAPI paths
    for (const p of ["/openapi.json", "/swagger.json", "/api-docs/swagger.json", "/.well-known/openapi.json"]) {
      const r = await fetchPage(origin + p, 3000);
      if (r && r.status === 200 && r.html.includes('"openapi"')) {
        disc_metadata.score = 2;
        disc_metadata.findings.push(`OpenAPI spec found at ${p}`);
        break;
      }
    }
    if (disc_metadata.score === 0) disc_metadata.findings.push("No OpenAPI/Swagger spec detected");
  }

  // ===== PURCHASE =====
  const purch_signup: SubScore = { name: "Programmatic signup", maxPoints: 2, score: 0, findings: [], frictionType: "none" };
  {
    const signupIndicators = hasAny(["api key", "get started", "sign up", "create account", "register", "get api key", "instant access"]);
    const noHumanSteps = hasAny(["no credit card", "instant", "self-serve", "self-service", "automatic"]);
    const kycIndicators = hasAny(["kyc", "know your customer", "identity verification", "id verification", "aml", "anti-money laundering", "verify your identity", "government id", "ssn", "passport", "drivers license", "proof of address", "accredited investor"]);
    const contactSalesSignup = hasAny(["contact sales", "request demo", "book a demo", "talk to sales", "schedule a call", "request access"]);

    if (kycIndicators.length > 0) {
      // Regulatory friction — half penalty (1 instead of 0)
      purch_signup.score = 1;
      purch_signup.frictionType = "regulatory";
      purch_signup.frictionNote = "KYC/identity verification required by regulation — not a design choice";
      purch_signup.findings.push(`Regulatory friction (half penalty): ${kycIndicators.slice(0, 3).join(", ")}`);
    } else if (contactSalesSignup.length > 0 && signupIndicators.length === 0) {
      // Voluntary friction — full penalty
      purch_signup.score = 0;
      purch_signup.frictionType = "voluntary";
      purch_signup.frictionNote = "Manual onboarding by design choice — blocks agents";
      purch_signup.findings.push(`Voluntary friction: ${contactSalesSignup.slice(0, 2).join(", ")}`);
    } else if (noHumanSteps.length > 0) {
      purch_signup.score = 2;
      purch_signup.findings.push(`Self-serve indicators: ${noHumanSteps.slice(0, 2).join(", ")}`);
    } else if (signupIndicators.length > 0) {
      purch_signup.score = 1;
      purch_signup.findings.push(`Signup indicators: ${signupIndicators.slice(0, 3).join(", ")}`);
    } else {
      purch_signup.findings.push("No programmatic signup flow detected");
    }
  }

  const purch_captcha: SubScore = { name: "No CAPTCHA", maxPoints: 2, score: 2, findings: [], frictionType: "none" };
  {
    const captchaIndicators = hasAny(["recaptcha", "hcaptcha", "captcha", "g-recaptcha", "cf-turnstile", "turnstile"]);
    if (captchaIndicators.length > 0) {
      purch_captcha.score = 0;
      purch_captcha.frictionType = "voluntary";
      purch_captcha.frictionNote = "CAPTCHA is a design choice — blocks agents entirely";
      purch_captcha.findings.push(`CAPTCHA detected (voluntary friction): ${captchaIndicators.join(", ")}`);
    } else {
      purch_captcha.findings.push("No CAPTCHA detected on crawled pages");
    }
  }

  const purch_billing: SubScore = { name: "API-based / usage-based billing", maxPoints: 2, score: 0, findings: [] };
  {
    const billingIndicators = hasAny(["usage-based", "pay per use", "pay as you go", "per request", "per call", "metered", "per api call", "per token"]);
    if (billingIndicators.length > 0) {
      purch_billing.score = 2;
      purch_billing.findings.push(`Usage-based billing: ${billingIndicators.slice(0, 2).join(", ")}`);
    } else {
      const subIndicators = hasAny(["subscription", "monthly", "annual", "enterprise"]);
      if (subIndicators.length > 0) {
        purch_billing.score = 1;
        purch_billing.findings.push("Traditional subscription billing detected");
      } else {
        purch_billing.findings.push("No billing model detected");
      }
    }
  }

  const purch_crypto: SubScore = { name: "Accepts crypto/stablecoin", maxPoints: 2, score: 0, findings: [] };
  {
    const cryptoIndicators = hasAny(["crypto", "cryptocurrency", "bitcoin", "ethereum", "usdc", "usdt", "stablecoin", "web3", "wallet"]);
    if (cryptoIndicators.length > 0) {
      purch_crypto.score = 2;
      purch_crypto.findings.push(`Crypto mentions: ${cryptoIndicators.slice(0, 3).join(", ")}`);
    } else {
      purch_crypto.findings.push("No cryptocurrency payment options detected");
    }
  }

  const purch_protocols: SubScore = { name: "Supports x402, UCP, or AP2", maxPoints: 2, score: 0, findings: [] };
  {
    const protocolIndicators = hasAny(["x402", "ucp", "agent protocol", "ap2", "402 payment", "http 402", "machine-payable"]);
    if (protocolIndicators.length > 0) {
      purch_protocols.score = 2;
      purch_protocols.findings.push(`Agent payment protocols: ${protocolIndicators.join(", ")}`);
    } else {
      purch_protocols.findings.push("No agent payment protocols (x402/UCP/AP2) detected");
    }
  }

  // ===== INTEGRATION =====
  const int_mcp: SubScore = { name: "MCP or A2A support", maxPoints: 3, score: 0, findings: [] };
  {
    const mcpIndicators = hasAny(["model context protocol", "mcp", "agent-to-agent", "a2a", "mcp server", "mcp tool", "function calling"]);
    if (mcpIndicators.length > 0) {
      int_mcp.score = 3;
      int_mcp.findings.push(`MCP/A2A indicators: ${mcpIndicators.slice(0, 3).join(", ")}`);
    } else {
      int_mcp.findings.push("No MCP or A2A support detected");
    }
  }

  const int_structured: SubScore = { name: "Structured output (JSON)", maxPoints: 3, score: 0, findings: [] };
  {
    const jsonIndicators = hasAny(["json response", "json api", "application/json", "rest api", "graphql", "json output", "json format", "returns json"]);
    const sdkIndicators = hasAny(["sdk", "client library", "npm install", "pip install", "gem install", "nuget"]);
    if (jsonIndicators.length > 0) {
      int_structured.score += 2;
      int_structured.findings.push(`JSON/structured output: ${jsonIndicators.slice(0, 3).join(", ")}`);
    }
    if (sdkIndicators.length > 0) {
      int_structured.score = Math.min(3, int_structured.score + 1);
      int_structured.findings.push(`SDK/client libraries: ${sdkIndicators.slice(0, 2).join(", ")}`);
    }
    if (int_structured.score === 0) int_structured.findings.push("No structured JSON output detected");
  }

  const int_sandbox: SubScore = { name: "Sandbox/test environment", maxPoints: 2, score: 0, findings: [] };
  {
    const sandboxIndicators = hasAny(["sandbox", "test mode", "test environment", "playground", "try it", "interactive", "api console", "api explorer"]);
    if (sandboxIndicators.length > 0) {
      int_sandbox.score = 2;
      int_sandbox.findings.push(`Sandbox/test: ${sandboxIndicators.slice(0, 3).join(", ")}`);
    } else {
      int_sandbox.findings.push("No sandbox or test environment detected");
    }
  }

  const int_ratelimits: SubScore = { name: "Clear rate limits & error handling", maxPoints: 2, score: 0, findings: [] };
  {
    const rlIndicators = hasAny(["rate limit", "rate-limit", "throttl", "429", "quota", "requests per", "rpm", "rps", "error code", "error handling", "status code"]);
    if (rlIndicators.length > 0) {
      int_ratelimits.score = 2;
      int_ratelimits.findings.push(`Rate limit/error docs: ${rlIndicators.slice(0, 3).join(", ")}`);
    } else {
      int_ratelimits.findings.push("No rate limit documentation detected");
    }
  }

  // ===== TRUST =====
  const trust_pricing: SubScore = { name: "Transparent pricing", maxPoints: 3, score: 0, findings: [] };
  {
    const contactSales = hasAny(["contact sales", "contact us for pricing", "request a quote", "custom pricing", "talk to sales"]);
    const transparentPricing = hasAny(["$", "€", "£", "free", "per month", "/mo", "/year", "starting at"]);
    if (contactSales.length > 0 && transparentPricing.length === 0) {
      trust_pricing.score = 0;
      trust_pricing.findings.push(`Opaque pricing: ${contactSales.join(", ")}`);
    } else if (transparentPricing.length > 0) {
      trust_pricing.score = contactSales.length > 0 ? 2 : 3;
      trust_pricing.findings.push("Public pricing found");
      if (contactSales.length > 0) trust_pricing.findings.push("Also has 'contact sales' (likely enterprise tier)");
    } else {
      trust_pricing.findings.push("No pricing information detected");
    }
  }

  const trust_spend: SubScore = { name: "Spend controls and usage caps", maxPoints: 3, score: 0, findings: [] };
  {
    const spendIndicators = hasAny(["spend limit", "usage cap", "budget", "spending limit", "cost control", "billing alert", "usage alert", "hard limit", "soft limit"]);
    if (spendIndicators.length > 0) {
      trust_spend.score = 3;
      trust_spend.findings.push(`Spend controls: ${spendIndicators.slice(0, 3).join(", ")}`);
    } else {
      trust_spend.findings.push("No spend controls or usage caps detected");
    }
  }

  const trust_sla: SubScore = { name: "SLA / uptime guarantees", maxPoints: 2, score: 0, findings: [] };
  {
    const slaIndicators = hasAny(["sla", "uptime", "99.9", "99.99", "availability", "service level", "status page"]);
    const statusPage = pages.has("/status") || pages.has("/sla");
    if (slaIndicators.length > 0 || statusPage) {
      trust_sla.score = 2;
      if (statusPage) trust_sla.findings.push("Status/SLA page accessible");
      if (slaIndicators.length > 0) trust_sla.findings.push(`SLA mentions: ${slaIndicators.slice(0, 3).join(", ")}`);
    } else {
      trust_sla.findings.push("No SLA or uptime guarantees detected");
    }
  }

  const trust_tos: SubScore = { name: "ToS allows automated/agent usage", maxPoints: 2, score: 0, findings: [] };
  {
    const tosPage = pages.has("/terms") || pages.has("/tos") || pages.has("/terms-of-service") || pages.has("/legal");
    const automatedUse = hasAny(["automated", "programmatic access", "bot", "machine", "agent", "non-human"]);
    const antiBot = hasAny(["no automated", "prohibit automated", "no bots", "no scraping", "human only"]);
    if (tosPage) {
      trust_tos.score += 1;
      trust_tos.findings.push("Terms of Service page found");
    }
    if (automatedUse.length > 0 && antiBot.length === 0) {
      trust_tos.score = 2;
      trust_tos.findings.push("Appears to allow automated usage");
    } else if (antiBot.length > 0) {
      trust_tos.score = 0;
      trust_tos.findings.push(`May restrict automated use: ${antiBot.join(", ")}`);
    }
    if (trust_tos.score === 0 && !tosPage) trust_tos.findings.push("No Terms of Service found to evaluate");
  }

  // Build categories
  const categories: CategoryScore[] = [
    {
      name: "DISCOVERY", description: "Can an agent find this?", maxPoints: 10,
      score: 0, subScores: [disc_api, disc_pricing, disc_directories, disc_metadata]
    },
    {
      name: "PURCHASE", description: "Can an agent buy it?", maxPoints: 10,
      score: 0, subScores: [purch_signup, purch_captcha, purch_billing, purch_crypto, purch_protocols]
    },
    {
      name: "INTEGRATION", description: "Can an agent use it?", maxPoints: 10,
      score: 0, subScores: [int_mcp, int_structured, int_sandbox, int_ratelimits]
    },
    {
      name: "TRUST", description: "Would an owner allow it?", maxPoints: 10,
      score: 0, subScores: [trust_pricing, trust_spend, trust_sla, trust_tos]
    },
  ];

  for (const cat of categories) {
    cat.score = Math.min(cat.maxPoints, cat.subScores.reduce((sum, s) => sum + s.score, 0));
  }

  const totalScore = categories.reduce((sum, c) => sum + c.score, 0);
  let grade: string;
  if (totalScore >= 35) grade = "A";
  else if (totalScore >= 28) grade = "B";
  else if (totalScore >= 20) grade = "C";
  else if (totalScore >= 10) grade = "D";
  else grade = "F";

  // Build friction summary
  const allSubScores = categories.flatMap(c => c.subScores);
  const voluntaryFriction = allSubScores
    .filter(s => s.frictionType === "voluntary")
    .map(s => s.frictionNote || s.name);
  const regulatoryFriction = allSubScores
    .filter(s => s.frictionType === "regulatory")
    .map(s => s.frictionNote || s.name);
  const agentReadyPending = regulatoryFriction.length > 0;

  const frictionSummary: FrictionSummary = {
    voluntaryFriction,
    regulatoryFriction,
    agentReadyPending,
  };

  const id = crypto.randomUUID().split("-")[0];

  return {
    id, url: origin, timestamp: new Date().toISOString(),
    totalScore, maxScore: 40, grade, categories, frictionSummary, crawledPages, errors,
  };
}
