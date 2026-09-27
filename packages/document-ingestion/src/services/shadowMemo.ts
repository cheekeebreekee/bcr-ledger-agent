import { createHash } from 'node:crypto';
import { TableClient } from '@azure/data-tables';

/**
 * The table, in the Function App's own storage account (`AzureWebJobsStorage`).
 * It holds ids and hashes only: a Directory row's list item id and a digest of
 * a file version and the classifier's release, never a name or any content.
 */
export const SHADOW_MEMO_TABLE = 'inboxshadow';

/** How long one read or write of the memo may take before it counts as failed. */
export const SHADOW_MEMO_TIMEOUT_MS = 5_000;

/** One version of one file in one row's inbox. */
export interface ShadowMemoKey {
  readonly listItemId: string;
  readonly driveItemId: string;
  readonly eTag: string;
}

/**
 * Which file versions `shadow` has already classified and reported, kept
 * across worker restarts. Without it, every restart (several an hour on a
 * Consumption plan) sent every file in a shadowed inbox to the model again:
 * 43 test documents in the canary's channel cost about 2,700 paid
 * classifications on 26 September 2026 and used up the account's credit.
 *
 * The classifier's release (model, prompt, output schema, threshold) is part
 * of the key, so a new release classifies each file once more, and only once.
 */
export interface ShadowMemo {
  /** Whether this version was reported. Throws when the store cannot answer. */
  has(key: ShadowMemoKey): Promise<boolean>;
  /** Records a reported version. Throws when the store cannot write. */
  add(key: ShadowMemoKey): Promise<void>;
}

/** What the memo needs of an Azure Tables client. */
export type ShadowMemoTable = Pick<TableClient, 'createTable' | 'getEntity' | 'upsertEntity'>;

/** The memo in Azure Table storage: one entity per reported version. */
export class TableShadowMemo implements ShadowMemo {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly table: ShadowMemoTable,
    private readonly release: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static fromConnectionString(connectionString: string, release: string): TableShadowMemo {
    return new TableShadowMemo(
      TableClient.fromConnectionString(connectionString, SHADOW_MEMO_TABLE, {
        retryOptions: { maxRetries: 1 },
      }),
      release,
    );
  }

  async has(key: ShadowMemoKey): Promise<boolean> {
    await this.ensureTable();
    try {
      await this.table.getEntity(key.listItemId, this.rowKey(key), {
        abortSignal: AbortSignal.timeout(SHADOW_MEMO_TIMEOUT_MS),
      });
      return true;
    } catch (err) {
      if (statusOf(err) === 404) return false;
      throw err;
    }
  }

  async add(key: ShadowMemoKey): Promise<void> {
    await this.ensureTable();
    await this.table.upsertEntity(
      {
        partitionKey: key.listItemId,
        rowKey: this.rowKey(key),
        reportedAt: this.now().toISOString(),
      },
      'Replace',
      { abortSignal: AbortSignal.timeout(SHADOW_MEMO_TIMEOUT_MS) },
    );
  }

  /** A digest: an `eTag`'s quotes and braces are not all allowed in a row key. */
  rowKey(key: ShadowMemoKey): string {
    return createHash('sha256')
      .update(`${key.driveItemId}|${key.eTag}|${this.release}`)
      .digest('hex');
  }

  /** Once per worker; a failure is retried by the next call. An existing table is fine. */
  private ensureTable(): Promise<void> {
    this.ready ??= this.table
      .createTable({ abortSignal: AbortSignal.timeout(SHADOW_MEMO_TIMEOUT_MS) })
      .catch((err: unknown) => {
        this.ready = undefined;
        throw err;
      });
    return this.ready;
  }
}

/** The HTTP status of an Azure SDK error, when it has one. */
export function statusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}
