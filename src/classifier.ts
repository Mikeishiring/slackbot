import Anthropic from "@anthropic-ai/sdk";

import type { AdverseClassifier } from "./connectors.js";

const CLASSIFICATION_PROMPT = `You are a compliance screening assistant. Classify each search result about a company as one of:
- "enforcement": Government enforcement action, SEC filing, CFTC order, regulatory fine, sanctions
- "litigation": Actual lawsuit, court filing, legal complaint against the company
- "noise": Opinion post, review, Reddit/forum discussion, "is X a scam?" article, educational content
- "unclear": Cannot determine from title and snippet alone

For each result, respond with a JSON array of objects: [{"url": "...", "classification": "...", "reason": "brief reason"}]

Be strict: only "enforcement" or "litigation" for results that clearly reference official legal or regulatory actions. Everything else is "noise" or "unclear".`;

export class AnthropicAdverseClassifier implements AdverseClassifier {
  private readonly client: Anthropic;
  private readonly model: string;

  public constructor(apiKey: string, model = "claude-opus-4-6-20260205") {
    this.client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 1 });
    this.model = model;
  }

  public async classify(
    counterpartyName: string,
    results: Array<{ title: string; snippet: string; url: string }>
  ): Promise<
    Array<{
      url: string;
      classification: "enforcement" | "litigation" | "noise" | "unclear";
      reason: string;
    }>
  > {
    if (results.length === 0) {
      return [];
    }

    const resultsText = results
      .map(
        (result, index) =>
          `${index + 1}. Title: ${result.title}\n   Snippet: ${result.snippet}\n   URL: ${result.url}`
      )
      .join("\n\n");

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: `Company being screened: ${counterpartyName}\n\nClassify these search results:\n\n${resultsText}`,
          },
        ],
        system: CLASSIFICATION_PROMPT,
      });

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => {
          if (block.type === "text") {
            return block.text;
          }
          return "";
        })
        .join("");

      const jsonMatch = /\[[\s\S]*\]/.exec(text);
      if (!jsonMatch) {
        return results.map((result) => ({
          url: result.url,
          classification: "unclear" as const,
          reason: "Classification response was not parseable.",
        }));
      }

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        url?: string;
        classification?: string;
        reason?: string;
      }>;

      return parsed.map((item, index) => ({
        url: item.url ?? results[index]?.url ?? "",
        classification: isValidClassification(item.classification)
          ? item.classification
          : "unclear",
        reason: typeof item.reason === "string" ? item.reason : "",
      }));
    } catch (error) {
      console.error("Adverse classification failed", error);
      return results.map((result) => ({
        url: result.url,
        classification: "unclear" as const,
        reason: "Classification API call failed.",
      }));
    }
  }
}

function isValidClassification(
  value: unknown
): value is "enforcement" | "litigation" | "noise" | "unclear" {
  return (
    value === "enforcement" ||
    value === "litigation" ||
    value === "noise" ||
    value === "unclear"
  );
}
