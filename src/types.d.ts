declare module 'pdf-parse' {
  interface PdfParseResult {
    numpages: number
    numrender: number
    info: Record<string, unknown>
    metadata: unknown
    version: string
    text: string
  }
  function pdfParse(buffer: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>
  export default pdfParse
}
