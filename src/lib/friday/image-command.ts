/**
 * "Draw me a sunset over the sea", "image banao: ...", "generate a picture of
 * a red car". The words are matched here with no model call; the picture comes
 * from a connected cloud provider through the same privacy and billing gates as
 * a chat turn, and is shown in the chat and kept in the FRIDAY folder.
 */
import { desktopApi } from "./desktop";
import { showRealImage } from "./stage";

const VERB = String.raw`(?:generate|create|make|draw|paint|render|design|produce|banao|bana\s*do|bnao|banana|draw\s*kar)`;
const NOUN = String.raw`(?:an?\s+)?(?:image|picture|photo|photograph|illustration|artwork|painting|drawing|sketch|logo|wallpaper|poster|tasveer|tasvir|photu|chitra)`;

const FORMS: RegExp[] = [
  // generate an image of a cat
  new RegExp(
    String.raw`^(?:please\s+|can you\s+|could you\s+)?${VERB}\s+(?:me\s+)?${NOUN}\s*(?:of|showing|with|about|:|-)?\s*(.+)$`,
    "i",
  ),
  // draw a cat
  /^(?:please\s+|can you\s+)?(?:draw|paint|sketch)\s+(?:me\s+)?(.+)$/i,
  // ek billi ki image banao / billi ki tasveer banao
  new RegExp(String.raw`^(?:ek\s+)?(.+?)\s+(?:ki|ka|ke)\s+${NOUN}\s+${VERB}\b.*$`, "i"),
  // image banao: a cat
  new RegExp(String.raw`^${NOUN}\s+${VERB}\s*(?:[:\-]\s*|\s+)(.+)$`, "i"),
];

/** The picture the words ask for, or null when they are not a drawing request. */
export function parseImageRequest(text: string): { prompt: string } | null {
  const message = text.trim().replace(/[.!?]+$/, "");
  if (message.length < 6 || message.length > 600) return null;
  for (const form of FORMS) {
    const hit = form.exec(message);
    const prompt = hit?.[1]?.trim();
    if (
      prompt &&
      prompt.length >= 3 &&
      !/^(?:an?\s+|the\s+)?(?:chart|graph|plan|list|table|report|summary|diagram|flow|flowchart|workflow|map|conclusions?|comparison|schema|timeline)\b/i.test(
        prompt,
      )
    ) {
      return { prompt };
    }
  }
  return null;
}

/** Make the picture, show it, and say what happened in one plain line. */
export async function runImageRequest(request: { prompt: string }): Promise<string> {
  const api = desktopApi();
  if (!api?.generateImage) return "Drawing pictures needs the desktop app.";
  try {
    const result = await api.generateImage({ prompt: request.prompt });
    if (!result.ok) return `I could not draw that — ${result.error}`;
    showRealImage({
      title: request.prompt.slice(0, 60),
      src: result.dataUrl,
      source: result.model,
    });
    return `Here it is, drawn with ${result.model}${result.access === "paid" ? " (paid)" : ""}. It is saved at ${result.file}.`;
  } catch (err) {
    return `I could not draw that — ${(err as Error).message}`;
  }
}
