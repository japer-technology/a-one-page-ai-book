/**
 * core/tree.ts — pure graph operations over the story tree.
 *
 * Nodes are append-only; "forking" is emergent: creating a new child under an
 * old node makes a new branch while the old one stays intact. Nothing is ever
 * destroyed by editing. The chosen path is just "walk parents from the frontier".
 */
import type { Book, Library, SeedOptions, StoryNode, TitleOption, TurnInput } from './types';
import { DEFAULT_TURN } from './types';
import { newId } from './id';
import { countWords } from './compile';

export function addNode(
  nodes: Record<string, StoryNode>,
  node: StoryNode,
): Record<string, StoryNode> {
  return { ...nodes, [node.id]: node };
}

export function getNode(nodes: Record<string, StoryNode>, id: string | null): StoryNode | null {
  return id === null ? null : (nodes[id] ?? null);
}

export function childrenOf(nodes: Record<string, StoryNode>, id: string): StoryNode[] {
  return Object.values(nodes)
    .filter((n) => n.parentId === id)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Root-first path from the given node up to its root. */
export function pathToRoot(nodes: Record<string, StoryNode>, id: string): StoryNode[] {
  const path: StoryNode[] = [];
  let cursor: StoryNode | null = getNode(nodes, id);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.unshift(cursor);
    cursor = getNode(nodes, cursor.parentId);
  }
  return path;
}

export function spinePages(nodes: Record<string, StoryNode>, id: string): StoryNode[] {
  return pathToRoot(nodes, id).filter((n) => n.kind === 'page');
}

/** 1-based page number of a page node along its chosen path. */
export function pageNumberAt(nodes: Record<string, StoryNode>, pageNodeId: string): number {
  return spinePages(nodes, pageNodeId).findIndex((p) => p.id === pageNodeId) + 1;
}

export function frontierNode(nodes: Record<string, StoryNode>, book: Book): StoryNode {
  const node = getNode(nodes, book.frontierId);
  if (!node) throw new Error(`Frontier node ${book.frontierId} is missing from the tree`);
  return node;
}

export function titleNodeOf(nodes: Record<string, StoryNode>, book: Book): StoryNode {
  const node = getNode(nodes, book.chosenTitleId);
  if (!node || node.kind !== 'title') throw new Error('Book has no valid title node');
  return node;
}

export function titleOf(nodes: Record<string, StoryNode>, book: Book): string {
  const node = getNode(nodes, book.chosenTitleId);
  return node && node.data.kind === 'title' ? node.data.title : 'Untitled';
}

export function seedTextOf(nodes: Record<string, StoryNode>, book: Book): string {
  const node = getNode(nodes, book.seedNodeId);
  return node && node.data.kind === 'seed' ? node.data.text : '';
}

export interface BookStats {
  pages: number;
  words: number;
  versions: number;
  nodes: number;
  branches: number;
}

/** Statistics over the whole book subtree (kept + discarded material). */
export function statsOf(nodes: Record<string, StoryNode>, book: Book): BookStats {
  const subtree = collectSubtree(nodes, book.seedNodeId);
  const pageNodes = subtree.filter((n) => n.kind === 'page');
  const kept = spinePages(nodes, book.frontierId)
    .map((p) => (p.data.kind === 'page' ? p.data.versions[p.data.chosenVersion - 1] : undefined))
    .filter((v): v is NonNullable<typeof v> => v !== undefined);
  return {
    pages: kept.length,
    words: kept.reduce((sum, v) => sum + countWords(v.text), 0),
    versions: pageNodes.reduce(
      (sum, p) => sum + (p.data.kind === 'page' ? p.data.versions.length : 0),
      0,
    ),
    nodes: subtree.length,
    branches: subtree.filter((n) => childrenOf(nodes, n.id).length > 1).length,
  };
}

/** All nodes reachable from a root, visited once (guards against cycles). */
export function collectSubtree(nodes: Record<string, StoryNode>, rootId: string): StoryNode[] {
  const out: StoryNode[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const node = getNode(nodes, id);
    if (!node) continue;
    out.push(node);
    for (const child of childrenOf(nodes, id)) stack.push(child.id);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Deep-copy a subtree with fresh ids (for duplication and safe re-entry). */
export function cloneSubtree(
  nodes: Record<string, StoryNode>,
  rootId: string,
): { nodes: Record<string, StoryNode>; rootId: string; remap: Map<string, string> } {
  const subtree = collectSubtree(nodes, rootId);
  const remap = new Map<string, string>();
  const out: Record<string, StoryNode> = {};
  for (const node of subtree) {
    const id = newId();
    remap.set(node.id, id);
    out[id] = {
      id,
      kind: node.kind,
      parentId: null,
      createdAt: node.createdAt,
      data: structuredClone(node.data),
    };
  }
  for (const node of subtree) {
    const id = remap.get(node.id);
    if (id === undefined || node.parentId === null) continue;
    const parentId = remap.get(node.parentId);
    if (parentId !== undefined && out[id] !== undefined) out[id].parentId = parentId;
  }
  const newRoot = remap.get(rootId);
  if (newRoot === undefined) throw new Error('cloneSubtree: root not in subtree');
  return { nodes: out, rootId: newRoot, remap };
}

export function removeSubtree(
  nodes: Record<string, StoryNode>,
  rootId: string,
): Record<string, StoryNode> {
  const ids = new Set(collectSubtree(nodes, rootId).map((n) => n.id));
  const out: Record<string, StoryNode> = {};
  for (const [id, node] of Object.entries(nodes)) if (!ids.has(id)) out[id] = node;
  return out;
}

// ---- Node factories -------------------------------------------------------

export function makeSeedNode(text: string, options: SeedOptions): StoryNode {
  return {
    id: newId(),
    kind: 'seed',
    parentId: null,
    createdAt: Date.now(),
    data: { kind: 'seed', text, options, titles: [] },
  };
}

export function makeTitleNode(parentId: string, option: TitleOption): StoryNode {
  return {
    id: newId(),
    kind: 'title',
    parentId,
    createdAt: Date.now(),
    data: { kind: 'title', title: option.title, tagline: option.tagline },
  };
}

export function makePageNode(
  parentId: string,
  direction: TurnInput,
  model: string,
  text: string,
): StoryNode {
  return {
    id: newId(),
    kind: 'page',
    parentId,
    createdAt: Date.now(),
    data: {
      kind: 'page',
      versions: [{ v: 1, text, by: 'ai', at: Date.now(), model }],
      chosenVersion: 1,
      direction,
      model,
    },
  };
}

export function makeTurnNode(parentId: string, input: TurnInput = DEFAULT_TURN): StoryNode {
  return {
    id: newId(),
    kind: 'turn',
    parentId,
    createdAt: Date.now(),
    data: { kind: 'turn', input },
  };
}

export function makeEndingNode(parentId: string, note: string): StoryNode {
  return {
    id: newId(),
    kind: 'ending',
    parentId,
    createdAt: Date.now(),
    data: { kind: 'ending', note },
  };
}

/** Append a new version to a page node (all versions are kept forever). */
export function appendPageVersion(
  node: StoryNode,
  text: string,
  by: 'ai' | 'user',
  model?: string,
): StoryNode {
  if (node.kind !== 'page' || node.data.kind !== 'page') {
    throw new Error('appendPageVersion requires a page node');
  }
  const data = node.data;
  const versions = [
    ...data.versions,
    { v: data.versions.length + 1, text, by, at: Date.now(), model },
  ];
  return { ...node, data: { ...data, versions, chosenVersion: versions.length } };
}

export function setChosenVersion(node: StoryNode, v: number): StoryNode {
  if (node.kind !== 'page' || node.data.kind !== 'page') {
    throw new Error('setChosenVersion requires a page node');
  }
  if (v < 1 || v > node.data.versions.length) throw new Error(`version ${v} out of range`);
  return { ...node, data: { ...node.data, chosenVersion: v } };
}

export function appendTitleOptions(seedNode: StoryNode, titles: TitleOption[]): StoryNode {
  if (seedNode.kind !== 'seed' || seedNode.data.kind !== 'seed') {
    throw new Error('appendTitleOptions requires a seed node');
  }
  return { ...seedNode, data: { ...seedNode.data, titles: [...seedNode.data.titles, ...titles] } };
}

export function makeBook(seedNodeId: string, titleNodeId: string, model: string): Book {
  const now = Date.now();
  return {
    id: newId(),
    seedNodeId,
    chosenTitleId: titleNodeId,
    frontierId: titleNodeId,
    status: 'in-progress',
    model,
    createdAt: now,
    updatedAt: now,
  };
}

export function setFrontier(book: Book, nodeId: string): Book {
  return { ...book, frontierId: nodeId, updatedAt: Date.now() };
}

export function finishBook(book: Book, nodeId: string): Book {
  return { ...book, frontierId: nodeId, status: 'finished', updatedAt: Date.now() };
}

export function sortBooks(lib: Library): Book[] {
  return [...lib.books].sort((a, b) => b.updatedAt - a.updatedAt);
}
