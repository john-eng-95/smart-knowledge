import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentService } from './document.service';
import { DocumentReviewService } from './document-review.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { QueryDocumentDto } from './dto/query-document.dto';
import { UploadParseDto } from './dto/upload-parse.dto';
import { QueryReviewTasksDto, ReviewDecisionDto } from './dto/review.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { RoleCode } from '../common/constants/roles';
import { PermissionCode } from '../common/constants/permissions';

/** Document endpoints: JWT plus permission codes; review actions also require ROLE_REVIEWER or ROLE_ADMIN. */
@Controller('documents')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly reviewService: DocumentReviewService,
  ) {}

  /** Create a document. */
  @Post()
  @RequirePermission(PermissionCode.documentCreate)
  create(@Body() dto: CreateDocumentDto, @CurrentUser() user: AuthUser) {
    return this.documentService.create(dto, user);
  }

  /** Upload and parse a file as Markdown, then create a draft (form-data field: file). */
  @Post('upload/parse')
  @RequirePermission(PermissionCode.documentCreate)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  uploadAndParse(
    @UploadedFile() file: Express.Multer.File,
    @Body() meta: UploadParseDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) {
      throw new BadRequestException(
        'Please upload a file (form-data field: file).',
      );
    }
    return this.documentService.uploadAndCreateDocument(file, meta, user);
  }

  /** Review task list (must be registered before @Get(':id') so the route is not captured by :id). */
  @Get('reviews/tasks')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  @RequirePermission(PermissionCode.documentReview)
  listReviewTasks(@Query() query: QueryReviewTasksDto) {
    return this.reviewService.listTasks(query);
  }

  /** Number of pending reviews for navigation badges and similar UI. */
  @Get('reviews/tasks/pending-count')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  @RequirePermission(PermissionCode.documentReview)
  pendingReviewCount() {
    return this.reviewService.getPendingCount();
  }

  /** Paginated document list (metadata only). */
  @Get()
  @RequirePermission(PermissionCode.documentList)
  findAll(@Query() query: QueryDocumentDto, @CurrentUser() user: AuthUser) {
    return this.documentService.findAll(query, user);
  }

  /** Publish a document (submit for review when required; otherwise publish and enqueue MQ work). */
  @Put(':id/publish')
  @RequirePermission(PermissionCode.documentEdit)
  publish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentService.publish(id, user);
  }

  /** Archive: Published -> Archived and clear RAG/Search/KG indexes. */
  @Put(':id/archive')
  @RequirePermission(PermissionCode.documentEdit)
  archive(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentService.archive(id, user);
  }

  /** Unpublish for editing: Published -> Draft, clear indexes, and allow later review/publication. */
  @Put(':id/save-draft')
  @RequirePermission(PermissionCode.documentEdit)
  saveAsDraft(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentService.saveAsDraft(id, user);
  }

  /** Submit for review directly (also called internally by publish when required). */
  @Post(':id/reviews/submit')
  @RequirePermission(PermissionCode.documentEdit)
  submitReview(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.reviewService.submitForReview(id, user);
  }

  /** Current pending review (review_result IS NULL). */
  @Get(':id/reviews/current')
  @RequirePermission(PermissionCode.documentList, PermissionCode.documentReview)
  getCurrentReview(@Param('id') id: string) {
    return this.reviewService.getCurrentReview(id);
  }

  /** All review history for the document, newest first by created_at. */
  @Get(':id/reviews/history')
  @RequirePermission(PermissionCode.documentList, PermissionCode.documentReview)
  getReviewHistory(@Param('id') id: string) {
    return this.reviewService.getReviewHistory(id);
  }

  /** Approve review -> publish the document and rebuild indexes. */
  @Post('reviews/tasks/:taskId/approve')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  @RequirePermission(PermissionCode.documentReview)
  approveReview(
    @Param('taskId') taskId: string,
    @Body() dto: ReviewDecisionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reviewService.approveReview(
      taskId,
      user.userId,
      user.realName ?? user.username,
      dto.reviewComment,
    );
  }

  /** Reject review -> return the document to Draft so the author can edit and resubmit. */
  @Post('reviews/tasks/:taskId/reject')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  @RequirePermission(PermissionCode.documentReview)
  rejectReview(
    @Param('taskId') taskId: string,
    @Body() dto: ReviewDecisionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reviewService.rejectReview(
      taskId,
      dto.reviewComment ?? '',
      user.userId,
      user.realName ?? user.username,
    );
  }

  /** Get document details, including content. */
  @Get(':id')
  @RequirePermission(PermissionCode.documentList)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentService.findOne(id, true, user);
  }

  /** Update a document. */
  @Patch(':id')
  @RequirePermission(PermissionCode.documentEdit)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentService.update(id, dto, user);
  }

  /** Soft-delete a document. */
  @Delete(':id')
  @RequirePermission(PermissionCode.documentDelete)
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentService.remove(id, user);
  }
}
