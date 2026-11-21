/**
 * Real Live 3-Agent Adversarial Probability Calibration Engine
 * Supports:
 *   1. OpenAI (`env.OPENAI_API_KEY`)
 *   2. Anthropic (`env.ANTHROPIC_API_KEY`)
 *   3. Cloudflare Workers AI (`env.AI` -> `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) — live 70B GPU inference!
 *
 * Every numeric figure quoted by the model is checked verbatim against raw Polymarket JSON.
 */

import {
  clamp,
  computeKellySizing,
  verifyVerbatimFigures,
} from "../../../packages/core/src/polymarket.js";

const CF_LLAMA_70B = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function hasLiveLlmKey(env) {
  return Boolean(
    (env?.OPENAI_API_KEY && String(env.OPENAI_API_KEY).trim().length > 12) ||
      (env?.ANTHROPIC_API_KEY && String(env.ANTHROPIC_API_KEY).trim().length > 12) ||
      (env?.AI && typeof env.AI.run === "function")
  );
}

export function getActiveModelName(env) {
  if (env?.OPENAI_API_KEY && String(env.OPENAI_API_KEY).trim().length > 12) {
    return env.MODEL || "gpt-4o-mini";
  }
  if (env?.ANTHROPIC_API_KEY && String(env.ANTHROPIC_API_KEY).trim().length > 12) {
    return env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";
  }
  if (env?.AI && typeof env.AI.run === "function") {
    return "llama-3.3-70b-fp8";
  }
  return null;
}

function extractJsonObject(rawText) {
  const cleaned = String(rawText || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1));
    }
    throw new Error("Model did not return valid JSON");
  }
}

async function callJsonLlm(env, { systemPrompt, userPrompt, maxTokens = 1100 }) {
  const openAiKey = env?.OPENAI_API_KEY ? String(env.OPENAI_API_KEY).trim() : "";
  const anthropicKey = env?.ANTHROPIC_API_KEY ? String(env.ANTHROPIC_API_KEY).trim() : "";

  if (openAiKey) {
    const model = env.MODEL || "gpt-4o-mini";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${openAiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(24_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenAI API HTTP ${res.status}: ${errText.slice(0, 180)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    return { parsed: extractJsonObject(content), model };
  }

  if (anthropicKey) {
    const model = env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        system: systemPrompt + "\nReturn ONLY valid JSON with no markdown fences.",
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(24_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Anthropic API HTTP ${res.status}: ${errText.slice(0, 180)}`);
    }
    const data = await res.json();
    const raw = data?.content?.[0]?.text || "{}";
    return { parsed: extractJsonObject(raw), model };
  }

  if (env?.AI && typeof env.AI.run === "function") {
    const out = await env.AI.run(CF_LLAMA_70B, {
      messages: [
        { role: "system", content: systemPrompt + "\nRespond ONLY with a valid JSON object. No markdown fences." },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    });
    const raw =
      typeof out?.response === "string"
        ? out.response
        : out?.response && typeof out.response === "object"
          ? JSON.stringify(out.response)
          : JSON.stringify(out || {});
    return { parsed: extractJsonObject(raw), model: "llama-3.3-70b" };
  }

  throw new Error("Live LLM provider is not configured on this worker.");
}

export async function runThreeAgentCalibration(env, market) {
  const upstreamContext = {
    question: market.question,
    eventTitle: market.eventTitle,
    domain: market.domain.label,
    crowdProbPct: Number((market.crowdProb * 100).toFixed(2)),
    actuarialPriorPct: Number((market.fairProb * 100).toFixed(2)),
    bestBid: market.bestBid,
    bestAsk: market.bestAsk,
    spreadPct: Number((market.spread * 100).toFixed(2)),
    volume24hUsd: market.volume24hUsd,
    liquidityUsd: market.liquidityUsd,
    oneDayChangePct: Number((market.oneDayChange * 100).toFixed(2)),
    daysToResolution: market.daysToResolution,
    endDate: market.endDate,
    resolutionSource: market.resolutionSource,
    resolutionRules: (market.description || "").slice(0, 1600),
    siblingCoherence: market.siblingCoherence,
    detectedTraps: market.ruleTraps.map((t) => ({ code: t.code, title: t.title })),
  };

  const systemPrompt = `You are KALIBR, a Swiss actuarial 3-agent superforecasting panel calibrating live Polymarket binary contracts.
CRITICAL VERBATIM RULE: Every market figure you cite in "verbatimQuotes" MUST match the exact numbers in the provided upstream JSON (crowdProbPct, spreadPct, volume24hUsd, liquidityUsd, oneDayChangePct, daysToResolution, or exact phrases from resolutionRules). Never invent external statistics.

Return a JSON object with this exact schema:
{
  "baseRateAgent": {
    "headline": "concise 6-10 word base-rate & microstructure takeaway",
    "analysis": "2-3 crisp sentences analyzing reference-class base rate, sibling bracket coherence, and orderbook flow.",
    "verbatimQuotes": ["2-3 short factual strings quoting exact numbers from the JSON, e.g. 'Crowd YES at 58.0% on $480,000 24h volume'"]
  },
  "trapDevilAgent": {
    "headline": "concise 6-10 word resolution-rule or liquidity risk warning",
    "analysis": "2-3 crisp sentences explaining exact fine-print resolution traps, timezone/definition cutoffs, or spread hazards.",
    "riskLevel": "LOW" | "MEDIUM" | "HIGH"
  },
  "chiefForecaster": {
    "fairProbPct": number between 1.0 and 99.0,
    "confidencePct": number between 45 and 95,
    "thesis": "2 crisp sentences stating why the crowd is mispriced or efficient and the exact sizing posture.",
    "invalidationTrigger": "1 concrete real-world event or orderbook shift that invalidates this forecast."
  }
}`;

  const { parsed, model } = await callJsonLlm(env, {
    systemPrompt,
    userPrompt: `Calibrate this live Polymarket contract:\n${JSON.stringify(upstreamContext, null, 2)}`,
    maxTokens: 1000,
  });

  const rawFairPct = Number(parsed?.chiefForecaster?.fairProbPct);
  const fairProb = Number.isFinite(rawFairPct)
    ? Number(clamp(rawFairPct / 100, 0.008, 0.992).toFixed(4))
    : market.fairProb;

  const rawConfPct = Number(parsed?.chiefForecaster?.confidencePct);
  const confidence = Number.isFinite(rawConfPct)
    ? Number(clamp(rawConfPct / 100, 0.45, 0.95).toFixed(2))
    : market.confidence;

  const edgeProb = Number((fairProb - market.crowdProb).toFixed(4));
  const edgeBps = Math.round(edgeProb * 10_000);
  const kelly = computeKellySizing({
    fairProb,
    crowdProb: market.crowdProb,
    spread: market.spread,
    bankrollUsd: 1000,
  });

  let direction = "NO_EDGE";
  if (market.spread >= 0.06 && Math.abs(edgeBps) < Math.round(market.spread * 10_000)) {
    direction = "PASS_SPREAD";
  } else if (edgeBps >= 220 && kelly.netEdgeAfterSpread > 0.01) {
    direction = "BUY_YES";
  } else if (edgeBps <= -220 && kelly.netEdgeAfterSpread > 0.01) {
    direction = "BUY_NO";
  }

  const quotes = Array.isArray(parsed?.baseRateAgent?.verbatimQuotes)
    ? parsed.baseRateAgent.verbatimQuotes
    : [];
  const verbatimCheck = verifyVerbatimFigures(quotes, { ...market, fairProb });

  return {
    marketId: market.marketId,
    eventSlug: market.eventSlug,
    question: market.question,
    crowdProb: market.crowdProb,
    fairProb,
    edgeBps,
    direction,
    confidence,
    kelly,
    modelName: model,
    baseRateAgent: {
      headline: String(parsed?.baseRateAgent?.headline || "Reference-Class & Orderbook Audit"),
      analysis: String(parsed?.baseRateAgent?.analysis || ""),
      verbatimQuotes: quotes,
    },
    trapDevilAgent: {
      headline: String(parsed?.trapDevilAgent?.headline || "Resolution Fine-Print Inspection"),
      analysis: String(parsed?.trapDevilAgent?.analysis || ""),
      riskLevel: ["LOW", "MEDIUM", "HIGH"].includes(parsed?.trapDevilAgent?.riskLevel)
        ? parsed.trapDevilAgent.riskLevel
        : "MEDIUM",
    },
    chiefForecaster: {
      fairProbPct: Number((fairProb * 100).toFixed(1)),
      confidencePct: Math.round(confidence * 100),
      thesis: String(parsed?.chiefForecaster?.thesis || ""),
      invalidationTrigger: String(parsed?.chiefForecaster?.invalidationTrigger || ""),
    },
    verbatimCheck,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

export async function runChiefFollowUpChat(env, { market, dossier, question }) {
  const systemPrompt = `You are the KALIBR Chief Superforecaster answering a trader's specific question about a live Polymarket contract.
Stay surgical, quantitative, and strictly grounded in the provided market data and resolution rules (3-5 sentences max). Never fabricate external statistics. Return JSON: { "answer": "...", "actionPosture": "BUY_YES" | "BUY_NO" | "WAIT_LIMIT" | "PASS" }`;

  const payload = {
    question: market.question,
    crowdProbPct: Number((market.crowdProb * 100).toFixed(1)),
    calibratedFairProbPct: Number(((dossier?.fairProb ?? market.fairProb) * 100).toFixed(1)),
    spreadPct: Number((market.spread * 100).toFixed(2)),
    volume24hUsd: market.volume24hUsd,
    liquidityUsd: market.liquidityUsd,
    daysToResolution: market.daysToResolution,
    resolutionRules: (market.description || "").slice(0, 1200),
    ruleTraps: market.ruleTraps,
    userQuestion: String(question || "").slice(0, 500),
  };

  const { parsed, model } = await callJsonLlm(env, {
    systemPrompt,
    userPrompt: JSON.stringify(payload),
    maxTokens: 450,
  });

  return {
    answer: String(parsed?.answer || "Unable to produce calibrated answer."),
    actionPosture: String(parsed?.actionPosture || "PASS"),
    model,
  };
}
