import { Controller, Get, Query } from '@nestjs/common';
import { GraphBuildService } from '../pipeline/graph-build.service';
import {
  GraphOverviewDto,
  GraphQueryDto,
  GraphSearchDto,
} from './dto/graph-query.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PermissionCode } from '../common/constants/permissions';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth-user.interface';
import { accessFromUser } from '../document/document-access';

@Controller('graph')
@RequirePermission(PermissionCode.search)
export class GraphController {
  constructor(private readonly graph: GraphBuildService) {}

  /** Overview of documents, entities, tags, and statistics for the force graph. */
  @Get('overview')
  overview(@Query() query: GraphOverviewDto, @CurrentUser() user: AuthUser) {
    return this.graph.getOverview({
      keyword: query.keyword,
      entityType: query.entityType,
      from: query.from,
      to: query.to,
      docLimit: query.docLimit,
      scope: accessFromUser(user),
    });
  }

  /** Search entity, document, and chunk nodes by keyword. */
  @Get('search')
  search(@Query() query: GraphSearchDto, @CurrentUser() user: AuthUser) {
    return this.graph.searchGraph(
      query.keyword,
      query.limit ?? 50,
      accessFromUser(user),
    );
  }

  /** Knowledge entity nodes. */
  @Get('nodes')
  listNodes(@Query() query: GraphQueryDto, @CurrentUser() user: AuthUser) {
    return this.graph.listNodes(
      query.type,
      query.limit ?? 200,
      accessFromUser(user),
    );
  }

  /** RELATED_TO edges between entities. */
  @Get('edges')
  listEdges(@Query() query: GraphQueryDto, @CurrentUser() user: AuthUser) {
    return this.graph.listEdges(query.limit ?? 500, accessFromUser(user));
  }
}
