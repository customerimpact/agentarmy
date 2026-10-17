export const SCROLLBACK_LIMIT = 256 * 1024;

// Keeps the tail of a console's output (measured in UTF-16 units, close enough to bytes here)
export class Scrollback {
  private chunks: string[] = [];
  private size = 0;

  constructor(private readonly limit: number = SCROLLBACK_LIMIT) {}

  append(data: string): void {
    this.chunks.push(data);
    this.size += data.length;
    if (this.size <= this.limit * 1.5) return;
    // Compact lazily so we are not re-joining on every write
    const joined = this.chunks.join('');
    let tail = joined.slice(joined.length - this.limit);
    // Start at a line boundary so the replay does not begin inside an escape sequence
    const newline = tail.indexOf('\n');
    if (newline !== -1 && newline < 4096) tail = tail.slice(newline + 1);
    this.chunks = [tail];
    this.size = tail.length;
  }

  read(): string {
    const joined = this.chunks.join('');
    this.chunks = [joined];
    return joined.length > this.limit ? joined.slice(joined.length - this.limit) : joined;
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }
}
