/**
 * Plain-text table: columns padded to the widest cell. With `maxWidth` (the
 * terminal's columns), a last column that does not fit wraps onto
 * continuation lines under itself, at word boundaries, so that no line is
 * wider than the terminal and nothing is cut; it keeps at least 8 characters.
 */
export function table(headers: string[], rows: string[][], maxWidth?: number): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const last = headers.length - 1;
  let room = Number.POSITIVE_INFINITY;
  if (maxWidth !== undefined && last >= 0) {
    const others = widths.slice(0, last).reduce((sum, w) => sum + w + 2, 0);
    room = Math.max(8, (headers[last] ?? '').length, maxWidth - others);
    if ((widths[last] ?? 0) > room) widths[last] = room;
  }
  const line = (row: string[]): string => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  const out = [line(headers), line(widths.map((w) => '-'.repeat(w)))];
  for (const row of rows) {
    const [first = '', ...rest] = wrapText(row[last] ?? '', room);
    out.push(line([...row.slice(0, last), first]));
    for (const part of rest) out.push(line([...row.slice(0, last).map(() => ''), part]));
  }
  return out.join('\n');
}

/** `text` in pieces of at most `width` characters, broken at spaces where possible. */
export function wrapText(text: string, width: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > width) {
    const space = rest.lastIndexOf(' ', width);
    const cut = space > width / 2 ? space : width;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  parts.push(rest);
  return parts;
}
