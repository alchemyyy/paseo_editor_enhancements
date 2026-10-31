/** "44-50" for a run, "44,46,48-50" for disjoint lines; sorted and de-duplicated */
export function formatLineSpec(lines: Iterable<number>): string {
  const sorted = [...new Set(lines)].filter((line) => Number.isInteger(line) && line > 0).sort((left, right) => left - right);
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (let index = 1; index <= sorted.length; index++) {
    const line = sorted[index];
    if (line === previous + 1) {
      previous = line;
      continue;
    }
    if (start !== undefined) parts.push(start === previous ? String(start) : `${start}-${previous}`);
    start = line;
    previous = line;
  }
  return parts.join(",");
}

/** `path:44-50`, or the bare path when no lines are given */
export function formatLineReference(path: string, lines: Iterable<number>): string {
  const spec = formatLineSpec(lines);
  return spec ? `${path}:${spec}` : path;
}

/** Every line from `from` to `to`, in either order */
export function lineRange(from: number, to: number): number[] {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const lines: number[] = [];
  for (let line = low; line <= high; line++) lines.push(line);
  return lines;
}
