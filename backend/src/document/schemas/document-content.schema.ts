import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DocumentContentDocument = HydratedDocument<DocumentContent>;

/**
 * Document content (MongoDB).
 * One-to-one with Postgres kh_document: _id <-> content_id and documentId <-> id.
 */
@Schema({
  collection: 'document_content',
  timestamps: true,
  versionKey: false,
})
export class DocumentContent {
  /** ObjectId corresponding to kh_document.content_id. */
  _id: Types.ObjectId;

  /** Related document metadata ID (kh_document.id). */
  @Prop({ type: String, required: true, index: true })
  documentId: string;

  /** Markdown content. */
  @Prop({ type: String, required: true, default: '' })
  content: string;

  /** Content character count. */
  @Prop({ type: Number, default: 0 })
  contentLength: number;

  /** Content summary / preview. */
  @Prop({ type: String, default: '' })
  contentSummary: string;

  /** Version number. */
  @Prop({ type: Number, default: 1 })
  version: number;

  /** Soft-delete flag. */
  @Prop({ type: Boolean, default: false })
  deleted: boolean;
}

export const DocumentContentSchema =
  SchemaFactory.createForClass(DocumentContent);
