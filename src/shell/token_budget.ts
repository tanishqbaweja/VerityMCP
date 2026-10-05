/**
/**
 * Head-and-tail character budgeting for command and file outputs.
 * Prevents context exhaustion while retaining both setup and error/tail lines.
 */
export function formatOutputWithBudget(
  rawText: string,
  maxChars = 30000,
  headCharsRatio = 0.4
): { text: string; truncated: boolean; totalChars: number } {
  const totalChars = rawText.length;
  if (totalChars <= maxChars) {
    return { text: rawText, truncated: false, totalChars };
  }

  const headBudget = Math.floor(maxChars * headCharsRatio);
  const tailBudget = maxChars - headBudget - 100; // 100 char margin for notice

  const head = rawText.slice(0, headBudget);
  const tail = rawText.slice(-tailBudget);
  const droppedChars = totalChars - (headBudget + tailBudget);

  const notice = `\n\n... [VerityMCP: Output truncated (${droppedChars} characters omitted)] ...\n\n`;

  return {
    text: `${head}${notice}${tail}`,
    truncated: true,
    totalChars,
  };
}
