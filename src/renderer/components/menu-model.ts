// XAIBO-PROD-532 (P5-T18 part 3b-3; design §5.1 Menu): menu keys. Up/Down move and wrap, Home/End jump, a printable
// character moves to the next item starting with it (wrapping, case-insensitive); null = not the menu's key.
export function menuKey(key: string, i: number, labels: readonly string[]): number | null {
  const n = labels.length;
  if (n === 0) return null;
  switch (key) {
    case 'ArrowDown': return (i + 1) % n;
    case 'ArrowUp': return (i - 1 + n) % n;
    case 'Home': return 0;
    case 'End': return n - 1;
  }
  if ([...key].length !== 1 || !/\S/u.test(key)) return null;
  const c = key.toLowerCase();
  for (let k = 1; k <= n; k++) {
    const j = (i + k) % n;
    if (labels[j]!.toLowerCase().startsWith(c)) return j;
  }
  return null;
}
