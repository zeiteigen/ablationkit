export interface ArchNode {
  name: string;
  type?: string;
  params?: number;
  children?: ArchNode[];
}

export function countParams(n: ArchNode): number {
  return (n.params ?? 0) + (n.children ?? []).reduce((a, c) => a + countParams(c), 0);
}
