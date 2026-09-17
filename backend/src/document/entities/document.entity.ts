import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer';
import { DocumentStatus } from '../document-status';

/** Preserve the legacy import path: import { DocumentStatus } from './entities/document.entity'. */
export { DocumentStatus };

/** Document metadata (PostgreSQL kh_document). */
@Entity('kh_document')
export class DocumentEntity {
  /** Snowflake ID. */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** Title. */
  @Column({ type: 'varchar' })
  title: string;

  /** MongoDB document_content._id */
  @Column({ name: 'content_id', type: 'varchar', unique: true })
  contentId: string;

  /** Summary. */
  @Column({ type: 'varchar', nullable: true })
  summary?: string | null;

  /** Category ID. */
  @Column({
    name: 'category_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  categoryId?: string | null;

  /** Team ID. */
  @Column({
    name: 'team_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  teamId?: string | null;

  /** Author ID. */
  @Column({
    name: 'author_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  authorId?: string | null;

  /** Cover image URL. */
  @Column({ name: 'cover_image', type: 'varchar', nullable: true })
  coverImage?: string | null;

  /** Comma-separated tags. */
  @Column({ type: 'varchar', nullable: true })
  tags?: string | null;

  /** Status: 0 Draft / 1 Published / 2 Archived / 3 Pending review. */
  @Column({ type: 'smallint', default: DocumentStatus.Draft })
  status: DocumentStatus;

  /** Notes. */
  @Column({ type: 'varchar', nullable: true })
  remark?: string | null;

  /** View count. */
  @Column({ name: 'view_count', type: 'int', default: 0 })
  viewCount: number;

  /** Like count. */
  @Column({ name: 'like_count', type: 'int', default: 0 })
  likeCount: number;

  /** Comment count. */
  @Column({ name: 'comment_count', type: 'int', default: 0 })
  commentCount: number;

  /** Favorite count. */
  @Column({ name: 'favourite_count', type: 'int', default: 0 })
  favouriteCount: number;

  /** Word count. */
  @Column({ name: 'word_count', type: 'int', default: 0 })
  wordCount: number;

  /** Publication time. */
  @Column({ name: 'publish_time', type: 'timestamp', nullable: true })
  publishTime?: Date | null;

  /** Whether the document is public. */
  @Column({ name: 'is_public', type: 'boolean', default: false })
  isPublic: boolean;

  /** Creation time. */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  /** Update time. */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;

  /** Creator ID. */
  @Column({
    name: 'create_by',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  createBy?: string | null;

  /** Updater ID. */
  @Column({
    name: 'update_by',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  updateBy?: string | null;

  /** Soft-delete flag. */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
