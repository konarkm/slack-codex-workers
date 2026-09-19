// Agents write Markdown; Slack renders mrkdwn.
const markdownLinkRegex = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const strongRegex = /(^|[^\w*])\*\*([^*\n]+)\*\*(?=[^\w*]|$)/g;
const doubleUnderscoreRegex = /(^|[^\w_])__([^_\n]+)__(?=[^\w_]|$)/g;

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
