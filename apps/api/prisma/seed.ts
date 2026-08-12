import { PrismaClient } from "../src/generated/prisma/client.js";

const prisma = new PrismaClient();

async function main() {
  await prisma.setting.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });

  const run = await prisma.pipelineRun.create({
    data: {
      topic: "outdoor/hunting/shooting sports retail",
      maxArticles: 10,
      maxDrafts: 10,
      maxSends: 5,
      status: "COMPLETED",
      startedAt: new Date("2026-08-10T14:00:00Z"),
      completedAt: new Date("2026-08-10T14:12:00Z"),
    },
  });

  await prisma.article.create({
    data: {
      pipelineRunId: run.id,
      url: "https://www.example-outdoorwire.test/articles/best-treestands-2026",
      title: "The Best Treestands of 2026, Tested",
      sourceDomain: "example-outdoorwire.test",
      status: "EXTRACTED",
      discoveredAt: new Date("2026-08-10T14:01:00Z"),
      author: {
        create: {
          name: "Casey Marsh",
          extractionMethod: "JSON_LD",
          confidence: 0.95,
          profileUrl: "https://www.example-outdoorwire.test/authors/casey-marsh",
          contactAttempts: {
            create: [
              {
                method: "CONTACT_PAGE_SCAN",
                emailCandidate: "casey.marsh@example-outdoorwire.test",
                confidence: 0.9,
                status: "FOUND",
              },
            ],
          },
        },
      },
    },
  });

  await prisma.article.create({
    data: {
      pipelineRunId: run.id,
      url: "https://www.example-fieldjournal.test/gear/duck-call-roundup",
      title: "2026 Duck Call Roundup: Six Worth Your Money",
      sourceDomain: "example-fieldjournal.test",
      status: "EXTRACTED",
      discoveredAt: new Date("2026-08-10T14:02:00Z"),
      author: {
        create: {
          name: "Jordan Whitfield",
          extractionMethod: "BYLINE_PATTERN",
          confidence: 0.72,
          contactAttempts: {
            create: [
              {
                method: "EMAIL_PATTERN_GUESS",
                emailCandidate: "jwhitfield@example-fieldjournal.test",
                confidence: 0.4,
                status: "NEEDS_REVIEW",
              },
              {
                method: "OUTLET_FALLBACK",
                emailCandidate: "editor@example-fieldjournal.test",
                confidence: 0.55,
                status: "OUTLET_FALLBACK",
              },
            ],
          },
        },
      },
    },
  });

  await prisma.article.create({
    data: {
      pipelineRunId: run.id,
      url: "https://www.example-rangereport.test/reviews/red-dot-optics",
      title: "Red Dot Optics Head-to-Head: Which One Holds Zero?",
      sourceDomain: "example-rangereport.test",
      status: "EXTRACTED",
      discoveredAt: new Date("2026-08-10T14:03:00Z"),
      author: {
        create: {
          name: "Alex Doyle",
          extractionMethod: "STAFF_PAGE",
          confidence: 0.61,
          profileUrl: "https://www.example-rangereport.test/staff/alex-doyle",
          contactAttempts: {
            create: [
              {
                method: "CONTACT_PAGE_SCAN",
                emailCandidate: null,
                confidence: 0.1,
                status: "FAILED",
              },
            ],
          },
        },
      },
    },
  });

  await prisma.article.create({
    data: {
      pipelineRunId: run.id,
      url: "https://www.example-backcountrybuzz.test/news/public-land-access-bill",
      title: "New Bill Would Expand Public Land Hunting Access",
      sourceDomain: "example-backcountrybuzz.test",
      status: "EXTRACTED",
      discoveredAt: new Date("2026-08-10T14:04:00Z"),
      author: {
        create: {
          name: null,
          extractionMethod: "NONE",
          confidence: 0.0,
          contactAttempts: {
            create: [
              {
                method: "OUTLET_FALLBACK",
                emailCandidate: "tips@example-backcountrybuzz.test",
                confidence: 0.5,
                status: "OUTLET_FALLBACK",
              },
            ],
          },
        },
      },
    },
  });

  await prisma.article.create({
    data: {
      pipelineRunId: run.id,
      url: "https://www.example-huntandhome.test/blog/scouting-with-trail-cams",
      title: "Scouting Season: Getting the Most from Trail Cams",
      sourceDomain: "example-huntandhome.test",
      status: "FAILED",
      discoveredAt: new Date("2026-08-10T14:05:00Z"),
    },
  });

  console.log("Seed complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
