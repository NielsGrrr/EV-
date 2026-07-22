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
        for (const [outcome, price] of Object.entries(oddsMap)) {
          if (!price || price === 0) continue;

          const impliedProb = 1 / price;
          const estimatedProb = impliedProb * 1.02;
          const evPlus = (estimatedProb - impliedProb) * 100;

          await prisma.odds.upsert({
            where: {
              id: `${match.id}-${outcome}`,
            },
            update: {
              price,
              probability: estimatedProb,
              evPlus,
            },
            create: {
              id: `${match.id}-${outcome}`,
              matchId: match.id,
              provider: "winamax",
              market: "1N2",
              outcome,
              price,
              probability: estimatedProb,
              evPlus,
            },
          });
        }
      } else {
        // Format structuré
        for (const m of markets) {
          const outcomes = m.outcomes ?? m.legs ?? [];
          for (const o of outcomes) {
            const outcomeLabel = o.name ?? o.label ?? "1";
            const price = Number(o.price ?? o.odds ?? o.decimal) || null;
            if (!price) continue;

            const impliedProb = 1 / price;
            const estimatedProb = impliedProb * 1.02;
            const evPlus = (estimatedProb - impliedProb) * 100;

            await prisma.odds.create({
              data: {
                matchId: match.id,
                provider: "winamax",
                market: m.key ?? m.name ?? "1N2",
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
  } catch (err) {
    console.error("Erreur fetch/store:", err);
  }
}
