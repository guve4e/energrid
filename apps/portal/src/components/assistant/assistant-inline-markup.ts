/**
 * Deliberately small, text-only subset of assistant formatting.
 * Vue escapes every segment. Do not turn model replies into HTML or use v-html.
 */
export type AssistantInlineSegment = {
  kind: 'text' | 'bold' | 'code';
  text: string;
};

export function assistantInlineSegments(message: string): AssistantInlineSegment[] {
  const segments: AssistantInlineSegment[] = [];
  const markup = /\*\*([^*\r\n]+)\*\*|`([^`\r\n]+)`/g;
  let start = 0;
  for (const match of message.matchAll(markup)) {
    const index = match.index;
    if (index > start) segments.push({ kind: 'text', text: message.slice(start, index) });
    segments.push({
      kind: match[1] === undefined ? 'code' : 'bold',
      text: match[1] ?? match[2] ?? '',
    });
    start = index + match[0].length;
  }
  if (start < message.length) segments.push({ kind: 'text', text: message.slice(start) });
  return segments;
}
