import axios from "axios";
import { io } from "socket.io-client";
import * as cheerio from "cheerio";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SOCKET_URL = process.env.WINAMAX_SOCKET_URL;
const SOCKET_PATH = process.env.WINAMAX_SOCKET_PATH || "/socket.io";
const SOCKET_QUERY = process.env.WINAMAX_SOCKET_QUERY;
const JSON_URL = process.env.WINAMAX_JSON_URL;
const WINAMAX_HTML_URL = "https://www.winamax.fr/paris-sportifs/sports/1";
const REF_ODDS_API_URL = process.env.REF_ODDS_API_URL; // ex: https://api.myoddsprovider.com/getOdds
const REF_ODDS_API_KEY = process.env.REF_ODDS_API_KEY;
const REF_ODDS_PROVIDER = process.env.REF_ODDS_PROVIDER || null; // optional provider name for storage

function impliedProbFromPrice(price: number) {
  return 1 / price;
}

function normalizeImpliedProbs(implied: number[]) {
  const sum = implied.reduce((s, v) => s + v, 0);
  if (sum === 0) return implied.map(() => 0);
  return implied.map((v) => v / sum);
}

function computeEvPlusPercent(probWinamax: number, probRef: number) {
  return (probWinamax - probRef) * 100;
}

async function fetchReferenceOdds(home: string, away: string, startAt: Date) {
  if (!REF_ODDS_API_URL) return null;
  // Special-case: built-in support for TheOddsAPI when provider is set
  if (REF_ODDS_PROVIDER === "theoddsapi" && REF_ODDS_API_KEY) {
    try {
      const base = "https://api.the-odds-api.com/v4/sports/soccer/odds/";
      const params = {
        regions: "eu",
        markets: "1x2",
        oddsFormat: "decimal",
        dateFormat: "iso",
        apiKey: REF_ODDS_API_KEY,
      } as any;

      const res = await axios.get(base, { params, timeout: 15000 });
      const data = res.data;
      if (!Array.isArray(data)) return null;

      // Find an event matching home/away (case-insensitive, allowing partial matches)
      const matchEvent = data.find((ev: any) => {
        const teams = [ev.home_team ?? ev.teams?.[0], ev.away_team ?? ev.teams?.[1]];
        if (!teams || teams.length < 2) return false;
        const h = teams[0]?.toString().toLowerCase() || "";
        const a = teams[1]?.toString().toLowerCase() || "";
        return (h.includes(home.toLowerCase()) && a.includes(away.toLowerCase())) || (h.includes(away.toLowerCase()) && a.includes(home.toLowerCase()));
      });

      if (matchEvent) {
        // Extract prices from first bookmaker with market 1x2
        const bookmakers = matchEvent.bookmakers ?? [];
        for (const bm of bookmakers) {
          for (const m of bm.markets ?? []) {
            if (/1x2|h2h|match result|1n2/i.test(m.key ?? m.key)) {
              const outcomes = m.outcomes ?? [];
              // outcomes order may vary; map by name
              const map: Record<string, number> = {};
              for (const o of outcomes) {
                const name = (o.name ?? o.outcome ?? "").toString().toLowerCase();
                const price = Number(o.price ?? o.odds ?? o.priceDecimal ?? o.oddsDecimal ?? o);
                if (name.includes("home") || name.includes("team1") || name.includes("1") ) map["1"] = price;
                if (name.includes("draw") || name.includes("x") || name.includes("n")) map["N"] = price;
                if (name.includes("away") || name.includes("team2") || name.includes("2")) map["2"] = price;
              }
              if (map["1"] && map["N"] && map["2"]) return [map["1"], map["N"], map["2"]];
              // fallback: if exactly 3 outcomes, return their prices
              if (outcomes.length >= 3) {
                const nums = outcomes.slice(0,3).map((o:any)=>Number(o.price ?? o.odds ?? o));
                if (nums.every((n:number)=>isFinite(n) && n>0)) return nums;
              }
            }
          }
        }
      }
      return null;
    } catch (err) {
      console.warn("TheOddsAPI fetch failed:", err instanceof Error ? err.message : err);
      // fallthrough to generic handler below if an explicit REF_ODDS_API_URL is provided
    }
  }
  try {
    const params: any = { home: home, away: away, date: startAt.toISOString() };
    const headers: any = {};
    if (REF_ODDS_API_KEY) headers["Authorization"] = `Bearer ${REF_ODDS_API_KEY}`;
    const res = await axios.get(REF_ODDS_API_URL, { params, headers, timeout: 15000 });
    const data = res.data;

    // Try to extract 1X2 prices from common shapes.
    // Expecting an array of bookmakers or a single object with markets.
    // We'll look for a market named "1X2", "1N2", "Match Result", or similar.
    const attempts: number[] = [];

    // Helper to push prices if found and valid
    const pushIfValid = (arr: any[]) => {
      if (!arr || arr.length < 3) return false;
      const nums = arr.slice(0, 3).map((p: any) => Number(p));
      if (nums.some((n: number) => !isFinite(n) || n <= 0)) return false;
      attempts.push(nums[0], nums[1], nums[2]);
      return true;
    };

    // If provider returns { prices: { home, draw, away } }
    if (data?.prices && data.prices.home && data.prices.draw && data.prices.away) {
      return [Number(data.prices.home), Number(data.prices.draw), Number(data.prices.away)];
    }

    // If returns array of offers
    if (Array.isArray(data)) {
      for (const item of data) {
        // market-based
        if (item?.market && /1\s?X?N?2|match result|1n2/i.test(item.market)) {
          const prices = item.prices ?? item.odds ?? item.outcomes;
          if (Array.isArray(prices) && prices.length >= 3) {
            const nums = prices.slice(0, 3).map((p: any) => Number(p.price ?? p.odds ?? p));
            if (nums.every((n) => isFinite(n) && n > 0)) return nums;
          }
        }

        // bookmaker style: {bookmaker: '', markets: [...] }
        if (item?.markets && Array.isArray(item.markets)) {
          for (const mkt of item.markets) {
            if (/1\s?X?N?2|match result|1n2/i.test(mkt.name ?? mkt.key ?? '')) {
              const prices = mkt.outcomes ?? mkt.prices ?? mkt.odds;
              if (Array.isArray(prices) && prices.length >= 3) {
                const nums = prices.slice(0, 3).map((p: any) => Number(p.price ?? p.odds ?? p));
                if (nums.every((n) => isFinite(n) && n > 0)) return nums;
              }
            }
          }
        }
      }
    }

    // If data has bookmakers map
    if (data?.bookmakers && Array.isArray(data.bookmakers)) {
      for (const bm of data.bookmakers) {
        for (const mkt of bm.markets ?? []) {
          if (/1\s?X?N?2|match result|1n2/i.test(mkt.key ?? mkt.name ?? '')) {
            const prices = mkt.outcomes ?? mkt.prices ?? mkt.odds;
            if (Array.isArray(prices) && prices.length >= 3) {
              const nums = prices.slice(0, 3).map((p: any) => Number(p.price ?? p.odds ?? p));
              if (nums.every((n) => isFinite(n) && n > 0)) return nums;
            }
          }
        }
      }
    }

    // No usable ref odds
    return null;
  } catch (err) {
    console.warn("Reference odds fetch error:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function fetchWithSocketIO() {
  if (!SOCKET_URL) {
    throw new Error("WINAMAX_SOCKET_URL non configuré");
  }

  return new Promise<any>((resolve, reject) => {
    const socket = io(SOCKET_URL, {
      path: SOCKET_PATH,
      transports: ["polling"],
      upgrade: false,
      forceNew: true,
      autoConnect: false,
      withCredentials: true,
      query: SOCKET_QUERY ? Object.fromEntries(new URLSearchParams(SOCKET_QUERY)) : undefined,
      extraHeaders: {
        Origin: process.env.WINAMAX_SOCKET_ORIGIN || "https://www.winamax.fr",
        Referer: process.env.WINAMAX_SOCKET_REFERER || "https://www.winamax.fr/",
      },
    });

    const messages: any[] = [];
    const timeout = setTimeout(() => {
      socket.disconnect();
      if (messages.length > 0) {
        resolve(messages);
      } else {
        reject(new Error("Aucune donnée reçue depuis Socket.IO"));
      }
    }, 8000);

    socket.on("connect", () => {
      console.log("Socket.IO connecté à", SOCKET_URL);
    });

    socket.onAny((event, ...args) => {
      messages.push({ event, args });
      console.log("Socket.IO event:", event, args.length, "payload sample:", args[0]);
    });

    socket.on("connect_error", (err) => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(err);
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(err);
    });

    socket.open();
  });
}

function extractJsonFromScript(page: string, marker: string) {
  const startIndex = page.indexOf(marker);
  if (startIndex === -1) return null;
  const jsonStart = page.indexOf("{", startIndex);
  if (jsonStart === -1) return null;

  let depth = 0;
  let inString: string | false = false;
  let escaped = false;
  let jsonEnd = -1;

  for (let i = jsonStart; i < page.length; i++) {
    const ch = page[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = false;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inString = ch;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    }
  }

  if (jsonEnd === -1) return null;
  return page.slice(jsonStart, jsonEnd);
}

async function fetchWinamaxHTML() {
  console.log("Scraping Winamax via PRELOADED_STATE :", WINAMAX_HTML_URL);

  try {
    const res = await axios.get(WINAMAX_HTML_URL, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
    });

    const page = res.data as string;
    const jsonString =
      extractJsonFromScript(page, "var PRELOADED_STATE =") ||
      extractJsonFromScript(page, "window.__INITIAL_STATE__ =") ||
      extractJsonFromScript(page, "window.__STATE__ =");

    if (!jsonString) {
      throw new Error("PRELOADED_STATE introuvable dans la page");
    }

    const state = JSON.parse(jsonString);
    const matchesList: any[] = [];

    // Tenter d'utiliser les mappings de l'état initial
    const sports = state.sports ?? state.sportIds ?? {};
    const allSports = state.sports ?? {};
    const stateMatches = state.matches ?? {};
    const stateBets = state.bets ?? {};
    const stateOdds = state.odds ?? {};

    if (Object.keys(stateMatches).length > 0 && Object.keys(stateBets).length > 0) {
      for (const matchId in stateMatches) {
        const m = stateMatches[matchId];
        if (m.sportId !== 1 || m.status !== "PREMATCH") continue;
        const mainBetId = m.mainBetId;
        const bet = stateBets[mainBetId];
        if (!bet || !bet.outcomes) continue;

        const odds: Record<string, number> = {};
        bet.outcomes.forEach((outcomeId: number, index: number) => {
          const oddValue = stateOdds[outcomeId];
          if (!oddValue) return;
          const label = index === 0 ? "1" : index === 1 ? "N" : "2";
          odds[label] = oddValue;
        });

        const titles = (m.title || "").split(" - ");
        matchesList.push({
          id: String(m.matchId || matchId),
          sport: "Football",
          homeTeam: titles[0]?.trim() || "Equipe A",
          awayTeam: titles[1]?.trim() || "Equipe B",
          time: new Date((m.matchStart ?? Date.now()) * 1000),
          odds,
        });
      }
    }

    if (matchesList.length > 0) {
      return matchesList;
    }

    // Si aucune donnée structurée, essayer de détecter les matchs dans le HTML
    const $ = cheerio.load(page);
    const fallbackMatches: any[] = [];

    $(".event, [data-test-id='event'], [class*='event']").each((_, el) => {
      const $el = $(el);
      const title = $el.find("[class*='match-title'], [data-test-id='match-title']").text().trim();
      const teams = title.split(" - ");
      if (teams.length !== 2) return;

      const odds: Record<string, number> = {};
      const oddTexts = $el.find("[class*='odd'], [data-test-id*='odd']").map((_, o) => $(o).text().trim()).get();
      if (oddTexts.length >= 3) {
        odds["1"] = parseFloat(oddTexts[0].replace(',', '.')) || 0;
        odds["N"] = parseFloat(oddTexts[1].replace(',', '.')) || 0;
        odds["2"] = parseFloat(oddTexts[2].replace(',', '.')) || 0;
      }

      if (odds["1"] && odds["N"] && odds["2"]) {
        fallbackMatches.push({
          id: `${teams[0]}-${teams[1]}`,
          sport: "Football",
          homeTeam: teams[0].trim(),
          awayTeam: teams[1].trim(),
          time: new Date(),
          odds,
        });
      }
    });

    if (fallbackMatches.length > 0) {
      console.log(`HTML fallback matches=${fallbackMatches.length}`);
      return fallbackMatches;
    }

    throw new Error("Aucune donnée de match trouvée dans la page Winamax");
  } catch (error) {
    console.error("❌ Erreur HTML scraping (PRELOADED_STATE) :", error instanceof Error ? error.message : error);
    return [];
  }
}

function normalizeEvents(data: any) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.events)) return data.events;
  if (Array.isArray(data.matches)) return data.matches;
  if (data?.data && Array.isArray(data.data)) return data.data;
  return [data];
}

export async function fetchWinamaxAndStore() {
  try {
    let rawData: any;
    let source = "unknown";

    // Essayer Socket.IO en priorité
    if (SOCKET_URL) {
      try {
        rawData = await fetchWithSocketIO();
        source = "socket";
      } catch (socketError) {
        console.warn("Socket.IO unavailable:", socketError instanceof Error ? socketError.message : socketError);
      }
    }

    // Fallback sur JSON HTTP si configuré
    if (!rawData && JSON_URL) {
      try {
        const res = await axios.get(JSON_URL, { timeout: 15000 });
        rawData = res.data;
        source = "json";
      } catch (jsonError) {
        console.warn("JSON endpoint unavailable:", jsonError instanceof Error ? jsonError.message : jsonError);
      }
    }

    // Fallback sur HTML scraping
    if (!rawData) {
      try {
        const htmlMatches = await fetchWinamaxHTML();
        if (htmlMatches.length > 0) {
          rawData = htmlMatches;
          source = "html";
        }
      } catch (htmlError) {
        console.warn("HTML scraping failed:", htmlError instanceof Error ? htmlError.message : htmlError);
      }
    }

    if (!rawData) {
      throw new Error("Tous les endpoints ont échoué : Socket.IO, JSON, et HTML scraping");
    }

    const events = normalizeEvents(rawData);
    console.log(`Winamax data source=${source}, events=${events.length}`);

    for (const ev of events) {
      if ((ev.sport || ev.sport_name || "").toLowerCase().indexOf("foot") === -1) {
        // Si c'est un match parsé du HTML, créer un événement minimal
        if (!ev.sport && ev.homeTeam && ev.awayTeam) {
          // C'est un match HTML, continuer
        } else {
          continue;
        }
      }

      const winamaxId = String(ev.id ?? ev.eventId ?? ev.homeTeam + "-" + ev.awayTeam).substring(0, 100);
      const home = ev.homeTeam ?? ev.home ?? "Home";
      const away = ev.awayTeam ?? ev.away ?? "Away";
      const startAt = ev.startTime || ev.time || new Date();

      const match = await prisma.match.upsert({
        where: { winamaxId },
        update: {
          homeTeam: home,
          awayTeam: away,
          startAt: typeof startAt === "string" ? new Date(startAt) : startAt,
          sport: "Football",
        },
        create: {
          winamaxId,
          homeTeam: home,
          awayTeam: away,
          startAt: typeof startAt === "string" ? new Date(startAt) : startAt,
          sport: "Football",
        },
      });

      // Créer les cotes
      const markets = ev.markets ?? ev.odds ?? [];
      
      // Si c'est un match HTML avec structure odds simple
      if (ev.odds && typeof ev.odds === "object" && !Array.isArray(ev.odds)) {
        const oddsMap = ev.odds as Record<string, number | null>;
        // Order outcomes as [home, draw, away]
        const priceHome = Number(oddsMap["1"] ?? oddsMap["home"] ?? oddsMap["Home"] ?? 0) || 0;
        const priceDraw = Number(oddsMap["N"] ?? oddsMap["draw"] ?? 0) || 0;
        const priceAway = Number(oddsMap["2"] ?? oddsMap["away"] ?? oddsMap["Away"] ?? 0) || 0;

        const prices = [priceHome, priceDraw, priceAway];
        const valid = prices.every((p) => p > 0);
        if (valid) {
          const winImplied = prices.map(impliedProbFromPrice);
          const winNormalized = normalizeImpliedProbs(winImplied);

          const refPrices = await fetchReferenceOdds(home, away, new Date(startAt));
          let refNormalized: number[] | null = null;
          if (refPrices) {
            const refImplied = refPrices.map(impliedProbFromPrice);
            refNormalized = normalizeImpliedProbs(refImplied);
          } else {
            // No external reference available: be conservative and assume no EV (avoid false positives)
            refNormalized = winNormalized.slice();
          }

          // Persist per outcome
          const labels = ["1", "N", "2"];
          for (let i = 0; i < 3; i++) {
            const outcome = labels[i];
            const price = prices[i];
            const probability = winNormalized[i];
            const evPlus = computeEvPlusPercent(winNormalized[i], refNormalized[i]);
            const refPrice = refPrices ? refPrices[i] : null;
            const refProb = refNormalized ? refNormalized[i] : null;
            const refProvider = REF_ODDS_PROVIDER || (REF_ODDS_API_URL ? new URL(REF_ODDS_API_URL).host : null);

            await prisma.odds.upsert({
              where: { id: `${match.id}-${outcome}` },
              update: { price, probability, evPlus, refPrice, refProvider, refProb },
              create: {
                id: `${match.id}-${outcome}`,
                matchId: match.id,
                provider: "winamax",
                market: "1N2",
                outcome,
                price,
                probability,
                refPrice,
                refProvider,
                refProb,
                evPlus,
              },
            });
          }
        }
      } else {
        // Format structuré
        for (const m of markets) {
          const marketKey = (m.key ?? m.name ?? "").toString();
          const outcomes = m.outcomes ?? m.legs ?? [];

          // Detect 1N2 / Match Result markets to compute normalized probabilities
          if (/1\s?X?N?2|match result|1n2/i.test(marketKey)) {
            // try to extract three prices in order
            const extracted: number[] = [];
            for (const o of outcomes.slice(0, 3)) {
              const price = Number(o.price ?? o.odds ?? o.decimal ?? o.value ?? o) || 0;
              extracted.push(price);
            }
            if (extracted.length === 3 && extracted.every((p) => p > 0)) {
              const winImplied = extracted.map(impliedProbFromPrice);
              const winNormalized = normalizeImpliedProbs(winImplied);

              const refPrices = await fetchReferenceOdds(home, away, new Date(startAt));
              let refNormalized: number[] | null = null;
              if (refPrices) {
                const refImplied = refPrices.map(impliedProbFromPrice);
                refNormalized = normalizeImpliedProbs(refImplied);
              } else {
                refNormalized = winNormalized.slice();
              }

              for (let i = 0; i < 3; i++) {
                const o = outcomes[i];
                const outcomeLabel = o.name ?? o.label ?? `${i + 1}`;
                const price = extracted[i];
                const probability = winNormalized[i];
                const evPlus = computeEvPlusPercent(winNormalized[i], refNormalized[i]);
                const refPrice = refPrices ? refPrices[i] : null;
                const refProb = refNormalized ? refNormalized[i] : null;
                const refProvider = REF_ODDS_PROVIDER || (REF_ODDS_API_URL ? new URL(REF_ODDS_API_URL).host : null);

                await prisma.odds.create({
                  data: {
                    matchId: match.id,
                    provider: "winamax",
                    market: m.key ?? m.name ?? "1N2",
                    outcome: outcomeLabel,
                    price,
                    probability,
                    refPrice,
                    refProvider,
                    refProb,
                    evPlus,
                  },
                });
              }
            }
          } else {
            // Non 1N2 markets: fall back to per-outcome implied probability, no external reference
            for (const o of outcomes) {
              const outcomeLabel = o.name ?? o.label ?? o.key ?? "";
              const price = Number(o.price ?? o.odds ?? o.decimal) || null;
              if (!price) continue;

              const impliedProb = impliedProbFromPrice(price);
              const estimatedProb = impliedProb; // conservative: don't inflate
              const evPlus = 0; // unknown without reference

              await prisma.odds.create({
                data: {
                  matchId: match.id,
                  provider: "winamax",
                  market: m.key ?? m.name ?? "other",
                  outcome: outcomeLabel,
                  price,
                  probability: estimatedProb,
                  evPlus,
                },
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("Erreur fetch/store:", err);
  }
}
