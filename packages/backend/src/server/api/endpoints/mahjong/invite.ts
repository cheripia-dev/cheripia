/*
 * SPDX-FileCopyrightText: syuilo and misskey-project, cheripia team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ms from 'ms';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { MahjongService } from '@/core/MahjongService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { DI } from '@/di-symbols.js';
import type { UsersRepository } from '@/models/_.js';
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
			id: '71e02b04-cf1e-4d9d-b1a2-a3a15c4d8bf9',
		},
		noSuchUser: {
			message: 'No such user.',
			code: 'NO_SUCH_USER',
			id: 'd92cdb0e-2505-465b-a241-bba7b16ec914',
		},
		notMember: {
			message: 'You are not a member of this room.',
			code: 'NOT_MEMBER',
			id: 'fdf58ec7-3f6a-4d86-96fc-b5e4018fa7b8',
		},
		gameStarted: {
			message: 'The game has already started.',
			code: 'GAME_STARTED',
			id: '8c17327a-8f0e-4a2f-9c1e-27d84e149522',
		},
		roomFull: {
			message: 'The room is full.',
			code: 'ROOM_FULL',
			id: '50a1b834-c793-4d02-b3d2-38f132717a04',
		},
		notLocalUser: {
			message: 'Only local users can be invited.',
			code: 'NOT_LOCAL_USER',
			id: '016fe78d-0124-48fe-8839-0b6216b6d954',
		},
		cannotInvite: {
			message: 'You cannot invite this user.',
			code: 'CANNOT_INVITE',
			id: '68686436-464f-4d37-af79-b9e47e92eef4',
		},
		alreadyInvited: {
			message: 'This user has already been invited.',
			code: 'ALREADY_INVITED',
			id: '04be8748-ef3c-42d1-9f07-8559a1cf3419',
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
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private mahjongService: MahjongService,
		private userEntityService: UserEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const invitee = await this.usersRepository.findOneBy({ id: ps.userId });
			if (invitee == null) {
				throw new ApiError(meta.errors.noSuchUser);
			}
			// 麻雀はローカルユーザーしか参加できない
			if (!this.userEntityService.isLocalUser(invitee)) {
				throw new ApiError(meta.errors.notLocalUser);
			}
			if (invitee.isSuspended) {
				throw new ApiError(meta.errors.cannotInvite);
			}

			const result = await this.mahjongService.inviteUser(ps.roomId, me, invitee);

			if (!result.ok) {
				switch (result.reason) {
					case 'noSuchRoom': throw new ApiError(meta.errors.noSuchRoom);
					case 'notMember': throw new ApiError(meta.errors.notMember);
					case 'gameStarted': throw new ApiError(meta.errors.gameStarted);
					case 'roomFull': throw new ApiError(meta.errors.roomFull);
					case 'notLocalUser': throw new ApiError(meta.errors.notLocalUser);
					case 'alreadyInvited': throw new ApiError(meta.errors.alreadyInvited);
					default: throw new ApiError(meta.errors.cannotInvite);
				}
			}

			return await this.mahjongService.packRoom(result.room, me);
		});
	}
}
