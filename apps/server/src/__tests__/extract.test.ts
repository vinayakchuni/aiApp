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
  isDataFileExtension,
  DATA_FILE_PLACEHOLDER,
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

  it('detects csv from filename and mime', () => {
    expect(detectExtension('data.csv', 'text/csv')).toBe('csv');
    expect(detectExtension('blob', 'text/csv')).toBe('csv');
    expect(detectExtension('blob', 'application/csv')).toBe('csv');
  });

  it('detects xlsx from filename and mime', () => {
    expect(
      detectExtension(
        'sheet.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('xlsx');
    expect(
      detectExtension(
        'blob',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('xlsx');
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

  it('returns a placeholder for csv buffers without parsing them', async () => {
    const buf = Buffer.from('col1,col2\n1,2\n3,4\n');
    const text = await extractText(buf, 'csv');
    expect(text).toBe(DATA_FILE_PLACEHOLDER);
  });

  it('returns a placeholder for xlsx buffers without parsing them', async () => {
    const buf = Buffer.from('binary xlsx bytes');
    const text = await extractText(buf, 'xlsx');
    expect(text).toBe(DATA_FILE_PLACEHOLDER);
  });
});

describe('extract.isDataFileExtension', () => {
  it('is true for csv and xlsx, false for the rest', () => {
    expect(isDataFileExtension('csv')).toBe(true);
    expect(isDataFileExtension('xlsx')).toBe(true);
    expect(isDataFileExtension('pdf')).toBe(false);
    expect(isDataFileExtension('docx')).toBe(false);
    expect(isDataFileExtension('txt')).toBe(false);
  });
});
