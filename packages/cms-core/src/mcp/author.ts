/**
 * The author string on revisions and threads written over the MCP server: `mcp:<key name>#<key
 * prefix>`. The prefix tells apart keys that share a name (a revoked key and its re-created
 * replacement). Shared by the server and the editor's history panel, so it has no server imports.
 */

const MCP = "mcp:";

export const mcpAuthor = (key: { name: string; prefix: string }) =>
  `${MCP}${key.name}#${key.prefix}`;

/** The key name and prefix of an MCP author, or null for any other author. Older rows have no `#prefix`. */
export function parseMcpAuthor(
  author: string | null | undefined
): { name: string; prefix: string | null } | null {
  if (!author?.startsWith(MCP)) {
    return null;
  }
  const rest = author.slice(MCP.length);
  const at = rest.lastIndexOf("#");
  return at === -1
    ? { name: rest, prefix: null }
    : { name: rest.slice(0, at), prefix: rest.slice(at + 1) };
}
