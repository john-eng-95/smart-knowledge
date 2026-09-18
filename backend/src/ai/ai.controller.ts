import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AiChatService } from './ai-chat.service';
import { AiStreamService } from './ai-stream.service';
import { HybridRetrievalService } from './hybrid-retrieval.service';
import { ChatSessionService } from './chat-session.service';
import { ChatDto } from './dto/chat.dto';
import { ChatStreamDto } from './dto/chat-stream.dto';
import { RagSearchDto } from './dto/rag-search.dto';
import {
  CreateSessionDto,
  QuerySessionDto,
  UpdateSessionDto,
} from './dto/session.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PermissionCode } from '../common/constants/permissions';
import type { AuthUser } from '../auth/auth-user.interface';

@Controller()
export class AiController {
  constructor(
    private readonly aiChat: AiChatService,
    private readonly aiStream: AiStreamService,
    private readonly retrieval: HybridRetrievalService,
    private readonly sessions: ChatSessionService,
  ) {}

  /**
   * Hybrid RAG retrieval: keyword BM25 + vector kNN -> RRF -> rerank.
   * Does not call the LLM; returns matching kh_chunk records only.
   */
  @Post('rag/search')
  @RequirePermission(PermissionCode.search)
  search(@Body() dto: RagSearchDto, @CurrentUser() user: AuthUser) {
    return this.retrieval.retrieve(dto.query.trim(), dto.topK ?? 5, user);
  }

  /** Agentic RAG chat: grade retrieval, rewrite and retry when needed, then use web search for kb_then_web. */
  @Post('ai/chat')
  @RequirePermission(PermissionCode.search)
  chat(@Body() dto: ChatDto, @CurrentUser() user: AuthUser) {
    return this.aiChat.chat(dto.content, dto.topK ?? 5, user, dto.sessionId);
  }

  /**
   * Agentic RAG streaming response.
   * Agent loop: retrieve_knowledge -> grade -> rewrite_query -> retrieve again; use web_search only when still insufficient.
   */
  @Post('ai/chat/stream')
  @RequirePermission(PermissionCode.search)
  streamChat(
    @Body() dto: ChatStreamDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    return this.aiStream.streamChat(dto, user, res);
  }

  @Get('ai/sessions')
  @RequirePermission(PermissionCode.search)
  listSessions(@Query() query: QuerySessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.pageMine(user.userId, query);
  }

  @Post('ai/sessions')
  @RequirePermission(PermissionCode.search)
  createSession(@Body() dto: CreateSessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.create(user.userId, dto);
  }

  @Get('ai/sessions/:id/messages')
  @RequirePermission(PermissionCode.search)
  listMessages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sessions.listMessages(user.userId, id);
  }

  @Patch('ai/sessions/:id')
  @RequirePermission(PermissionCode.search)
  renameSession(
    @Param('id') id: string,
    @Body() dto: UpdateSessionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.rename(user.userId, id, dto);
  }

  @Delete('ai/sessions/:id')
  @RequirePermission(PermissionCode.search)
  removeSession(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sessions.remove(user.userId, id);
  }
}
