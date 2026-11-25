/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { MahjongGameRecordEntityService } from '@/core/entities/MahjongGameRecordEntityService.js';
import { DI } from '@/di-symbols.js';
import type { MahjongGameRecordsRepository } from '@/models/_.js';
import { QueryService } from '@/core/QueryService.js';

export const meta = {
	tags: [],
	requireCredential: false,

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'MahjongGameRecord',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
		my: { type: 'boolean', default: false },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.mahjongGameRecordsRepository)
		private mahjongGameRecordsRepository: MahjongGameRecordsRepository,

		private mahjongGameRecordEntityService: MahjongGameRecordEntityService,
		private queryService: QueryService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// 記録は終局時にのみ作られる。匿名での my 指定は自分自身の対局を持ち得ないため空で返す。
			if (ps.my && !me) {
				return [];
			}

			const query = this.queryService.makePaginationQuery(
				this.mahjongGameRecordsRepository.createQueryBuilder('record'),
				ps.sinceId, ps.untilId, ps.sinceDate, ps.untilDate,
			);

			// 自分の対局は参加者配列で絞り込む。
			if (ps.my && me) {
				query.andWhere(':userId = ANY(record.participantIds)', { userId: me.id });
			}

			const records = await query.take(ps.limit).getMany();

			return await this.mahjongGameRecordEntityService.packMany(records);
		});
	}
}
