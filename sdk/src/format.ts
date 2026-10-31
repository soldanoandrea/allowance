/**
 * Plain-text table: columns padded to the widest cell. With `maxWidth` (the
 * terminal's columns), the last column is cut, marked with `~`, so that
 * lines do not wrap; it keeps at least 8 characters.
 */
export function table(headers: string[], rows: string[][], maxWidth?: number): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  let cells = rows;
  const last = headers.length - 1;
  if (maxWidth !== undefined && last >= 0) {
    const others = widths.slice(0, last).reduce((sum, w) => sum + w + 2, 0);
    const room = Math.max(8, (headers[last] ?? '').length, maxWidth - others);
    if ((widths[last] ?? 0) > room) {
      widths[last] = room;
      cells = rows.map((r) => r.map((c, i) => (i === last && c.length > room ? `${c.slice(0, room - 1)}~` : c)));
    }
  }
  const line = (row: string[]): string => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}
