/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { MahjongGameRecordsRepository } from '@/models/_.js';
import type { MiMahjongGameRecord } from '@/models/MahjongGameRecord.js';
import { awaitAll } from '@/misc/prelude/await-all.js';
import type { Packed } from '@/misc/json-schema.js';
import { bindThis } from '@/decorators.js';
import { UserEntityService } from './UserEntityService.js';

const seatIndexes = [1, 2, 3, 4] as const;

type SeatIdKey = `user${1 | 2 | 3 | 4}Id`;

function assertMatchLength(value: string): value is Packed<'MahjongGameRecord'>['matchLength'] {
	return value === 'single' || value === 'east' || value === 'south';
}

function assertEndReason(value: string): value is Packed<'MahjongGameRecord'>['endReason'] {
	return value === 'normal' || value === 'tobi';
}

@Injectable()
export class MahjongGameRecordEntityService {
	constructor(
		@Inject(DI.mahjongGameRecordsRepository)
		private mahjongGameRecordsRepository: MahjongGameRecordsRepository,

		private userEntityService: UserEntityService,
	) {
	}

	@bindThis
	public async pack(
		src: MiMahjongGameRecord['id'] | MiMahjongGameRecord,
		hint?: {
			packedUsers?: Map<string, Packed<'UserLite'>>;
		},
	): Promise<Packed<'MahjongGameRecord'>> {
		const record = typeof src === 'object' ? src : await this.mahjongGameRecordsRepository.findOneByOrFail({ id: src });

		const users = new Map<string, Packed<'UserLite'>>();
		const userIds = seatIndexes
			.map(slot => record[`user${slot}Id` as SeatIdKey])
			.filter((id): id is string => id != null);
		if (userIds.length > 0) {
			const packed = await this.userEntityService.packMany(userIds);
			for (const user of packed) {
				users.set(user.id, user);
			}
		}
		if (hint?.packedUsers != null) {
			for (const [id, user] of hint.packedUsers) {
				if (!users.has(id)) users.set(id, user);
			}
		}

		const packSeat = (slot: typeof seatIndexes[number]): Packed<'UserLite'> | null => {
			const id = record[`user${slot}Id` as SeatIdKey];
			return id != null ? users.get(id) ?? null : null;
		};

		return await awaitAll({
			id: record.id,
			startedAt: record.startedAt.toISOString(),
			endedAt: record.endedAt.toISOString(),
			matchLength: assertMatchLength(record.matchLength) ? record.matchLength : 'south',
			endReason: assertEndReason(record.endReason) ? record.endReason : 'normal',
			timeLimitForEachTurn: record.timeLimitForEachTurn,
			user1Id: record.user1Id,
			user1: packSeat(1),
			user1Ai: record.user1Ai,
			user1Points: record.user1Points,
			user1Rank: record.user1Rank,
			user2Id: record.user2Id,
			user2: packSeat(2),
			user2Ai: record.user2Ai,
			user2Points: record.user2Points,
			user2Rank: record.user2Rank,
			user3Id: record.user3Id,
			user3: packSeat(3),
			user3Ai: record.user3Ai,
			user3Points: record.user3Points,
			user3Rank: record.user3Rank,
			user4Id: record.user4Id,
			user4: packSeat(4),
			user4Ai: record.user4Ai,
			user4Points: record.user4Points,
			user4Rank: record.user4Rank,
		});
	}

	@bindThis
	public async packMany(records: MiMahjongGameRecord[]): Promise<Packed<'MahjongGameRecord'>[]> {
		const userIds = records.flatMap(record =>
			seatIndexes
				.map(slot => record[`user${slot}Id` as SeatIdKey])
				.filter((id): id is string => id != null),
		);
		const packedUsers = userIds.length > 0
			? new Map((await this.userEntityService.packMany(userIds)).map(u => [u.id, u]))
			: new Map<string, Packed<'UserLite'>>();
		return Promise.all(records.map(record => this.pack(record, { packedUsers })));
	}
}
