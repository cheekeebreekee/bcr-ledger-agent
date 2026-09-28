/**
 * Link-shaped text in a card, both ways.
 *
 * Teams links bare URLs, `www.` hosts, domains and e-mail addresses in
 * Adaptive Card text. A value copied from a document someone else wrote (a
 * counterparty's name, an invoice number) must not become a live link, chosen
 * by whoever sent the client that document, inside the bot's own card.
 * {@link defangLinks} swaps the characters that make a link for look-alikes
 * that read the same: a dot before a letter becomes U+2024 (one dot leader),
 * `@` U+FF20 (fullwidth at), the colon of `://` U+A789 (modifier letter
 * colon). Zero-width characters would not do: linkifiers keep them inside
 * the host. {@link undoLinkDefang} swaps them back wherever a guest's text
 * comes in (a question, the „Zmień filtr” form), so a value copied from a
 * card still finds its document. NFKC would not: U+A789 has no decomposition.
 */

const ONE_DOT_LEADER = '․';
const FULLWIDTH_AT = '＠';
const MODIFIER_COLON = '꞉';

/** A document's value for a card: no URL, host or e-mail Teams would link. */
export function defangLinks(value: string): string {
  return value
    .replace(/:\/\//g, `${MODIFIER_COLON}//`)
    .replace(/@/g, FULLWIDTH_AT)
    .replace(/\.(?=\p{L})/gu, ONE_DOT_LEADER);
}

/** A guest's text with {@link defangLinks}' look-alikes back to `.`, `@` and `:`. */
export function undoLinkDefang(value: string): string {
  return value.replace(/․/g, '.').replace(/＠/g, '@').replace(/꞉/g, ':');
}
