import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pdf-parse', () => {
  return {
    PDFParse: vi.fn().mockImplementation(() => ({
      getText: vi.fn().mockResolvedValue({ text: '  hello pdf world  \n' }),
    })),
  };
});

vi.mock('mammoth', () => ({
  default: {
    extractRawText: vi.fn().mockResolvedValue({ value: '  hello docx world  ' }),
  },
}));

import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import {
  detectExtension,
  extractText,
  extensionFromName,
} from '../services/extract';

const mockedPDF = vi.mocked(PDFParse);
const mockedMammoth = vi.mocked(mammoth.extractRawText);

describe('extract.detectExtension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects pdf from filename', () => {
    expect(detectExtension('report.pdf', 'application/pdf')).toBe('pdf');
  });

  it('detects docx from filename', () => {
    expect(
      detectExtension(
        'notes.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('docx');
  });

  it('detects txt from filename', () => {
    expect(detectExtension('readme.txt', 'text/plain')).toBe('txt');
  });

  it('falls back to mime type when extension is missing', () => {
    expect(detectExtension('blob', 'application/pdf')).toBe('pdf');
    expect(detectExtension('blob', 'text/plain')).toBe('txt');
  });

  it('returns null for unsupported types', () => {
    expect(detectExtension('image.png', 'image/png')).toBe(null);
    expect(detectExtension('file.exe', 'application/octet-stream')).toBe(null);
  });

  it('extensionFromName lowercases', () => {
    expect(extensionFromName('Foo.PDF')).toBe('pdf');
    expect(extensionFromName('no-extension')).toBe(null);
  });
});

describe('extract.extractText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts text from plain txt buffers', async () => {
    const buf = Buffer.from('  hello txt world  \n', 'utf8');
    const text = await extractText(buf, 'txt');
    expect(text).toBe('hello txt world');
  });

  it('routes pdf buffers through pdf-parse and trims output', async () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46]); // "%PDF" header bytes
    const text = await extractText(buf, 'pdf');
    expect(text).toBe('hello pdf world');
    expect(mockedPDF).toHaveBeenCalledTimes(1);
  });

  it('routes docx buffers through mammoth and trims output', async () => {
    const buf = Buffer.from('docx-bytes');
    const text = await extractText(buf, 'docx');
    expect(text).toBe('hello docx world');
    expect(mockedMammoth).toHaveBeenCalledWith({ buffer: buf });
  });
});
