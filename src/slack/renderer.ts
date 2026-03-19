import type { WorklogItem } from "../types.js";

const markdownLinkRegex = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const strongRegex = /(^|[^\w*])\*\*([^*\n]+)\*\*(?=[^\w*]|$)/g;
const doubleUnderscoreRegex = /(^|[^\w_])__([^_\n]+)__(?=[^\w_]|$)/g;

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

export function renderFinalMessage(ownerUserId: string | null | undefined, text: string): string {
  const trimmed = text.trim();
  const mention = ownerUserId?.trim() ? `<@${ownerUserId.trim()}> ` : "";
  if (!trimmed) {
    return `${mention}Done.`.trim();
  }
  return `${mention}${trimmed}`.trim();
}

export function renderEventMessage(item: WorklogItem): string {
  const icon = item.status === "failed" ? ":x:" : ":white_check_mark:";
  return `${icon} ${item.title}`;
}

export function appendFileNotes(text: string, fileNotes: string[]): string {
  if (fileNotes.length === 0) return text;
  return [text.trim(), "", "Attached files:", ...fileNotes.map((note) => `- ${note}`)].filter(Boolean).join("\n");
}

export function renderSystemMessage(text: string): string {
  return `_System_: ${text.trim()}`;
}

export function normalizeSlackMrkdwn(text: string): string {
  return text
    .replace(markdownLinkRegex, (match, label: string, target: string) => {
      if (/^https?:\/\//i.test(target)) {
        return `<${target}|${label}>`;
      }
      if (/^(file:\/\/|\/|\.{1,2}\/)/.test(target)) {
        return label;
      }
      return match;
    })
    .replace(strongRegex, (_match, prefix: string, content: string) => `${prefix}*${content}*`)
    .replace(doubleUnderscoreRegex, (_match, prefix: string, content: string) => `${prefix}_${content}_`);
}
