import express from "express";
import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import { fetchWinamaxAndStore } from "./scraper";
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
