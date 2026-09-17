import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentService } from './document.service';
import { DocumentReviewService } from './document-review.service';
import { DocumentController } from './document.controller';
import {
  DocumentContent,
  DocumentContentSchema,
} from './schemas/document-content.schema';
import { FileParserService } from './parser/file-parser.service';
import { PipelineModule } from '../pipeline/pipeline.module';

/**
 * Document module.
 * - DocumentService: document CRUD and status transitions (draft / publish / archive / review).
 * - DocumentReviewService: publication review (submit / approve / reject).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
    PipelineModule,
  ],
  controllers: [DocumentController],
  providers: [DocumentService, DocumentReviewService, FileParserService],
  exports: [DocumentService, DocumentReviewService, FileParserService],
})
export class DocumentModule {}
