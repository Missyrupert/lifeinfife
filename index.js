#!/usr/bin/env node

/**
 * life-in-fife — Fife property listings (≤ £230k), manual scores, weighted rank
 *
 * Env:
 *   LIFE_IN_FIFE_URL  — Rightmove search URL (__NEXT_DATA__), or
 *   LIFE_IN_FIFE_RSS  — RSS/Atom feed URL
 */

const readline = require("readline");
const { exec } = require("child_process");
const {
  loadData,
  saveData,
  fetchListings,
  filterListings,
  enrichListingsWithSeen,
  buildShortlistedTopFive,
  calculateScore,
  isAlreadyScored,
  checkPropertyStatus,
  SCORE_KEYS,
} = require("./core");

function openInBrowser(url) {
  const command =
    process.platform === "win32"
      ? `start ${url}`
      : process.platform === "darwin"
        ? `open ${url}`
        : `xdg-open ${url}`;

  exec(command);
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

async function promptUserForScores(property, rl) {
  console.log("\n--------------------------------------------------");
  console.log(property.title);
  console.log(`  ${property.location}`);
  console.log(`  £${property.price.toLocaleString("en-GB")}`);
  console.log(`  ${property.link}`);
  console.log("Rate each category from 0 (poor) to 10 (excellent):\n");

  const scores = {};
  for (const [key, label] of SCORE_KEYS) {
    scores[key] = await readScore(rl, label);
  }
  return scores;
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

  const enrichedListings = enrichListingsWithSeen(listings);
  const filtered = filterListings(enrichedListings);

  if (filtered.length === 0) {
    console.error(
      "No listings left after filtering (need “Fife” in location and price ≤ £230,000). Try another LIFE_IN_FIFE_URL / LIFE_IN_FIFE_RSS or check the site returned results."
    );
    process.exitCode = 1;
    return;
  }

  const shortlisted = buildShortlistedTopFive(enrichedListings);

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
