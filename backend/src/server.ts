import express from "express";
import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import { fetchWinamaxAndStore } from "./scraper";
import xgService from "./xgService";
import importXg from "../scripts/import_xg_from_url";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

async function startServer() {
  try {
    await prisma.$connect();
    console.log("Prisma connected to database");
  } catch (err) {
    console.error("Prisma connection failed:", err instanceof Error ? err.message : err);
  }

  // Cron toutes les 5 minutes
  cron.schedule("*/5 * * * *", () => {
    console.log(new Date().toISOString(), "Lancement du scrape Winamax (cron)");
    fetchWinamaxAndStore();
  });

  // Route API simple
  app.get("/api/matches", async (req, res) => {
    try {
      const matches = await prisma.match.findMany({
        where: { sport: "Football" },
        include: { odds: true },
        orderBy: { startAt: "asc" },
      });
      res.json(matches);
    } catch (err) {
      console.error("API /api/matches failed:", err);
      res.status(500).json({
        error: "Erreur serveur",
        details: process.env.NODE_ENV === "development" && err instanceof Error ? err.message : undefined,
      });
    }
  });

  // xG service endpoints
  app.get("/api/xg", async (req, res) => {
    try {
      const home = String(req.query.home || "");
      const away = String(req.query.away || "");
      if (!home || !away) return res.status(400).json({ error: "home and away query parameters are required" });
      const est = xgService.estimateXgForMatch(home, away);
      res.json(est);
    } catch (err) {
      console.error("/api/xg error:", err);
      res.status(500).json({ error: "xg estimation failed" });
    }
  });

  app.use(express.json());
  // Admin: upsert a team stat
  app.post("/api/xg", async (req, res) => {
    try {
      const { team, home_xg, away_xg } = req.body;
      if (!team || home_xg == null || away_xg == null) return res.status(400).json({ error: "team, home_xg and away_xg are required" });
      const ok = xgService.upsertTeamStats(team, Number(home_xg), Number(away_xg));
      if (!ok) return res.status(500).json({ error: "failed to save" });
      res.json({ ok: true });
    } catch (err) {
      console.error("POST /api/xg failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  app.get("/api/xg/stats", async (req, res) => {
    try {
      const stats = xgService.listTeamStats();
      res.json(stats);
    } catch (err) {
      console.error("GET /api/xg/stats failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // Admin: import xG stats from a public URL (CSV or JSON). Body: { url }
  app.post("/api/xg/import", async (req, res) => {
    try {
      const { url } = req.body;
      const src = url || process.env.XG_SOURCE_URL;
      if (!src) return res.status(400).json({ error: "url is required in body or set XG_SOURCE_URL env" });
      const ok = await importXg.importFromUrl(src);
      if (!ok) return res.status(500).json({ error: "import failed" });
      res.json({ ok: true });
    } catch (err) {
      console.error("POST /api/xg/import failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // Route de test pour remplir la base avec des données mockées
  app.post("/api/test-seed", async (req, res) => {
    try {
      // Vider les odds et matchs existants
      await prisma.odds.deleteMany({});
      await prisma.match.deleteMany({});

      // Créer des matchs de test
      const now = new Date();
      const testMatches = [
        {
          winamaxId: "match-001",
          homeTeam: "PSG",
          awayTeam: "Marseille",
          startAt: new Date(now.getTime() + 1 * 60 * 60 * 1000),
        },
        {
          winamaxId: "match-002",
          homeTeam: "Nice",
          awayTeam: "Monaco",
          startAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
        },
        {
          winamaxId: "match-003",
          homeTeam: "Lyon",
          awayTeam: "Lille",
          startAt: new Date(now.getTime() + 3 * 60 * 60 * 1000),
        },
      ];

      for (const m of testMatches) {
        const match = await prisma.match.create({
          data: {
            winamaxId: m.winamaxId,
            homeTeam: m.homeTeam,
            awayTeam: m.awayTeam,
            startAt: m.startAt,
            sport: "Football",
          },
        });

        // Ajouter des cotes 1N2 (1 = victoire domicile, N = nul, 2 = victoire extérieur)
        const cotes = [
          { outcome: "1", price: 1.85, evPlus: 5.2 },
          { outcome: "N", price: 3.6, evPlus: 2.1 },
          { outcome: "2", price: 4.2, evPlus: -1.5 },
        ];

        for (const c of cotes) {
          const impliedProb = 1 / c.price;
          await prisma.odds.create({
            data: {
              matchId: match.id,
              provider: "winamax",
              market: "1N2",
              outcome: c.outcome,
              price: c.price,
              probability: impliedProb,
              evPlus: c.evPlus,
            },
          });
        }
      }

      res.json({ message: "Base de données remplie avec 3 matchs de test", count: testMatches.length });
    } catch (err) {
      console.error("Test seed failed:", err);
      res.status(500).json({ error: "Erreur lors du seed" });
    }
  });

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`\nEndpoints disponibles :`);
    console.log(`  GET  http://localhost:${PORT}/api/matches        - Récupérer les matchs`);
    console.log(`  POST http://localhost:${PORT}/api/test-seed      - Remplir la base avec des données de test`);
    // Lancer une première exécution au démarrage
    fetchWinamaxAndStore();
  });
}

startServer();
