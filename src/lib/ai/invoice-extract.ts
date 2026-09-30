import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";

/** What we ask the model to read off a vendor invoice. Nothing here is written to the books without a person confirming it. */
export const InvoiceSchema = z.object({
  vendor_name: z.string().nullable(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable().describe("YYYY-MM-DD"),
  lines: z.array(z.object({
    vendor_item_number: z.string().nullable(),
    description: z.string(),
    quantity: z.number().nullable(),
    unit: z.string().nullable().describe("e.g. CS, CASE, LB, EA as printed"),
    unit_price: z.number().nullable(),
    extended_price: z.number().nullable(),
  })),
  tax: z.number().nullable(),
  freight: z.number().nullable(),
  fuel_surcharge: z.number().nullable(),
  misc_fees: z.number().nullable(),
  credits: z.number().nullable().describe("Total credits as a positive number"),
  total: z.number().nullable(),
  notes: z.string().nullable().describe("Anything unreadable or ambiguous the reviewer should check"),
});
export type ExtractedInvoice = z.infer<typeof InvoiceSchema>;

export function invoiceScannerConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function extractInvoice(file: { base64: string; mediaType: string }): Promise<{ invoice: ExtractedInvoice; model: string }> {
  const client = new Anthropic();
  const isPdf = file.mediaType === "application/pdf";
  const source = isPdf
    ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: file.base64 } }
    : { type: "image" as const, source: { type: "base64" as const, media_type: file.mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: file.base64 } };
  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: "You read restaurant food-distributor invoices. Transcribe exactly what is printed; never guess a value you cannot read - use null and mention it in notes. Money values are plain numbers without currency symbols.",
    messages: [{ role: "user", content: [source, { type: "text", text: "Extract the invoice header, every line item, fees, credits and the invoice total." }] }],
    output_config: { format: betaZodOutputFormat(InvoiceSchema) },
  });
  if (response.stop_reason === "refusal") throw new Error("The invoice could not be read automatically. Enter it manually.");
  if (!response.parsed_output) throw new Error("The invoice could not be read. Try a clearer photo or enter it manually.");
  return { invoice: response.parsed_output, model: response.model };
}
