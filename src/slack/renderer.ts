import type { WorklogItem } from "../types.js";

export function renderWorklog(items: Iterable<WorklogItem>): string {
  const rows = [...items];
  if (rows.length === 0) {
    return "_Working..._";
  }

  const lines = ["_Worklog_"];
  for (const item of rows) {
    const icon = item.status === "failed" ? "x" : item.status === "completed" ? "white_check_mark" : "hourglass_flowing_sand";
    const detail = item.detail ? ` - ${item.detail}` : "";
    lines.push(`:${icon}: ${item.title}${detail}`);
  }
  return lines.join("\n");
}

export function renderFinalMessage(ownerUserId: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return `<@${ownerUserId}> Done.`;
  }
  return `<@${ownerUserId}> ${trimmed}`;
}

export function appendFileNotes(text: string, fileNotes: string[]): string {
  if (fileNotes.length === 0) return text;
  return [text.trim(), "", "Attached files:", ...fileNotes.map((note) => `- ${note}`)].filter(Boolean).join("\n");
}

export function renderSystemMessage(text: string): string {
  return `_System_: ${text.trim()}`;
}
