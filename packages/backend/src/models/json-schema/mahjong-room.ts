/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const packedMahjongRoomDetailedSchema = {
	type: 'object',
	properties: {
		id: {
			type: 'string',
			optional: false, nullable: false,
			format: 'id',
		},
		createdAt: {
			type: 'string',
			optional: false, nullable: false,
			format: 'date-time',
		},
		startedAt: {
			type: 'string',
			optional: false, nullable: true,
			format: 'date-time',
		},
		endedAt: {
			type: 'string',
			optional: false, nullable: true,
			format: 'date-time',
		},
		isStarted: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		isEnded: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user1Id: {
			type: 'string',
			optional: false, nullable: true,
			format: 'id',
		},
		user2Id: {
			type: 'string',
			optional: false, nullable: true,
			format: 'id',
		},
		user3Id: {
			type: 'string',
			optional: false, nullable: true,
			format: 'id',
		},
		user4Id: {
			type: 'string',
			optional: false, nullable: true,
			format: 'id',
		},
		user1: {
			type: 'object',
			optional: false, nullable: true,
			ref: 'UserLite',
		},
		user2: {
			type: 'object',
			optional: false, nullable: true,
			ref: 'UserLite',
		},
		user3: {
			type: 'object',
			optional: false, nullable: true,
			ref: 'UserLite',
		},
		user4: {
			type: 'object',
			optional: false, nullable: true,
			ref: 'UserLite',
		},
		user1Ai: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user2Ai: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user3Ai: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user4Ai: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user1Ready: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user2Ready: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user3Ready: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		user4Ready: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		timeLimitForEachTurn: {
			type: 'number',
			optional: false, nullable: false,
		},
		matchLength: {
			type: 'string',
			optional: false, nullable: false,
			enum: ['single', 'east', 'south'],
		},
		isInviteOnly: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		invitations: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'object',
				optional: false, nullable: false,
				properties: {
					userId: {
						type: 'string',
						optional: false, nullable: false,
						format: 'id',
					},
					inviterId: {
						type: 'string',
						optional: false, nullable: false,
						format: 'id',
					},
					user: {
						type: 'object',
						optional: false, nullable: true,
						ref: 'UserLite',
					},
				},
			},
		},
		gameState: {
			type: 'object',
			optional: false, nullable: true,
			additionalProperties: true,
		},
		timer: {
			type: 'object',
			optional: false, nullable: true,
			description: 'ページを開いた時点でサーバーが数えている残り時間。サーバーが手番待ち・鳴き待ちをしていないときは null。',
			properties: {
				mode: {
					type: 'string',
					optional: false, nullable: false,
					enum: ['turn', 'call'],
				},
				remainingMs: {
					type: 'number',
					optional: false, nullable: false,
					minimum: 0,
				},
			},
		},
	},
} as const;
