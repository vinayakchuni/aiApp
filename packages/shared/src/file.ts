export interface ConversationFile {
  id: string;
  conversationId: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface UploadFileResponse {
  success: boolean;
  file: ConversationFile;
}

export interface FileUploadLimits {
  maxFiles: number;
  maxFileSizeBytes: number;
  supportedExtensions: string[];
}
