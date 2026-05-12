import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

export type SupportedExtension = 'pdf' | 'docx' | 'txt' | 'csv' | 'xlsx';

export const SUPPORTED_EXTENSIONS: readonly SupportedExtension[] = [
  'pdf',
  'docx',
  'txt',
  'csv',
  'xlsx',
];

export const DATA_FILE_EXTENSIONS: readonly SupportedExtension[] = ['csv', 'xlsx'];

export const DATA_FILE_PLACEHOLDER = 'Data file — analysis will run in sandbox';

export const SUPPORTED_MIME_TYPES: Readonly<Record<SupportedExtension, readonly string[]>> = {
  pdf: ['application/pdf'],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
  ],
  txt: ['text/plain'],
  csv: ['text/csv', 'application/csv'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

export function isDataFileExtension(ext: SupportedExtension): boolean {
  return (DATA_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

export function extensionFromName(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function detectExtension(originalName: string, mimeType: string): SupportedExtension | null {
  const ext = extensionFromName(originalName);
  if (ext && (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return ext as SupportedExtension;
  }
  for (const supported of SUPPORTED_EXTENSIONS) {
    if (SUPPORTED_MIME_TYPES[supported].includes(mimeType)) {
      return supported;
    }
  }
  return null;
}

export async function extractText(
  buffer: Buffer,
  extension: SupportedExtension,
): Promise<string> {
  switch (extension) {
    case 'pdf': {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      const result = await parser.getText();
      return (result.text ?? '').trim();
    }
    case 'docx': {
      const result = await mammoth.extractRawText({ buffer });
      return (result.value ?? '').trim();
    }
    case 'txt':
      return buffer.toString('utf8').trim();
    case 'csv':
    case 'xlsx':
      return DATA_FILE_PLACEHOLDER;
  }
}
