// Negative lookbehind requires the `@` to be at a non-word boundary, so
// embedded `@` in scp paths (`bizmodel@devel:/p`), emails (`a@b.com`), and
// git refs (`git@1ca662a`) no longer leak hostnames/SHAs into mentions.
const MENTION_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_\-]{1,64})/g;

function parseMentions(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const match of body.matchAll(MENTION_RE)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

module.exports = { parseMentions };
