/** Source item returned to the frontend (excerpt only, not the full chunk). */
export interface ChatSource {
  /** Source number corresponding to [n] in the answer. */
  index: number;
  documentId: string;
  documentTitle: string;
  heading: string | null;
  excerpt: string;
  score: number;
}
