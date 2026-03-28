#!/usr/bin/env node

/**
 * life-in-fife — fetch Fife property listings (≤ £230k), prompt for manual scores, print ranked results.
 *
 * Env:
 *   LIFE_IN_FIFE_URL  — Rightmove search URL (must return __NEXT_DATA__ with searchResults.properties), or
 *   LIFE_IN_FIFE_RSS  — RSS/Atom feed URL (optional alternative; title/link/description parsed heuristically)
 */

const axios = require("axios");
const cheerio = require("cheerio");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const DATA_PATH = path.join(__dirname, "data.json");
const SEEN_PATH = path.join(__dirname, "seen.json");

function openInBrowser(url) {
  const command =
    process.platform === "win32"
      ? `start ${url}`
      : process.platform === "darwin"
        ? `open ${url}`
        : `xdg-open ${url}`;

  exec(command);
}

const DEFAULT_RIGHTMOVE_URL =
  "https://www.rightmove.co.uk/property-for-sale/find.html?locationIdentifier=REGION%5E61347&maxPrice=230000&sortType=6&index=0";

const MAX_PRICE = 230_000;
const FIFE_SUBSTRING = "fife";

const WEIGHTS = {
  garden: 0.3,
  workSetup: 0.25,
  transport: 0.15,
  dogLife: 0.1,
  kitchen: 0.08,
  area: 0.06,
  parking: 0.06,
};

const SCORE_KEYS = [
  ["garden", "Garden"],
  ["workSetup", "Work Setup"],
  ["transport", "Transport"],
  ["dogLife", "Dog Life"],
  ["kitchen", "Kitchen"],
  ["area", "Area"],
  ["parking", "Parking"],
];

const axiosDefaults = {
  timeout: 45_000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  validateStatus: (s) => s >= 200 && s < 500,
};

function parsePriceFromText(text) {
  if (!text) return null;
  const m = String(text).match(/£\s*([0-9][0-9,]*)/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function absoluteRightmoveUrl(pathOrUrl) {
  if (!pathOrUrl) return "";
  const s = String(pathOrUrl).trim();
  if (/^https?:\/\//i.test(s)) return s;
  return `https://www.rightmove.co.uk${s.startsWith("/") ? s : `/${s}`}`;
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) return [];
    const raw = fs.readFileSync(DATA_PATH);
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function loadSeen() {
  try {
    if (!fs.existsSync(SEEN_PATH)) return [];
    const raw = fs.readFileSync(SEEN_PATH);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSeen(data) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify(data, null, 2));
}

function isAlreadyScored(existing, property) {
  return existing.some((p) => p.link === property.link);
}

async function checkPropertyStatus(url) {
  try {
    const res = await axios.get(url, { timeout: 5000 });

    // Simple heuristic checks
    const html = String(res.data).toLowerCase();

    if (html.includes("sold") || html.includes("sstc") || html.includes("under offer")) {
      return "unavailable";
    }

    return "active";
  } catch {
    return "unknown";
  }
}

/**
 * Pull listings from Rightmove (embedded JSON) or RSS/Atom XML.
 * @returns {Promise<Array<{ title: string, price: number, location: string, link: string }>>}
 */
async function fetchListings() {
  const rssUrl = process.env.LIFE_IN_FIFE_RSS?.trim();
  const htmlUrl = process.env.LIFE_IN_FIFE_URL?.trim() || DEFAULT_RIGHTMOVE_URL;

  if (rssUrl) {
    return fetchListingsFromRss(rssUrl);
  }
  return fetchListingsFromRightmove(htmlUrl);
}

async function fetchListingsFromRightmove(url) {
  let res;
  try {
    res = await axios.get(url, axiosDefaults);
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}` : err.message;
    throw new Error(`Failed to fetch Rightmove page: ${msg}`);
  }

  if (res.status >= 400) {
    throw new Error(`Rightmove request failed with HTTP ${res.status}`);
  }

  const html = typeof res.data === "string" ? res.data : String(res.data);
  const $ = cheerio.load(html);
  const raw = $("#__NEXT_DATA__").html();
  if (!raw) {
    throw new Error(
      "Could not find __NEXT_DATA__ on the page. Set LIFE_IN_FIFE_URL to a valid Rightmove search results URL, or use LIFE_IN_FIFE_RSS."
    );
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse __NEXT_DATA__ JSON from Rightmove.");
  }

  const props = json?.props?.pageProps?.searchResults?.properties;
  const regionName = json?.props?.pageProps?.searchResults?.location?.displayName || "";

  if (!Array.isArray(props)) {
    throw new Error("Rightmove page had no searchResults.properties array.");
  }

  const listings = [];
  for (const p of props) {
    const amount = p?.price?.amount;
    const price = typeof amount === "number" && Number.isFinite(amount) ? amount : null;
    const displayAddress = (p?.displayAddress || "").trim();
    const typeDesc = (p?.propertyTypeFullDescription || "").trim();
    const title =
      typeDesc && displayAddress
        ? `${typeDesc}, ${displayAddress}`
        : typeDesc || displayAddress || `Property ${p?.id ?? ""}`.trim();

    const regionPart = regionName ? `, ${regionName}` : "";
    const location = `${displayAddress}${regionPart}`.trim() || regionName || "Unknown";

    const link = absoluteRightmoveUrl(p?.propertyUrl);

    if (title && price != null && location && link) {
      listings.push({ title, price, location, link });
    }
  }

  return listings;
}

async function fetchListingsFromRss(url) {
  let res;
  try {
    res = await axios.get(url, { ...axiosDefaults, headers: { ...axiosDefaults.headers, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}` : err.message;
    throw new Error(`Failed to fetch RSS: ${msg}`);
  }

  if (res.status >= 400) {
    throw new Error(`RSS request failed with HTTP ${res.status}`);
  }

  const xml = typeof res.data === "string" ? res.data : String(res.data);
  const $ = cheerio.load(xml, { xmlMode: true });
  const listings = [];

  $("item, entry").each((_, el) => {
    const $el = $(el);
    const title = ($el.find("title").first().text() || "").trim();
    let link = ($el.find("link").first().text() || "").trim();
    if (!link) {
      link = $el.find("link").first().attr("href") || "";
    }
    const desc = ($el.find("description, summary, content").first().text() || "").trim();
    const blob = `${title} ${desc}`;
    const price = parsePriceFromText(blob);
    const location = title || desc.slice(0, 120) || "Unknown";

    if (title && link && price != null) {
      listings.push({ title, price, location, link });
    }
  });

  return listings;
}

function filterListings(listings) {
  return listings.filter((l) => {
    const locOk = l.location.toLowerCase().includes(FIFE_SUBSTRING);
    const priceOk = typeof l.price === "number" && l.price <= MAX_PRICE;
    return locOk && priceOk;
  });
}

function quickScore(property) {
  let score = 0;

  // Bedrooms (basic proxy from title)
  if (property.title.toLowerCase().includes("3 bed")) score += 2;
  if (property.title.toLowerCase().includes("4 bed")) score += 3;

  // Property type preference
  if (property.title.toLowerCase().includes("detached")) score += 3;
  if (property.title.toLowerCase().includes("semi-detached")) score += 2;

  // Price efficiency (closer to max budget is often better value)
  if (property.price > 180000) score += 2;
  if (property.price > 200000) score += 2;

  return score;
}

function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function question(rl, promptText) {
  return new Promise((resolve) => {
    rl.question(promptText, resolve);
  });
}

async function readScore(rl, label) {
  for (;;) {
    const raw = (await question(rl, `  ${label} (0–10): `)).trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) {
      console.log("    Please enter a number between 0 and 10.");
      continue;
    }
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      console.log("    Please enter a whole number from 0 to 10.");
      continue;
    }
    return n;
  }
}

/**
 * @param {object} property — listing with title, price, location, link
 * @param {import('readline').Interface} rl
 * @returns {Promise<Record<string, number>>}
 */
async function promptUserForScores(property, rl) {
  console.log("\n--------------------------------------------------");
  console.log(property.title);
  console.log(`  ${property.location}`);
  console.log(`  £${property.price.toLocaleString("en-GB")}`);
  console.log(`  ${property.link}`);
  console.log("Rate each category from 0 (poor) to 10 (excellent):\n");

  /** @type {Record<string, number>} */
  const scores = {};
  for (const [key, label] of SCORE_KEYS) {
    scores[key] = await readScore(rl, label);
  }
  return scores;
}

/**
 * @param {Record<string, number>} scores
 * @returns {number}
 */
function calculateScore(scores) {
  let total = 0;
  for (const [key, w] of Object.entries(WEIGHTS)) {
    const v = scores[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`Missing or invalid score for: ${key}`);
    }
    total += v * w;
  }
  return total;
}

async function main() {
  console.log("life-in-fife — Fife listings (≤ £230k), manual scores, weighted rank\n");

  const existingData = loadData();

  let listings;
  try {
    listings = await fetchListings();
  } catch (err) {
    console.error("Error:", err.message || err);
    process.exitCode = 1;
    return;
  }

  const seenData = loadSeen();
  const seenMap = new Map(seenData.map((p) => [p.link, p]));

  const enrichedListings = listings.map((p) => {
    const seen = seenMap.get(p.link);

    return {
      ...p,
      firstSeen: seen?.firstSeen || new Date().toISOString(),
    };
  });

  enrichedListings.forEach((p) => {
    if (!seenMap.has(p.link)) {
      const row = { link: p.link, firstSeen: p.firstSeen, title: p.title };
      seenData.push(row);
      seenMap.set(p.link, row);
    }
  });

  saveSeen(seenData);

  const filtered = filterListings(enrichedListings);

  if (filtered.length === 0) {
    console.error(
      "No listings left after filtering (need “Fife” in location and price ≤ £230,000). Try another LIFE_IN_FIFE_URL / LIFE_IN_FIFE_RSS or check the site returned results."
    );
    process.exitCode = 1;
    return;
  }

  const shortlisted = filtered
    .map((p) => ({ ...p, quickScore: quickScore(p) }))
    .sort((a, b) => b.quickScore - a.quickScore)
    .slice(0, 5);

  console.log(
    `Shortlisted ${shortlisted.length} of ${filtered.length} filtered listing(s) for manual scoring (quick pre-filter, max 5).\n`
  );

  const newListings = shortlisted.filter((p) => !isAlreadyScored(existingData, p));

  if (newListings.length > 0) {
    console.log("\nTop New Picks Today:\n");

    newListings.forEach((p, i) => {
      const daysOnMarket = Math.floor(
        (Date.now() - new Date(p.firstSeen)) / (1000 * 60 * 60 * 24)
      );

      console.log(
        `${i + 1}. ${p.title} — £${p.price} (Quick: ${p.quickScore}) (${daysOnMarket}d on list)`
      );
      console.log(`   ${p.link}`);
    });

    console.log("\n--- Starting scoring ---\n");
  } else {
    console.log("\nNo new properties to score today.");
    console.log("Review your top properties so far below.\n");
  }

  /** @type {Array<{ property: object, scores: Record<string, number>, finalScore: number }>} */
  const results = [];

  if (newListings.length > 0) {
    const rl = createRl();

    try {
      for (let i = 0; i < newListings.length; i++) {
        console.log(`\n[${i + 1} / ${newListings.length}]`);
        const property = newListings[i];
        openInBrowser(property.link);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const scores = await promptUserForScores(property, rl);
        const finalScore = calculateScore(scores);
        results.push({ property, scores, finalScore });
        existingData.push({
          ...property,
          scores,
          finalScore,
          firstSeen: property.firstSeen,
          scoredAt: new Date().toISOString(),
          status: "active",
          lastChecked: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error("\nError during input:", err.message || err);
      process.exitCode = 1;
    } finally {
      rl.close();
    }
  }

  if (results.length > 0) {
    saveData(existingData);

    results.sort((a, b) => b.finalScore - a.finalScore);

    console.log("\n========== RANKED RESULTS ==========\n");
    results.forEach((r, idx) => {
      const lineScore = r.finalScore.toFixed(1);
      const q = r.property.quickScore;
      console.log(`${idx + 1}. ${r.property.title} — Score: ${lineScore} (Quick: ${q})`);
      console.log(`   Link: ${r.property.link}\n`);
    });
  }

  const now = Date.now();

  for (const property of existingData) {
    const lastChecked = property.lastChecked
      ? new Date(property.lastChecked).getTime()
      : 0;

    const hoursSinceCheck = (now - lastChecked) / (1000 * 60 * 60);

    if (!property.status || hoursSinceCheck > 24) {
      property.status = await checkPropertyStatus(property.link);
      property.lastChecked = new Date().toISOString();
    }
  }

  saveData(existingData);

  const activeProperties = existingData.filter((p) => p.status === "active");
  const inactiveProperties = existingData.filter((p) => p.status !== "active");

  activeProperties.sort((a, b) => b.finalScore - a.finalScore);
  inactiveProperties.sort((a, b) => b.finalScore - a.finalScore);

  console.log("\nTop Active Properties:\n");

  activeProperties.slice(0, 5).forEach((p, i) => {
    console.log(`${i + 1}. ${p.title} — ${p.finalScore.toFixed(1)} [${p.status}]`);
    console.log(`   ${p.link}`);
  });

  if (inactiveProperties.length > 0) {
    console.log("\nPreviously Seen (Now Unavailable or Unknown):\n");

    inactiveProperties.slice(0, 3).forEach((p, i) => {
      console.log(`${i + 1}. ${p.title} — ${p.finalScore.toFixed(1)} [${p.status}]`);
      console.log(`   ${p.link}`);
    });
  }
}

if (require.main === module) {
  main();
}
