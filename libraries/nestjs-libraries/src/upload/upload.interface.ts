export interface IUploadProvider {
  uploadSimple(path: string): Promise<string>;
  uploadFile(file: Express.Multer.File): Promise<any>;
  /** Deletes a stored file by the URL it was served at. Rejects on failure; a file that is already gone is not a failure. */
  removeFile(filePath: string): Promise<void>;
  /** True when the URL is a file this provider stored (not an external link, not another bucket path). */
  ownsFile(filePath: string): boolean;
  /**
   * Stores a PDF Hookpost generated itself (a carousel render), never a file
   * a user sent: user uploads stay on uploadFile's image/video allow-list.
   * Refuses anything that does not sniff as a PDF.
   */
  uploadGeneratedPdf?(buffer: Buffer): Promise<{ path: string; filename: string }>;
}
