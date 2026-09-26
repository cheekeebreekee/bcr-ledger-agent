/**
 * The only way to make an {@link Sql}: assigned by its static block when the
 * class is defined, so it is declared first.
 */
let build: (strings: readonly string[], values: readonly unknown[]) => Sql;

/** Proof, at run time, that an {@link Sql} is being built by this module. */
const BUILDING = Symbol('sql');

/**
 * The only way SQL is written in this package: a tagged template whose
 * interpolations are always bind parameters (`$1`, `$2`, …), never text.
 *
 *     sql`SELECT * FROM ledger.documents WHERE drive_item_id = ${id}`
 *
 * A fragment made with `sql` can be interpolated into another, and is spliced
 * in with its parameters renumbered; that is how optional search conditions
 * are composed. Nothing else is spliced: there is no raw-string escape hatch
 * (an {@link Sql} can only be built by the template, whose literal parts are
 * the source code's), identifiers are fixed in the code, and
 * `ClientTx.query` accepts only an {@link Sql} — checked at run time too — so
 * a string built by concatenation cannot reach a client transaction.
 */
export class Sql {
  /** Always one more text part than values: `parts[0] $1 parts[1] $2 parts[2]`. */
  readonly #parts: readonly string[];
  readonly #values: readonly unknown[];

  private constructor(token: symbol, parts: readonly string[], values: readonly unknown[]) {
    // `private` is only the compiler's; this is what stops `new Sql(['DROP …'])`.
    if (token !== BUILDING) throw new TypeError('Sql is built by the sql`...` tag only');
    this.#parts = parts;
    this.#values = values;
  }

  static {
    build = (strings, values) => {
      const parts: string[] = [strings[0] ?? ''];
      const out: unknown[] = [];
      values.forEach((value, i) => {
        const next = strings[i + 1] ?? '';
        if (value instanceof Sql) {
          const inner = value.#parts;
          parts[parts.length - 1] += inner[0] ?? '';
          value.#values.forEach((v, j) => {
            out.push(v);
            parts.push(inner[j + 1] ?? '');
          });
          parts[parts.length - 1] += next;
          return;
        }
        if (value === undefined) {
          throw new TypeError(
            `sql: parameter ${i + 1} is undefined; pass null for SQL NULL (a missing value is a bug)`,
          );
        }
        out.push(value);
        parts.push(next);
      });
      return new Sql(BUILDING, parts, out);
    };
  }

  /** The statement text with `$n` placeholders, and its parameters, for node-postgres. */
  toQuery(): { readonly text: string; readonly values: unknown[] } {
    let text = this.#parts[0] ?? '';
    for (let i = 0; i < this.#values.length; i += 1) {
      text += `$${i + 1}${this.#parts[i + 1] ?? ''}`;
    }
    return { text, values: [...this.#values] };
  }
}

/**
 * A parameterised statement or fragment. See {@link Sql}. Called as a tag
 * only: a plain array (a string someone built) is refused.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw) || !Object.isFrozen(strings)) {
    throw new TypeError('sql must be used as a tagged template: sql`...`');
  }
  return build(strings, values);
}

/**
 * Fragments joined by a fixed separator fragment (`sql` AND ``), for a
 * condition list. An empty list is an empty fragment.
 */
export function joinSql(fragments: readonly Sql[], separator: Sql): Sql {
  const strings = [''];
  const values: Sql[] = [];
  fragments.forEach((fragment, i) => {
    if (i > 0) {
      values.push(separator);
      strings.push('');
    }
    values.push(fragment);
    strings.push('');
  });
  return build(strings, values);
}
