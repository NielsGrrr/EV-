import fs from "fs";
import path from "path";

const DATA_PATH = process.env.XG_TEAM_STATS_JSON || path.join(__dirname, "..", "data", "xg_team_stats.json");
const ALIASES_PATH = process.env.XG_ALIASES_JSON || path.join(__dirname, "..", "data", "xg_aliases.json");

type TeamStats = Record<string, { home_xg: number; away_xg: number }>;
type AliasMap = Record<string, string>; // variant(lowercase) -> canonical(lowercase)

function loadStats(): TeamStats {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const raw = fs.readFileSync(DATA_PATH, "utf8");
      const parsed = JSON.parse(raw) as TeamStats;
      return parsed || {};
    }
  } catch (err) {
    console.warn("Could not load xg team stats:", err instanceof Error ? err.message : err);
  }
  return {};
}

function saveStats(stats: TeamStats) {
  try {
    const dir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(stats, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("Failed to save xg stats:", err instanceof Error ? err.message : err);
    return false;
  }
}

// Simple estimation: prefer team-specific stats, otherwise use league averages
export function estimateXgForMatch(home: string, away: string) {
  const stats = loadStats();
  const aliases = loadAliases();
  const leagueHomeAvg = Number(process.env.XG_LEAGUE_HOME_AVG ?? 1.55);
  const leagueAwayAvg = Number(process.env.XG_LEAGUE_AWAY_AVG ?? 1.15);

  const clean = (s: string) => s.trim().toLowerCase();
  // resolve aliases to canonical keys
  const resolve = (name: string) => {
    const key = clean(name);
    if (aliases && aliases[key]) return aliases[key];
    return key;
  };

  const h = resolve(home);
  const a = resolve(away);

  const homeStat = stats[h];
  const awayStat = stats[a];

  const home_xg = homeStat ? Number(homeStat.home_xg) : leagueHomeAvg;
  const away_xg = awayStat ? Number(awayStat.away_xg) : leagueAwayAvg;

  return { home_xg: Number(home_xg), away_xg: Number(away_xg), source: fs.existsSync(DATA_PATH) ? "local_stats" : "league_avg", resolved: { home: h, away: a } };
}

function loadAliases(): AliasMap {
  try {
    if (fs.existsSync(ALIASES_PATH)) {
      const raw = fs.readFileSync(ALIASES_PATH, "utf8");
      const parsed = JSON.parse(raw) as AliasMap;
      return parsed || {};
    }
  } catch (err) {
    console.warn("Could not load xg aliases:", err instanceof Error ? err.message : err);
  }
  return {};
}

export function listTeamStats() {
  return loadStats();
}

export function upsertTeamStats(team: string, home_xg: number, away_xg: number) {
  const stats = loadStats();
  stats[team.trim().toLowerCase()] = { home_xg: Number(home_xg), away_xg: Number(away_xg) };
  return saveStats(stats);
}

export function replaceStats(newStats: TeamStats) {
  return saveStats(newStats);
}

export default { estimateXgForMatch, listTeamStats, upsertTeamStats, replaceStats };
