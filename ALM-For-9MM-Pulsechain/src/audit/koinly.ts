/**
 * Koinly CSV parser and row normalizer.
 * Parses an exported Koinly CSV into structured KoinlyRow records.
 *
 * Supports TWO Koinly CSV formats:
 *
 * Format A (Koinly native export):
 *   Row, Date, Time (UTC), Type, Wallet, Asset / Amount,
 *   Counterparty / Received, Real-time Value at time of transaction,
 *   P/L, Tag, Notes
 *
 * Format B (ChatGPT Chrome extension / manual extract):
 *   Date, Time (UTC), Type, Wallet, Sent/Out Amount, Sent/Out Currency,
 *   Received/In Amount, Received/In Currency, Net Value (USD), Action,
 *   TX Hash, Fee
 */

import { readFileSync } from 'fs';

export interface ParsedAmount {
  /** Raw signed amount (positive = received, negative = sent) */
  amount: number;
  /** Token symbol as written in Koinly (e.g., 'PLS', 'PLSX', 'WPLS', 'HEX') */
  symbol: string;
  /** True if the original string had a leading '+' or no sign (received) */
  isReceived: boolean;
}

export interface KoinlyRow {
  /** Original row number from CSV (1-based, matching Koinly UI row numbers) */
  rowNum: number;
  /** Parsed UTC timestamp in milliseconds */
  dateMs: number;
  /** Koinly transaction type: 'Deposit', 'Withdrawal', 'Exchange', 'Cost', 'Income', 'Send', 'Transfer', etc. */
  type: string;
  /** Wallet label (e.g., 'ALM Pulsechain (PLS)') */
  wallet: string;
  /** Primary asset being sent/received */
  asset: ParsedAmount | null;
  /** Counterparty / received asset (for Exchange rows) */
  received: ParsedAmount | null;
  /** USD value at time of transaction */
  usdValue: number;
  /** P/L in USD (may be 0 if blank) */
  plUsd: number;
  /** Tag / Action (e.g., 'mint', 'approve', 'token swap', 'contract action', 'burn') */
  tag: string;
  /** Notes / Fee column */
  notes: string;
  /**
   * Tx hash extracted from any column.
   * Koinly may truncate: '0x98...728e' — we store the raw string.
   * Use extractTxHashParts() to get prefix/suffix for fuzzy matching.
   */
  rawTxHash: string | null;
}

/**
 * Extracted parts of a (potentially truncated) Koinly tx hash.
 * A full hash has prefix === suffix and noTruncation === true.
 */
export interface TxHashParts {
  /** Lowercase hex chars immediately after '0x', at least 2 chars */
  prefix: string;
  /** Lowercase last hex chars before truncation ended, at least 2 chars */
  suffix: string;
  /** True if there are no dots/ellipses — the hash appears to be full-length */
  noTruncation: boolean;
  /** Original raw string */
  raw: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Expands abbreviated numeric suffixes used by Koinly:
 *   11.03m → 11030000,  14.95m → 14950000,  2.5k → 2500,  1.2b → 1200000000
 */
function expandSuffix(raw: string): number {
  const lower = raw.trim().toLowerCase();
  const match = lower.match(/^([0-9.,]+)([kmb]?)$/);
  if (!match) return NaN;
  const num = parseFloat(match[1].replace(/,/g, ''));
  const suffix = match[2];
  if (suffix === 'k') return num * 1_000;
  if (suffix === 'm') return num * 1_000_000;
  if (suffix === 'b') return num * 1_000_000_000;
  return num;
}

/**
 * Parses an amount string like '-42.64244287 PLS', '+11.03m PLSX', '9MM-V3-POS #156468'.
 * Returns null if the string is empty or unparseable as a token amount.
 */
function parseAmountCombined(raw: string): ParsedAmount | null {
  const s = raw.trim();
  if (!s) return null;

  // Match: optional sign, number (with optional suffix), whitespace, symbol
  const match = s.match(/^([+-]?)([0-9.,]+[kmb]?)\s+(.+)$/i);
  if (!match) return null;

  const sign = match[1] === '-' ? -1 : 1;
  const num = expandSuffix(match[2]);
  if (isNaN(num)) return null;

  return {
    amount: sign * num,
    symbol: match[3].trim(),
    isReceived: sign > 0,
  };
}

/**
 * Builds a ParsedAmount from separate amount + currency columns (Format B).
 * Returns null if both are empty.
 */
function parseAmountSplit(amountStr: string, currencyStr: string, isSent: boolean): ParsedAmount | null {
  const amt = amountStr.trim();
  const cur = currencyStr.trim();
  if (!amt && !cur) return null;
  if (!amt) return null;

  const num = expandSuffix(amt);
  if (isNaN(num)) {
    // Might be an NFT like '9MM-V3-POS' — use the currency as extra info
    return {
      amount: 0,
      symbol: cur ? `${amt} ${cur}`.trim() : amt,
      isReceived: !isSent,
    };
  }

  return {
    amount: isSent ? -Math.abs(num) : Math.abs(num),
    symbol: cur || 'UNKNOWN',
    isReceived: !isSent,
  };
}

/**
 * Parses a USD value string like '$76.73', '$0.0007', '-$0.16', '$0.00', '$1,085.14'.
 * Returns 0 for blank or unparseable values.
 */
function parseUsd(raw: string): number {
  const s = raw.trim().replace(/[$,]/g, '');
  if (!s) return 0;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/**
 * Parses date + time into a Unix ms timestamp.
 * Supports multiple date formats:
 *   'Mar 7, 2026'  (Format A)
 *   '7-Mar-26'     (Format B: D-Mon-YY)
 */
function parseDateTimeUtc(date: string, time: string): number {
  const d = date.trim();
  const t = time.trim();

  // Try D-Mon-YY format first (Format B): '7-Mar-26' → 'Mar 7, 2026'
  const dmy = d.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (dmy) {
    const day = dmy[1];
    const mon = dmy[2];
    const yearRaw = dmy[3];
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    const combined = `${mon} ${day}, ${year} ${t} UTC`;
    const ms = Date.parse(combined);
    if (!isNaN(ms)) return ms;
  }

  // Try Mon D, YYYY format (Format A): 'Mar 7, 2026'
  const combined = `${d} ${t} UTC`;
  const ms = Date.parse(combined);
  if (!isNaN(ms)) return ms;

  // Fallback: date only
  const fallback = Date.parse(`${d} UTC`);
  return isNaN(fallback) ? 0 : fallback;
}

/**
 * Scans a string for a tx hash pattern (full or truncated).
 * Matches:
 *   Full:      0x[64 hex chars]
 *   Truncated: 0x[hex]+[dots]+[hex]   e.g. 0x98...728e  or  0x1234.......ABCD
 * Returns the first match found, or null.
 */
function extractRawTxHash(s: string): string | null {
  // Full hash: 0x followed by 64 hex chars
  const fullMatch = s.match(/0x[0-9a-fA-F]{64}/);
  if (fullMatch) return fullMatch[0];
  // Truncated: 0x[2+ hex], 2+ dots, [2+ hex]  (handles 0x98...728e and 0x1234.......ABCD)
  const truncMatch = s.match(/0x[0-9a-fA-F]{2,}\.{2,}[0-9a-fA-F]{2,}/);
  if (truncMatch) return truncMatch[0];
  return null;
}

/**
 * Scans all string fields in a row for a tx hash.
 */
function findTxHashInRow(fields: Record<string, string>): string | null {
  for (const val of Object.values(fields)) {
    const found = extractRawTxHash(val);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Splits a CSV line respecting quoted fields (double-quote convention).
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        // Escaped quote inside quoted field
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === ',' && !inQuote) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parses the extracted tx hash raw string into prefix/suffix parts
 * suitable for fuzzy matching against full 66-char hashes.
 */
export function extractTxHashParts(raw: string): TxHashParts | null {
  if (!raw.toLowerCase().startsWith('0x')) return null;

  const body = raw.slice(2); // strip '0x'
  const hasDots = /\.{2,}/.test(body);

  if (!hasDots) {
    // Full hash — prefix and suffix are the same content
    const lower = body.toLowerCase();
    if (lower.length < 4) return null;
    return { prefix: lower.slice(0, 10), suffix: lower.slice(-4), noTruncation: true, raw };
  }

  // Truncated: split on dot run  (e.g., '98...728e' or '1234.......ABCD')
  const dotMatch = body.match(/^([0-9a-fA-F]+)\.+([0-9a-fA-F]+)$/);
  if (!dotMatch) return null;

  return {
    prefix: dotMatch[1].toLowerCase(),
    suffix: dotMatch[2].toLowerCase(),
    noTruncation: false,
    raw,
  };
}

// ---------------------------------------------------------------------------
// CSV format detection
// ---------------------------------------------------------------------------

type CsvFormat = 'format_a' | 'format_b';

/**
 * Detects the CSV format from header column names.
 * Format A: 'Asset / Amount' column (Koinly native)
 * Format B: 'Sent/Out Amount' column (ChatGPT extract / split columns)
 */
function detectFormat(headerFields: string[]): CsvFormat {
  const lower = headerFields.map((h) => h.toLowerCase());
  if (lower.includes('sent/out amount') || lower.includes('sent/out currency')) return 'format_b';
  return 'format_a';
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parses a Koinly CSV export file into an array of KoinlyRow records.
 * Auto-detects Format A vs Format B from the header row.
 * Skips blank lines and comment lines.
 * Throws a descriptive error if the file cannot be read or has no recognizable header.
 */
export function parseKoinlyCsv(filePath: string): KoinlyRow[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read CSV file at "${filePath}": ${err instanceof Error ? err.message : err}`);
  }

  const lines = content.split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error(`CSV file appears empty: "${filePath}"`);
  }

  // Find header row — look for 'Date' or 'Row' in the first few lines
  let headerIdx = -1;
  let headerFields: string[] = [];
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const fields = splitCsvLine(lines[i]);
    if (fields.some((f) => f.trim().toLowerCase() === 'date' || f.trim().toLowerCase() === 'row')) {
      headerIdx = i;
      headerFields = fields.map((f) => f.trim());
      break;
    }
  }
  if (headerIdx < 0) {
    throw new Error(
      `Could not find a header row in "${filePath}". Expected columns like: Date, Time (UTC), Type, ...`,
    );
  }

  const format = detectFormat(headerFields);

  // Build a column index map (case-insensitive, trim whitespace)
  const colIndex: Record<string, number> = {};
  headerFields.forEach((h, i) => {
    colIndex[h.toLowerCase()] = i;
  });

  // Column accessors — tolerant of missing columns
  const col = (fields: string[], name: string): string => {
    const idx = colIndex[name.toLowerCase()];
    return idx !== undefined ? (fields[idx] ?? '').trim() : '';
  };

  const rows: KoinlyRow[] = [];
  let autoRowNum = 1;

  for (let lineIdx = headerIdx + 1; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx].trim();
    if (!line) continue;

    const fields = splitCsvLine(lines[lineIdx]);
    if (fields.length < 3) continue; // skip malformed lines

    // Row number: use 'Row' column if present, otherwise auto-increment
    const rawRow = col(fields, 'row');
    const rowNum = rawRow ? parseInt(rawRow, 10) : autoRowNum++;
    if (isNaN(rowNum)) {
      autoRowNum++;
      continue;
    }

    // Date/time — same in both formats
    const dateStr = col(fields, 'date');
    const timeStr = col(fields, 'time (utc)');
    const dateMs = parseDateTimeUtc(dateStr, timeStr);

    const type = col(fields, 'type');
    const wallet = col(fields, 'wallet');

    let asset: ParsedAmount | null;
    let received: ParsedAmount | null;
    let usdValue: number;
    let plUsd: number;
    let tag: string;
    let notes: string;
    let txHashSources: Record<string, string>;

    if (format === 'format_b') {
      // Format B: split amount/currency columns
      asset = parseAmountSplit(
        col(fields, 'sent/out amount'),
        col(fields, 'sent/out currency'),
        true,
      );
      received = parseAmountSplit(
        col(fields, 'received/in amount'),
        col(fields, 'received/in currency'),
        false,
      );
      usdValue = parseUsd(col(fields, 'net value (usd)'));
      plUsd = 0; // Format B doesn't have a separate P/L column
      tag = col(fields, 'action');
      notes = col(fields, 'fee');

      txHashSources = {
        txHashCol: col(fields, 'tx hash'),
        notes,
        // Also scan the received column — sometimes NFT hashes appear here
        receivedIn: col(fields, 'received/in amount') + ' ' + col(fields, 'received/in currency'),
      };
    } else {
      // Format A: combined amount columns
      const assetStr = col(fields, 'asset / amount');
      const receivedStr = col(fields, 'counterparty / received');
      asset = parseAmountCombined(assetStr);
      received = parseAmountCombined(receivedStr);
      usdValue = parseUsd(col(fields, 'real-time value at time of transaction'));
      plUsd = parseUsd(col(fields, 'p/l'));
      tag = col(fields, 'tag');
      notes = col(fields, 'notes');

      txHashSources = {
        assetStr,
        receivedStr,
        notes,
        txHashCol: col(fields, 'txhash') || col(fields, 'transaction hash') || col(fields, 'hash'),
      };
    }

    const rawTxHash = findTxHashInRow(txHashSources);

    rows.push({
      rowNum,
      dateMs,
      type,
      wallet,
      asset,
      received,
      usdValue,
      plUsd,
      tag,
      notes,
      rawTxHash,
    });
  }

  return rows;
}
