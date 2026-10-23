// HTML escaping shared by the server-rendered document and its metadata.
//
// Every value interpolated into server-rendered markup must pass through here:
// poll titles, site settings, and topic names are all user- or admin-controlled
// and could otherwise break out of an attribute or inject markup.

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

// Serializes JSON-LD for a <script type="application/ld+json"> block. The "</"
// sequence is escaped so a title containing "</script>" cannot close the tag.
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

// Serializes the bootstrap island for a <script type="application/json"> block.
// Every "<" is escaped (not just "</") because the payload carries user- and
// admin-controlled text such as poll titles and translations, and an HTML parser
// ends a script element at the first "</script" plus can be derailed by "<!--".
// JSON.parse turns `\u003c` back into "<", so the client reads the original value.
export function serializeJsonScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
