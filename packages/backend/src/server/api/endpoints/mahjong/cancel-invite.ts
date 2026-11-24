/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ms from 'ms';
import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { MahjongService } from '@/core/MahjongService.js';
import { ApiError } from '../../error.js';

export const meta = {
	requireCredential: true,

	kind: 'write:account',

	limit: {
		duration: ms('1minute'),
		max: 30,
	},

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: '59b67603-076a-4ea7-b043-1e2465443fca',
		},
		notMember: {
			message: 'You are not a member of this room.',
			code: 'NOT_MEMBER',
			id: '2c87f796-f33c-40db-9f76-8e593bd776ec',
		},
		gameStarted: {
			message: 'The game has already started.',
			code: 'GAME_STARTED',
			id: '2d581ee8-1168-45c6-8ad5-211b730c42f7',
		},
		noSuchInvitation: {
			message: 'There is no invitation to cancel.',
			code: 'NO_SUCH_INVITATION',
			id: '477f4dc1-115c-4d53-87d8-c21525fbb98f',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		ref: 'MahjongRoomDetailed',
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
		userId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId', 'userId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private mahjongService: MahjongService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const result = await this.mahjongService.cancelInvitation(ps.roomId, me, ps.userId);

			if (!result.ok) {
				switch (result.reason) {
					case 'noSuchRoom': throw new ApiError(meta.errors.noSuchRoom);
					case 'notMember': throw new ApiError(meta.errors.notMember);
					case 'gameStarted': throw new ApiError(meta.errors.gameStarted);
					default: throw new ApiError(meta.errors.noSuchInvitation);
				}
			}

			return await this.mahjongService.packRoom(result.room, me);
		});
	}
}
