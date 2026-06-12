import { AzureKeyCredential, DocumentAnalysisClient } from '@azure/ai-form-recognizer';
import {
  createLogger,
  type Classification,
  type Classifier,
  type ClassifierContext,
} from '@bcr/shared';

export interface DocumentIntelligenceClassifierOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  /**
   * Prebuilt model id to use. Defaults to `prebuilt-invoice`. Other useful
   * values include `prebuilt-receipt`, `prebuilt-document`, or a custom
   * model id from your AI Document Intelligence Studio project.
   */
  readonly modelId?: string;
}

/**
 * Optional content-based classifier. Calls Azure AI Document Intelligence
 * (formerly Form Recognizer) to extract fields like `InvoiceDate` and
 * `VendorName`, then rebuilds the SharePoint path from them.
 *
 * The function app only constructs this when the feature flag
 * `DOCUMENT_INTELLIGENCE_ENABLED=true`. If the AI call returns nothing
 * useful, this classifier returns `null` so the next strategy gets a turn.
 */
export class DocumentIntelligenceClassifier implements Classifier {
  readonly name = 'document-intelligence';
  private readonly log = createLogger('ingestion/documentIntelligence');
  private readonly client: DocumentAnalysisClient;
  private readonly modelId: string;

  constructor(opts: DocumentIntelligenceClassifierOptions) {
    this.client = new DocumentAnalysisClient(opts.endpoint, new AzureKeyCredential(opts.apiKey));
    this.modelId = opts.modelId ?? 'prebuilt-invoice';
  }

  async classify(ctx: ClassifierContext): Promise<Classification | null> {
    const content = await ctx.readContent();
    this.log.debug({ filename: ctx.filename, model: this.modelId }, 'analyzing document');

    const poller = await this.client.beginAnalyzeDocument(this.modelId, content);
    const result = await poller.pollUntilDone();
    const document = result.documents?.[0];
    if (!document) return null;

    const fields = document.fields ?? {};
    const invoiceDate = readDate(fields, ['InvoiceDate', 'TransactionDate', 'Date']);
    const vendor = readString(fields, ['VendorName', 'MerchantName', 'CounterpartyName']);

    if (document.docType === 'invoice' && invoiceDate) {
      return {
        documentType: 'Invoice',
        folderPath: `Invoices/${year(invoiceDate)}/${month(invoiceDate)}`,
        confidence: clamp(document.confidence ?? 0.85),
        classifier: this.name,
        fields: {
          invoiceDate: invoiceDate.toISOString(),
          vendor: vendor ?? '',
        },
      };
    }

    if (document.docType === 'receipt' && invoiceDate) {
      return {
        documentType: 'Receipt',
        folderPath: `Receipts/${year(invoiceDate)}/${month(invoiceDate)}`,
        confidence: clamp(document.confidence ?? 0.8),
        classifier: this.name,
        fields: {
          receiptDate: invoiceDate.toISOString(),
          vendor: vendor ?? '',
        },
      };
    }

    return null;
  }
}

// ---------------------------------------------------------------------------

function readString(
  fields: Record<string, { value?: unknown; kind?: string } | undefined>,
  candidates: readonly string[],
): string | undefined {
  for (const k of candidates) {
    const v = fields[k]?.value;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function readDate(
  fields: Record<string, { value?: unknown; kind?: string } | undefined>,
  candidates: readonly string[],
): Date | undefined {
  for (const k of candidates) {
    const v = fields[k]?.value;
    if (v instanceof Date) return v;
    if (typeof v === 'string') {
      const parsed = new Date(v);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return undefined;
}

const year = (d: Date) => String(d.getUTCFullYear()).padStart(4, '0');
const month = (d: Date) => String(d.getUTCMonth() + 1).padStart(2, '0');
const clamp = (n: number) => Math.max(0, Math.min(1, n));
