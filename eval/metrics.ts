export type Grades = Record<string, number>;

export function recallAt(ranked: string[], grades: Grades, k: number): number {
  const relevant = Object.keys(grades);
  if (relevant.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}

export function mrrAt(ranked: string[], grades: Grades, k: number): number {
  const idx = ranked.slice(0, k).findIndex((id) => (grades[id] ?? 0) > 0);
  return idx === -1 ? 0 : 1 / (idx + 1);
}

export function ndcgAt(ranked: string[], grades: Grades, k: number): number {
  const gain = (g: number) => 2 ** g - 1;
  const dcg = ranked
    .slice(0, k)
    .reduce((acc, id, i) => acc + gain(grades[id] ?? 0) / Math.log2(i + 2), 0);
  const ideal = Object.values(grades)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((acc, g, i) => acc + gain(g) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
