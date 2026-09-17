import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id';
import { TeamEntity } from './entities/team.entity';
import { TeamMemberEntity } from './entities/team-member.entity';
import { UserEntity } from '../user/entities/user.entity';
import { CreateTeamDto, QueryTeamDto, UpdateTeamDto } from './dto/team.dto';

@Injectable()
export class TeamService {
  constructor(
    @InjectRepository(TeamEntity)
    private readonly teamRepo: Repository<TeamEntity>,
    @InjectRepository(TeamMemberEntity)
    private readonly memberRepo: Repository<TeamMemberEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  /**
   * Return team IDs accessible to the current user for AuthUser.teamIds and
   * document visibility. Sources are memberships and team leadership; deleted
   * teams are excluded.
   */
  async listAccessibleTeamIds(userId: string): Promise<string[]> {
    // A leader may not have a membership row, so query kh_team.leader_id separately.
    const [memberRows, led] = await Promise.all([
      this.memberRepo
        .createQueryBuilder('m')
        .select('m.team_id', 'teamId')
        .where('m.user_id = :userId', { userId })
        .getRawMany<{ teamId: string | number }>(),
      this.teamRepo.find({
        where: { leaderId: userId, deleted: false },
        select: ['id'],
      }),
    ]);
    // BIGINT values may be strings or numbers; normalize them before deduplication.
    const ids = [
      ...new Set([
        ...memberRows.map((row) => String(row.teamId)),
        ...led.map((row) => String(row.id)),
      ]),
    ];
    if (!ids.length) return [];
    // Memberships may point to deleted teams; filter again on kh_team.deleted = false.
    const teams = await this.teamRepo.find({
      where: { id: In(ids), deleted: false },
      select: ['id', 'teamName'],
    });
    return teams.map((row) => String(row.id));
  }

  async listMine(userId: string): Promise<TeamEntity[]> {
    const ids = await this.listAccessibleTeamIds(userId);
    if (!ids.length) return [];
    return this.teamRepo.find({
      where: { id: In(ids), deleted: false },
      order: { sort: 'ASC', createdAt: 'ASC' },
    });
  }

  async create(dto: CreateTeamDto) {
    const team = this.teamRepo.create({
      id: nextSnowflakeId(),
      teamName: dto.teamName,
      teamCode: dto.teamCode ?? null,
      description: dto.description ?? null,
      leaderId: dto.leaderId ?? null,
      parentId: dto.parentId ?? '0',
      sort: dto.sort ?? 0,
      status: dto.status ?? 1,
    });
    return this.teamRepo.save(team);
  }

  async update(id: string, dto: UpdateTeamDto) {
    const team = await this.findByIdOrThrow(id);
    if (dto.teamName !== undefined) team.teamName = dto.teamName;
    if (dto.teamCode !== undefined) team.teamCode = dto.teamCode;
    if (dto.description !== undefined) team.description = dto.description;
    if (dto.leaderId !== undefined) team.leaderId = dto.leaderId;
    if (dto.parentId !== undefined) {
      if (dto.parentId === id) {
        throw new BadRequestException('A team cannot be its own parent');
      }
      team.parentId = dto.parentId;
    }
    if (dto.sort !== undefined) team.sort = dto.sort;
    if (dto.status !== undefined) team.status = dto.status;
    return this.teamRepo.save(team);
  }

  async delete(id: string) {
    const team = await this.findByIdOrThrow(id);
    const childCount = await this.teamRepo.count({
      where: { parentId: id, deleted: false },
    });
    if (childCount > 0) {
      throw new BadRequestException(
        'Cannot delete a team that has child teams',
      );
    }
    team.deleted = true;
    await this.teamRepo.save(team);
    await this.memberRepo.delete({ teamId: id });
  }

  async getDetail(id: string) {
    const team = await this.findByIdOrThrow(id);
    const memberCount = await this.memberRepo.count({ where: { teamId: id } });
    return { ...team, memberCount };
  }

  async page(query: QueryTeamDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.teamRepo.createQueryBuilder('t').where('t.deleted = false');
    if (query.keyword?.trim()) {
      qb.andWhere('(t.team_name ILIKE :kw OR t.team_code ILIKE :kw)', {
        kw: `%${query.keyword.trim()}%`,
      });
    }
    if (query.status !== undefined) {
      qb.andWhere('t.status = :status', { status: query.status });
    }
    qb.orderBy('t.sort', 'ASC')
      .addOrderBy('t.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  async getTree(rootOnly = false) {
    const teams = await this.teamRepo.find({
      where: { deleted: false, status: 1 },
      order: { sort: 'ASC', createdAt: 'ASC' },
    });
    const build = (parentId: string): unknown[] =>
      teams
        .filter((t) => t.parentId === parentId)
        .map((t) => ({
          ...t,
          children: rootOnly ? [] : build(t.id),
        }));
    const rootNodes = teams.filter((t) => !t.parentId || t.parentId === '0');
    return rootOnly
      ? rootNodes
      : rootNodes.map((t) => ({
          ...t,
          children: build(t.id),
        }));
  }

  async addMembers(teamId: string, userIds: string[]) {
    await this.findByIdOrThrow(teamId);
    const users = await this.userRepo.find({
      where: { id: In(userIds), deleted: false },
    });
    if (users.length !== userIds.length) {
      throw new NotFoundException('Some users do not exist');
    }
    for (const userId of userIds) {
      const exists = await this.memberRepo.findOne({
        where: { teamId, userId },
      });
      if (exists) continue;
      await this.memberRepo.save(
        this.memberRepo.create({
          id: nextSnowflakeId(),
          teamId,
          userId,
          memberRole: 'member',
        }),
      );
    }
    return true;
  }

  async removeMembers(teamId: string, userIds: string[]) {
    await this.findByIdOrThrow(teamId);
    await this.memberRepo.delete({ teamId, userId: In(userIds) });
    return true;
  }

  async listMembers(teamId: string) {
    await this.findByIdOrThrow(teamId);
    return this.memberRepo
      .createQueryBuilder('m')
      .innerJoin(UserEntity, 'u', 'u.id = m.user_id')
      .where('m.team_id = :teamId', { teamId })
      .andWhere('u.deleted = false')
      .select([
        'm.user_id AS "userId"',
        'm.member_role AS "memberRole"',
        'u.username AS username',
        'u.real_name AS "realName"',
      ])
      .getRawMany();
  }

  private async findByIdOrThrow(id: string) {
    const team = await this.teamRepo.findOne({
      where: { id, deleted: false },
    });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }
}
