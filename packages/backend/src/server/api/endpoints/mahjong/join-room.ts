/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { MahjongService } from '@/core/MahjongService.js';
import { ApiError } from '../../error.js';

export const meta = {
	requireCredential: true,

	kind: 'write:account',

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: '370e42b0-2a67-4306-9328-51c5f568f110',
		},
		roomFull: {
			message: 'The room is full.',
			code: 'ROOM_FULL',
			id: 'c8e8b4f1-5b4f-4f0e-9a3e-2a8c0f0d0f11',
		},
		gameStarted: {
			message: 'The game has already started.',
			code: 'GAME_STARTED',
			id: '3f7d2b0a-1b4a-4f6e-8c1d-9e2a5b7c8d90',
		},
		notInvited: {
			message: 'You are not invited to this room.',
			code: 'NOT_INVITED',
			id: '4be8bfc2-acb5-46b4-b4b8-cb8c12050686',
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
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private mahjongService: MahjongService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const room = await this.mahjongService.getRoom(ps.roomId);

			if (room == null) {
				throw new ApiError(meta.errors.noSuchRoom);
			}

			if (room.isStarted && !this.mahjongService.isMember(room, me)) {
				throw new ApiError(meta.errors.gameStarted);
			}

			// 招待制のルームは、参加者と招待されたユーザーだけが参加できる
			if (room.isInviteOnly && !this.mahjongService.isMember(room, me) && !this.mahjongService.isInvited(room, me.id)) {
				throw new ApiError(meta.errors.notInvited);
			}

			const joined = await this.mahjongService.joinRoom(room.id, me);

			if (joined == null) {
				// チェック後にルーム状態が変わった競合は、満員と区別して返す
				const latest = await this.mahjongService.getRoom(room.id);

				if (latest == null) {
					throw new ApiError(meta.errors.noSuchRoom);
				}
				if (!this.mahjongService.isMember(latest, me)) {
					if (latest.isStarted) {
						throw new ApiError(meta.errors.gameStarted);
					}
					if (latest.isInviteOnly && !this.mahjongService.isInvited(latest, me.id)) {
						throw new ApiError(meta.errors.notInvited);
					}
				}
				throw new ApiError(meta.errors.roomFull);
			}

			return await this.mahjongService.packRoom(joined, me);
		});
	}
}
