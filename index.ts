/**
 * OmniRoute Client Budget & Quota Manager Plugin
 *
 * Per-client budget enforcement and quota tracking.
 * Blocks requests when budget/quota exceeded.
 *
 * Usage:
 *   1. Copy to your OmniRoute plugins directory
 *   2. Edit clients.json with your clients and limits
 *   3. Add x-client-id header to requests OR use API key to identify client
 *   4. Reload OmniRoute — plugin auto-activates
 *
 * Install:
 *   Place in ~/.omniroute/plugins/client-budget/
 *   Or via dashboard: Settings → Plugins → Upload
 */

import { definePlugin, blockRequest } from "omniroute/plugins/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// ── Config ──────────────────────────────────────────────────────────

interface ClientLimit {
  budgetMonthly: number;    // USD por mês
  budgetDaily?: number;    // USD por dia (opcional)
  quotaMonthly: number;     // requests por mês
  quotaDaily?: number;      // requests por dia (opcional)
}

interface ClientConfig {
  name: string;
  limits: ClientLimit;
  notifyAt?: number;        // % do budget pra alertar (default: 80)
  webhookUrl?: string;      // URL pra notificar quando estourar
  blocked?: boolean;        // client bloqueado manualmente
}

interface ClientsDB {
  [clientId: string]: {
    config: ClientConfig;
    usage: {
      monthlyRequests: number;
      monthlyCost: number;
      dailyRequests: number;
      dailyCost: number;
      lastRequest: string;   // ISO date
      lastReset: string;     // ISO date do último reset mensal
    };
  };
}

// ── Model pricing (USD por 1M tokens input/output) ───────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-opus-4":       { input: 15,    output: 75   },
  "claude-sonnet-4":     { input: 3,     output: 15   },
  "claude-sonnet-3-5":   { input: 3,     output: 15   },
  "claude-sonnet-3-7":   { input: 3,     output: 15   },
  "claude-haiku-3":      { input: 0.8,   output: 4    },
  "claude-3-5-sonnet":   { input: 3,     output: 15   },
  "claude-3-opus":       { input: 15,    output: 75   },
  "claude-3-sonnet":     { input: 3,     output: 15   },
  "claude-3-haiku":      { input: 0.8,   output: 4    },
  // OpenAI
  "gpt-4o":              { input: 2.5,   output: 10   },
  "gpt-4o-mini":         { input: 0.15,  output: 0.6  },
  "gpt-4-turbo":        { input: 10,    output: 30   },
  "gpt-3.5-turbo":      { input: 0.5,   output: 1.5  },
  // Google
  "gemini-2.5-pro":      { input: 1.25,  output: 5    },
  "gemini-2.5-flash":    { input: 0.075, output: 0.3 },
  "gemini-2.0-flash":    { input: 0.075, output: 0.3 },
  // Meta
  "llama-3-70b":         { input: 0.9,   output: 0.9  },
  "llama-3-8b":          { input: 0.2,   output: 0.2  },
  // Groq
  "mixtral-8x7b":        { input: 0.24,  output: 0.24 },
  "llama-3-8b":          { input: 0.05,  output: 0.08 },
  // Default
  "default":             { input: 1,     output: 5    },
};

// ── Helpers ──────────────────────────────────────────────────────

function getModelPricing(model: string): { input: number; output: number } {
  const normalized = model.toLowerCase().replace(/:/g, "-");
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (normalized.includes(key.toLowerCase())) return price;
  }
  return MODEL_PRICING["default"];
}

function estimateTokens(messages: unknown[]): { inputTokens: number; outputTokens: number } {
  // Rough estimate: ~4 chars per token, system messages ~2x
  let total = 0;
  for (const msg of messages as Record<string, string>[]) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    total += content.length * 0.25; // chars → tokens
    if (msg.role === "system") total += 100; // system msgs overhead
  }
  return {
    inputTokens: Math.round(total),
    outputTokens: Math.round(total * 0.4), // output typically smaller
  };
}

function estimateCost(model: string, messages: unknown[]): number {
  const pricing = getModelPricing(model);
  const { inputTokens, outputTokens } = estimateTokens(messages);
  return (inputTokens / 1_000_000) * pricing.input
       + (outputTokens / 1_000_000) * pricing.output;
}

function now(): string {
  return new Date().toISOString();
}

function resetIfNewMonth(lastReset: string): boolean {
  const prev = new Date(lastReset);
  const curr = new Date();
  return prev.getMonth() !== curr.getMonth() || prev.getFullYear() !== curr.getFullYear();
}

function resetIfNewDay(lastRequest: string): boolean {
  const prev = new Date(lastRequest);
  const curr = new Date();
  return prev.toDateString() !== curr.toDateString();
}

function getClientId(ctx: { body: unknown; metadata: Record<string, unknown> }): string {
  // Priority: x-client-id header → apiKeyInfo → metadata.clientId → "default"
  const body = ctx.body as Record<string, unknown>;
  const headers = (body.headers as Record<string, string> | undefined) || {};
  const metaClientId = ctx.metadata["clientId"] as string | undefined;

  return (
    headers["x-client-id"] ||
    metaClientId ||
    (ctx.metadata["apiKeyInfo"] as Record<string, string>)?.clientId ||
    "default"
  );
}

// ── Storage ───────────────────────────────────────────────────────

const DB_PATH = join(process.cwd(), "data", "client-budget-db.json");

function loadDB(): ClientsDB {
  try {
    if (existsSync(DB_PATH)) {
      return JSON.parse(readFileSync(DB_PATH, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveDB(db: ClientsDB): void {
  try {
    const dir = join(process.cwd(), "data");
    if (!existsSync(dir)) return;
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch { /* ignore */ }
}

// ── Notification ─────────────────────────────────────────────────

async function notify(clientName: string, message: string, webhookUrl?: string): Promise<void> {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: clientName, message, timestamp: now() }),
    });
  } catch { /* silent */ }
}

// ── Plugin ────────────────────────────────────────────────────────

// Config inline (substitua pelo path real em produção)
const CLIENTS: Record<string, ClientConfig> = {
  bepex: {
    name: "BEPEX",
    limits: { budgetMonthly: 500, quotaMonthly: 5000 },
    notifyAt: 80,
    webhookUrl: undefined, // "https://vps02.lab-pedro.com.br/api/webhook" ou Telegram
  },
  meulance: {
    name: "Meu Lance",
    limits: { budgetMonthly: 300, quotaMonthly: 3000, budgetDaily: 30 },
    notifyAt: 80,
  },
  assistencia: {
    name: "Assistência Hospitalar",
    limits: { budgetMonthly: 200, quotaMonthly: 2000 },
    notifyAt: 90,
  },
};

export default definePlugin({
  name: "client-budget",

  // ── onRequest: validate budget + quota BEFORE request ──────────
  onRequest: async (ctx) => {
    const clientId = getClientId(ctx);
    const client = CLIENTS[clientId];

    if (!client) return; // client sem config — libera

    if (client.blocked) {
      return blockRequest({
        error: {
          code: 403,
          message: `Cliente ${client.name} bloqueado. Contate o administrador.`,
        },
      });
    }

    const db = loadDB();
    const nowStr = now();

    // Ensure client record
    if (!db[clientId]) {
      db[clientId] = { config: client, usage: { monthlyRequests: 0, monthlyCost: 0, dailyRequests: 0, dailyCost: 0, lastRequest: nowStr, lastReset: nowStr } };
    }

    const usage = db[clientId].usage;

    // Reset if new month/day
    if (resetIfNewMonth(usage.lastReset)) {
      usage.monthlyRequests = 0;
      usage.monthlyCost = 0;
      usage.lastReset = nowStr;
    }
    if (resetIfNewDay(usage.lastRequest)) {
      usage.dailyRequests = 0;
      usage.dailyCost = 0;
    }

    const { budgetMonthly, budgetDaily, quotaMonthly, quotaDaily } = client.limits;
    const estimated = estimateCost(ctx.model, (ctx.body as Record<string, unknown>)?.messages as unknown[] || []);

    // ── Budget check ──
    if (usage.monthlyCost + estimated > budgetMonthly) {
      await notify(client.name, `⚠️ Budget mensal excedido (${usage.monthlyCost.toFixed(2)}/${budgetMonthly})`, client.webhookUrl);
      return blockRequest({
        error: {
          code: 429,
          message: `Budget mensal excedido para ${client.name} (${budgetMonthly} USD). Reset: dia 1º do mês.`,
          client: clientId,
          used: usage.monthlyCost,
          limit: budgetMonthly,
        },
      });
    }

    if (budgetDaily && usage.dailyCost + estimated > budgetDaily) {
      return blockRequest({
        error: {
          code: 429,
          message: `Budget diário excedido para ${client.name} (${budgetDaily} USD). Reset: meia-noite.`,
          client: clientId,
          used: usage.dailyCost,
          limit: budgetDaily,
        },
      });
    }

    // ── Quota check ──
    if (usage.monthlyRequests + 1 > quotaMonthly) {
      await notify(client.name, `⚠️ Quota mensal excedida (${usage.monthlyRequests}/${quotaMonthly} requests)`, client.webhookUrl);
      return blockRequest({
        error: {
          code: 429,
          message: `Quota de requests mensal excedida para ${client.name} (${quotaMonthly}). Reset: dia 1º do mês.`,
          client: clientId,
          used: usage.monthlyRequests,
          limit: quotaMonthly,
        },
      });
    }

    if (quotaDaily && usage.dailyRequests + 1 > quotaDaily) {
      return blockRequest({
        error: {
          code: 429,
          message: `Quota diária excedida para ${client.name} (${quotaDaily} requests). Reset: meia-noite.`,
          client: clientId,
          used: usage.dailyRequests,
          limit: quotaDaily,
        },
      });
    }

    // ── Early warning ──
    const spendPct = ((usage.monthlyCost + estimated) / budgetMonthly) * 100;
    if (spendPct >= (client.notifyAt || 80)) {
      await notify(client.name, `📊 Budget ${spendPct.toFixed(0)}% usado (${(usage.monthlyCost + estimated).toFixed(2)}/${budgetMonthly} USD)`, client.webhookUrl);
    }

    // Store clientId in metadata for onResponse
    ctx.metadata["_budgetClientId"] = clientId;
    ctx.metadata["_budgetEstimate"] = estimated;

    return; // proceed
  },

  // ── onResponse: update usage ───────────────────────────────────
  onResponse: async (ctx, response) => {
    const clientId = ctx.metadata["_budgetClientId"] as string | undefined;
    if (!clientId || !CLIENTS[clientId]) return response;

    const estimated = ctx.metadata["_budgetEstimate"] as number || 0;

    // Try to get actual cost from response
    const resp = response as Record<string, unknown>;
    const usageMeta = resp?.usage as Record<string, number> | undefined;
    const actualCost = estimated; // fallback

    const db = loadDB();
    const usage = db[clientId]?.usage;
    if (!usage) return response;

    usage.monthlyRequests += 1;
    usage.monthlyCost = parseFloat((usage.monthlyCost + actualCost).toFixed(6));
    usage.dailyRequests += 1;
    usage.dailyCost = parseFloat((usage.dailyCost + actualCost).toFixed(6));
    usage.lastRequest = now();

    saveDB(db);
    return response;
  },

  // ── onError: log + notify on quota/budget errors ──────────────
  onError: async (ctx, error) => {
    const clientId = getClientId(ctx);
    const client = CLIENTS[clientId];
    if (client) {
      await notify(client.name, `❌ Erro no request: ${error.message}`, client.webhookUrl);
    }
  },
});
